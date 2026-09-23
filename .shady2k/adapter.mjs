#!/usr/bin/env node
// Tracker adapter: reads the br (beads_rust) JSONL export and prints the
// normalized input the shady2k-skills checks expect (see the skills' model.md).
//
//   adapter.mjs backlog [--at <git-rev>]     normalized backlog
//   adapter.mjs commits --message <file>      commit-link input for a pending message
//   adapter.mjs commits --range <a>..<b>      commit-link input for every commit in a range
//
// The export is .beads/issues.jsonl, which br rewrites on every write. With --at
// it is read from that revision instead, for baselines and honest ages.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT = '.beads/issues.jsonl';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Task links: one or more trailer lines "Task: <id>[, <id>...]".
export const TASK_LINE = /^Task:\s*(.+)$/gim;
export function taskIds(message) {
  const ids = [];
  for (const m of message.matchAll(TASK_LINE)) for (const id of m[1].split(/[\s,]+/)) if (id) ids.push(id);
  return ids;
}

function readExport(rev) {
  if (rev) {
    try { return git('show', `${rev}:${EXPORT}`); } catch { return ''; }
  }
  const path = join(ROOT, EXPORT);
  if (!existsSync(path)) throw new Error(`${EXPORT} not found: run \`br init\` or \`br sync --flush-only\``);
  return readFileSync(path, 'utf8');
}

const TYPES = { epic: 'epic', feature: 'epic', task: 'task', bug: 'bug', chore: 'chore' };
const STATUSES = { open: 'open', blocked: 'open', in_progress: 'active', deferred: 'deferred', closed: 'closed' };

// submitted / implemented are not br statuses: they are a label plus a comment
// whose first line is "submitted: <json>" or "implemented: <json>" carrying
// { "revision": "...", "evidence": "..." }. The latest such comment wins.
function recorded(issue, kind) {
  const hit = [...(issue.comments ?? [])].reverse().find((c) => (c.text ?? '').startsWith(`${kind}:`));
  if (!hit) return undefined;
  try { return JSON.parse(hit.text.slice(kind.length + 1).split('\n')[0]); } catch { return { revision: '', evidence: '' }; }
}

export function normalize(text, source) {
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.status !== 'tombstone');
  const issues = rows.map((r) => {
    const labels = [...(r.labels ?? [])];
    let status = STATUSES[r.status] ?? 'open';
    if (status !== 'closed' && status !== 'deferred') {
      if (labels.includes('implemented')) status = 'implemented';
      else if (labels.includes('submitted')) status = 'submitted';
    }
    const deps = r.dependencies ?? [];
    const out = {
      id: r.id,
      title: r.title,
      type: TYPES[r.issue_type] ?? 'other',
      status,
      labels: labels.filter((l) => l !== 'implemented' && l !== 'submitted'),
      parent: deps.find((d) => d.type === 'parent-child' && d.issue_id === r.id)?.depends_on_id ?? null,
      // Only gating edges; related / discovered-from are provenance, never prerequisites.
      blockedBy: deps.filter((d) => d.type === 'blocks' && d.issue_id === r.id).map((d) => d.depends_on_id),
      body: [r.description, r.acceptance_criteria].filter(Boolean).join('\n\n'),
      updatedAt: r.updated_at,
      createdAt: r.created_at,
      holder: r.assignee || null,
    };
    if (status === 'implemented') out.integration = recorded(r, 'implemented');
    if (status === 'submitted') out.delivery = recorded(r, 'submitted');
    return out;
  });
  return { generatedAt: new Date().toISOString(), source, issues };
}

function backlog(rev) {
  const where = rev ? `${EXPORT} @ ${rev}` : `${EXPORT} @ working tree`;
  return normalize(readExport(rev), `br ${where}`);
}

function commits(args) {
  const { issues } = backlog();
  const slim = issues.map(({ id, type, parent }) => ({ id, type, parent }));
  let list;
  if (args.message) {
    const msg = readFileSync(args.message, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
    list = [{ id: 'pending-message', taskIds: taskIds(msg) }];
  } else if (args.range) {
    const out = git('log', '--format=%H%x00%B%x1e', args.range);
    list = out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [id, body] = s.split('\0');
      return { id, taskIds: taskIds(body ?? '') };
    });
    if (!list.length) throw new Error(`no commits in range ${args.range}`);
  } else throw new Error('commits needs --message <file> or --range <a>..<b>');
  return { issues: slim, commits: list };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--at') args.at = rest[++i];
    else if (rest[i] === '--message') args.message = rest[++i];
    else if (rest[i] === '--range') args.range = rest[++i];
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (cmd === 'backlog') return backlog(args.at);
  if (cmd === 'commits') return commits(args);
  throw new Error('usage: adapter.mjs backlog [--at <rev>] | commits --message <file> | commits --range <a>..<b>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(main(), null, 2) + '\n');
  } catch (e) {
    console.error(`adapter: ${e.message}`);
    process.exit(2);
  }
}

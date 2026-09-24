#!/usr/bin/env node
// Document adapter and gate wrapper: exports the project's Markdown documents
// and tracker records into the JSON contract of checks/check-docs.mjs, picks the
// phase from what a commit actually changes, and says what green looks like.
// See .shady2k/integration.md, "Document gate", and the skills' documents.md.
//
//   documents.mjs check --phase <product|feature|acceptance|close> [--change <id>]
//                       [--candidate index|worktree|<rev>] [--target <rev>] [--json]
//   documents.mjs export  (same options)   the checker's inputs {model, policy, evidence}
//   documents.mjs commit --message <file>   the commit-msg entry point (staged files)
//   documents.mjs revision [--candidate …]  the revision evidence is recorded against
//
// Records level: evidence comes from tracker comments and is trusted, not verified.
import { readFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocuments, digest } from './checks/check-docs.mjs';
import { parseVision, parseMilestone, parseCapability } from './checks/document-format.mjs';
import { normalize, taskIds } from './adapter.mjs';

const ID = '[a-zA-Z0-9][a-zA-Z0-9_.:-]*';
const CAPABILITIES = 'docs/system/capabilities/';
const CHANGES = 'docs/changes/';
const TEMPLATE = 'the skills\' setup-shady2k-skills/templates/change.md';
const KINDS = ['behavior', 'no-behavior', 'supporting'];
// Not part of a revision: the tracker export (evidence lives there) and the
// current specs (their sync with the change is exactly what `close` replays).
const UNREVISIONED = ['.beads/', CAPABILITIES];

// Product code is what no document or process file is: the paths a commit must
// carry an admitted change for.
export function isProduct(path) {
  if (/^(docs|\.shady2k|\.beads|\.githooks)\//.test(path)) return false;
  if (!path.includes('/') && (path.endsWith('.md') || path.startsWith('.'))) return false;
  return true;
}

const git = (root, args, env) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env,
});

// A candidate tree: the index (what a commit will hold), the working tree, or a revision.
function source(root, where) {
  const entries = (text, pick) => text.split('\0').filter(Boolean).map(pick);
  if (where === 'index') {
    return {
      where,
      entries: () => entries(git(root, ['ls-files', '-s', '-z']), (e) => { const [meta, path] = e.split('\t'); return { hash: meta.split(' ')[1], path }; }),
      read: (p) => { try { return git(root, ['show', `:${p}`]); } catch { return null; } },
    };
  }
  if (where === 'worktree') {
    return {
      where,
      entries: () => {
        // A scratch index with every tracked and untracked (not ignored) file staged.
        const tmp = join(tmpdir(), `madarch-docs-index-${process.pid}-${Date.now()}`);
        const real = resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
        if (existsSync(real)) copyFileSync(real, tmp);
        try {
          git(root, ['add', '-A'], { GIT_INDEX_FILE: tmp });
          return entries(git(root, ['ls-files', '-s', '-z'], { GIT_INDEX_FILE: tmp }), (e) => { const [meta, path] = e.split('\t'); return { hash: meta.split(' ')[1], path }; });
        } finally { if (existsSync(tmp)) unlinkSync(tmp); }
      },
      read: (p) => existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null,
    };
  }
  let rev;
  try { rev = git(root, ['rev-parse', '--verify', `${where}^{commit}`]).trim(); } catch { throw new Error(`unknown revision: ${where}`); }
  return {
    where: rev,
    entries: () => entries(git(root, ['ls-tree', '-r', '-z', rev]), (e) => { const [meta, path] = e.split('\t'); return { hash: meta.split(' ')[2], path }; }),
    read: (p) => { try { return git(root, ['show', `${rev}:${p}`]); } catch { return null; } },
  };
}

// The revision evidence is recorded against: every checked input except the
// tracker export and the current specs, so recording evidence and syncing the
// specs at closure do not stale it, while any code, test or document edit does.
export function revisionOf(root, candidate = 'HEAD') {
  const lines = source(root, candidate).entries()
    .filter((e) => !UNREVISIONED.some((p) => e.path.startsWith(p)))
    .map((e) => `${e.hash} ${e.path}`).sort();
  return `content:${createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)}`;
}

// ---- change records -------------------------------------------------------

const SECTIONS = ['Intent', 'Out of scope', 'Rationale', 'Changes to requirements', 'Preserved contracts', 'Coverage',
  'Blocking questions', 'Design and decisions', 'Acceptance evidence', 'DONE WHEN'];
const none = (text) => /^none\.?$/i.test(text.trim()) || text.trim() === '';

function bullets(text, section, pattern) {
  if (none(text)) return [];
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    const m = l.match(pattern);
    if (!m) throw new Error(`${section}: expected "None." or bullet lines, got: ${l}`);
    return m;
  });
}

// Reads docs/changes/<id>/change.md as the template lays it out. Anything it
// cannot place exactly is an error, never a guess.
export function parseChange(text, dir) {
  const header = {}, sections = {};
  let title = '', active = null, fence = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const mark = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence || mark) {
      if (fence && mark && mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      else if (!fence) fence = mark[1];
      if (active) sections[active].push(raw);
      continue;
    }
    const h2 = raw.match(/^## (.+)$/);
    if (h2) {
      active = h2[1].trim();
      if (!SECTIONS.includes(active)) throw new Error(`unrecognized section: ${active} (allowed: ${SECTIONS.join(', ')})`);
      if (sections[active]) throw new Error(`duplicate section: ${active}`);
      sections[active] = [];
      continue;
    }
    if (active) { sections[active].push(raw); continue; }
    const h1 = raw.match(/^# (.+)$/);
    if (h1 && !title) { title = h1[1].trim(); continue; }
    const field = raw.match(/^(Change|Base|Tasks|Kind): (.*)$/);
    if (field && !header[field[1]]) { header[field[1]] = field[2].trim(); continue; }
    if (raw.trim()) throw new Error(`unrecognized line before the first section: ${raw}`);
  }
  if (fence) throw new Error('unclosed code fence');
  const s = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()]));
  for (const k of ['Change', 'Base', 'Tasks', 'Kind']) if (!header[k]) throw new Error(`missing header line "${k}: …"`);
  if (header.Change !== dir) throw new Error(`Change: ${header.Change} does not match its directory ${CHANGES}${dir}/`);
  if (!KINDS.includes(header.Kind)) throw new Error(`Kind: ${header.Kind} is not one of ${KINDS.join(', ')}`);
  const ref = new RegExp(`^- (${ID})/(${ID})(?::\\s*(.*))?$`);
  return {
    id: header.Change,
    title,
    base: header.Base,
    taskIds: header.Tasks.split(/[\s,]+/).filter(Boolean),
    kind: header.Kind,
    intent: s.Intent ?? '',
    outOfScope: s['Out of scope'] ?? '',
    rationale: s.Rationale ?? '',
    openQuestions: bullets(s['Blocking questions'] ?? '', 'Blocking questions', /^- (.+)$/).map((m) => m[1].trim()),
    preserves: bullets(s['Preserved contracts'] ?? '', 'Preserved contracts', ref).map((m) => ({ capability: m[1], requirement: m[2] })),
    coverage: bullets(s.Coverage ?? '', 'Coverage', ref).map((m) => ({
      capability: m[1], requirement: m[2], checks: (m[3] ?? '').split(/[\s,]+/).filter(Boolean),
    })),
  };
}

// Change id → the task ids its header names, read without parsing the whole record.
function changeIndex(src) {
  const ids = new Set(src.entries().map((e) => e.path).filter((p) => p.startsWith(CHANGES) && p.endsWith('/change.md'))
    .map((p) => p.slice(CHANGES.length, -'/change.md'.length)).filter((id) => !id.includes('/')));
  return [...ids].sort().map((id) => {
    const tasks = (src.read(`${CHANGES}${id}/change.md`) ?? '').match(/^Tasks: (.*)$/m)?.[1] ?? '';
    return { id, taskIds: tasks.split(/[\s,]+/).filter(Boolean) };
  });
}

// ---- export ---------------------------------------------------------------

// Settings are read from the candidate itself, so an unstaged or uncommitted
// edit cannot weaken the verdict on what is being checked.
function readJson(src, path) {
  const text = src.read(path);
  if (text === null) throw new Error(`${path} not found in ${src.where}`);
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path} in ${src.where}: ${e.message}`); }
}

function tracker(root) {
  const path = join(root, '.beads/issues.jsonl');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.status !== 'tombstone');
  const { issues } = normalize(text, 'br working tree');
  const parents = new Set(issues.map((i) => i.parent).filter(Boolean));
  return { rows, issues, tasks: issues.map((i) => ({ id: i.id, kind: i.type === 'epic' || parents.has(i.id) ? 'container' : 'leaf' })) };
}

const capabilityAt = (src, id) => {
  const text = src.read(`${CAPABILITIES}${id}.md`);
  if (text === null) return null;
  try { return parseCapability(text); } catch (e) { throw new Error(`${CAPABILITIES}${id}.md at ${src.where}: ${e.message}`); }
};

// Evidence at the records level: tracker comments on the change's tasks whose
// first line is "check: {id, status, reference, revision}" or
// "approval: {changeDigest, reference}". The latest receipt per check, across
// all the change's tasks, wins.
function evidenceFor(rows, change, revision, policy) {
  const approvals = [], receipts = [];
  const comments = rows.filter((x) => change.taskIds.includes(x.id))
    .flatMap((r) => (r.comments ?? []).map((c) => ({ r, c })))
    .sort((a, b) => String(a.c.created_at).localeCompare(String(b.c.created_at)));
  for (const { r, c } of comments) {
    const first = (c.text ?? '').split('\n')[0];
    const m = first.match(/^(check|approval):\s*(\{.*\})\s*$/);
    if (!m) continue;
    let v;
    try { v = JSON.parse(m[2]); } catch { throw new Error(`malformed ${m[1]} record on ${r.id}: ${first}`); }
    if (m[1] === 'approval') approvals.push({ changeDigest: String(v.changeDigest ?? ''), reference: String(v.reference ?? '') });
    else {
      if (typeof v.id !== 'string' || !['passed', 'failed', 'skipped', 'unsupported'].includes(v.status) || typeof v.revision !== 'string')
        throw new Error(`malformed check record on ${r.id} (needs id, status passed|failed|skipped|unsupported, reference, revision): ${first}`);
      receipts.push({ id: v.id, status: v.status, reference: String(v.reference ?? ''), revision: v.revision });
    }
  }
  const matching = receipts.filter((x) => x.revision === revision);
  const evidenceRevision = matching.length || !receipts.length ? revision : receipts.at(-1).revision;
  const latest = new Map();
  for (const x of receipts.filter((x) => x.revision === evidenceRevision)) latest.set(x.id, { id: x.id, status: x.status, reference: x.reference });
  return { schemaVersion: 1, revision: evidenceRevision, policyDigest: digest(policy), approvals, checks: [...latest.values()] };
}

// Builds the checker's inputs for one phase. The phase is the caller's
// transition, never the author's choice; `commit` picks it from staged files.
export function buildInputs(root, { phase, change: changeId = null, candidate = 'worktree', target = 'main' }) {
  const src = source(root, candidate);
  const config = readJson(src, '.shady2k/config.json');
  const documents = readJson(src, '.shady2k/documents.json');
  const { rows, tasks } = tracker(root);
  const milestone = config.currentMilestone;
  const project = {
    mode: documents.mode,
    vision: parseVision(src.read('docs/vision.md') ?? ''),
    milestone: parseMilestone(src.read(`docs/milestones/${milestone}.md`) ?? '', milestone),
  };
  const revision = revisionOf(root, candidate);
  const stored = readJson(src, '.shady2k/document-policy.json');
  const model = { schemaVersion: 1, phase, revision, project, tasks, baseline: [], current: [], change: null };
  if (phase === 'product' && !changeId) return { model, policy: stored, evidence: null };
  if (!changeId) throw new Error(`the ${phase} phase needs --change <id>`);
  let tgt;
  try { tgt = source(root, target); } catch {
    throw new Error(`the target ${target} is not a revision here: the baseline is read from it. Create or update the local main line (git branch -f main origin/main), or pass --target <rev>`);
  }

  const text = src.read(`${CHANGES}${changeId}/change.md`);
  if (text === null) throw new Error(`${CHANGES}${changeId}/change.md not found in ${src.where}; start from ${TEMPLATE}`);
  const parsed = parseChange(text, changeId);
  const pinHint = `write the main-line commit the proposal was written against (git rev-parse main)`;
  if (!/^[0-9a-f]{7,40}$/.test(parsed.base)) throw new Error(`Base: ${parsed.base} in ${CHANGES}${changeId}/change.md must be a commit id, not a name that moves; ${pinHint}`);
  let base;
  try { base = source(root, parsed.base); } catch { throw new Error(`Base: ${parsed.base} in ${CHANGES}${changeId}/change.md is not a revision here; ${pinHint}`); }
  try { git(root, ['merge-base', '--is-ancestor', base.where, tgt.where]); } catch {
    throw new Error(`Base: ${parsed.base} in ${CHANGES}${changeId}/change.md is not on the target's history (${target}); ${pinHint}`);
  }

  // Proposed capabilities are complete files; deltas are what they change
  // relative to the pinned base, so a target that moved since is caught as stale.
  const proposalDir = `${CHANGES}${changeId}/capabilities/`;
  const proposals = src.entries().map((e) => e.path).filter((p) => p.startsWith(proposalDir) && p.endsWith('.md')).sort();
  const deltas = [], scope = new Set();
  for (const path of proposals) {
    const id = path.slice(proposalDir.length, -3);
    let proposed;
    try { proposed = parseCapability(src.read(path)); } catch (e) { throw new Error(`${path}: ${e.message}`); }
    if (proposed.id !== id) throw new Error(`${path}: Capability: ${proposed.id} does not match its file name`);
    scope.add(id);
    const before = new Map((capabilityAt(base, id)?.requirements ?? []).map((r) => [r.id, r]));
    const after = new Map(proposed.requirements.map((r) => [r.id, r]));
    for (const rid of [...new Set([...before.keys(), ...after.keys()])]) {
      const b = before.get(rid) ?? null, a = after.get(rid) ?? null;
      if (digest(b) !== digest(a)) deltas.push({ capability: id, requirement: rid, before: b, after: a });
    }
  }
  for (const p of parsed.preserves) scope.add(p.capability);
  const snapshot = (s) => [...scope].sort().map((id) => capabilityAt(s, id)).filter(Boolean);
  model.baseline = snapshot(tgt);
  model.current = snapshot(src);
  const { base: _pin, ...fields } = parsed;
  model.change = { ...fields, deltas };
  const policy = { ...stored, requireApproval: stored.requireApproval && (documents.approvalFor ?? KINDS).includes(parsed.kind) };
  return { model, policy, evidence: evidenceFor(rows, parsed, revision, policy), proposals: [...scope].sort() };
}

// ---- verdicts that describe green ------------------------------------------

const OWES = {
  behavior: 'at least one requirement delta (a complete proposed capability file under docs/changes/<id>/capabilities/), coverage naming checks for every changed requirement, and the owner\'s approval',
  'no-behavior': 'a rationale, preserved contracts ("- capability/requirement: why unchanged") with coverage for each, and no proposed capability files',
  supporting: 'a rationale and nothing else: no proposed capability files, preserved contracts or coverage; it may not carry product code or edit current specs',
};

export function runCheck(root, options) {
  const inputs = buildInputs(root, options);
  const { model, policy, evidence } = inputs;
  const violations = checkDocuments(model, policy, evidence);
  if (!violations.length) return { violations, text: `Document gate (${model.phase}): clean${model.change ? ` for change ${model.change.id}` : ''}` };
  const lines = [];
  const c = model.change;
  if (c) {
    const owed = policy.requiredChecks.filter((x) => !x.appliesTo || x.appliesTo.includes(c.kind)).map((x) => x.id);
    const covered = c.coverage.flatMap((x) => x.checks);
    lines.push(`Document gate (${model.phase}) refused change ${c.id}, kind ${c.kind}.`,
      `A ${c.kind} change owes ${OWES[c.kind]}.`,
      `Checks it owes: ${[...new Set([...owed, ...covered])].join(', ')}${policy.requireApproval ? '; plus the owner\'s approval' : ''}.`);
    for (const id of inputs.proposals) {
      const onTarget = source(root, options.target ?? 'main').read(`${CAPABILITIES}${id}.md`) !== null;
      lines.push(`Capability document: ${CAPABILITIES}${id}.md (${onTarget ? 'exists on the target' : 'absent on the target: this change adds it'}).`);
    }
  } else lines.push(`Document gate (${model.phase}) refused: the vision (docs/vision.md: Audience, Problem, Outcome, Exclusions) and the current charter (docs/milestones/${model.project.milestone.id}.md: Outcomes and acceptance, Exclusions) must be complete.`);
  lines.push('', ...violations.map((v) => `  ${v.id}: ${v.at}${v.why ? ` — ${v.why}` : ''}`));
  if (c && violations.some((v) => ['unproved-check', 'stale-evidence'].includes(v.id))) {
    const missing = violations.filter((v) => v.id === 'unproved-check').map((v) => v.at);
    const ids = missing.length ? missing : policy.requiredChecks.filter((x) => !x.appliesTo || x.appliesTo.includes(c.kind)).map((x) => x.id);
    lines.push('', `Record each check once it has passed on revision ${model.revision} (a later code edit makes a new revision):`);
    for (const id of ids) lines.push(`  br comments add ${c.taskIds[0]} 'check: ${JSON.stringify({ id, status: 'passed', reference: '<where its output is kept>', revision: model.revision })}' --actor <agent>`);
  }
  if (c && violations.some((v) => v.id === 'missing-approval')) {
    lines.push('', 'Record the owner\'s approval of what this change decides, with their words as the reference:',
      `  br comments add ${c.taskIds[0]} 'approval: ${JSON.stringify({ changeDigest: digest({ kind: c.kind, intent: c.intent, outOfScope: c.outOfScope, deltas: c.deltas, preserves: c.preserves }), reference: '<the owner\'s words and where>' })}' --actor <agent>`);
  }
  lines.push('', 'Guide: .shady2k/integration.md, "Document gate".');
  return { violations, text: lines.join('\n') };
}

// The commit-msg entry point: every commit gets the product phase; product code
// needs each linked task in a change that passes the feature phase (or an
// exemption inherited from an exempt ancestor); a current-spec edit needs the
// change that owns it to pass the close phase.
export function commitGate(root, message) {
  const staged = git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames']).split('\0').filter(Boolean);
  const ids = taskIds(message.split('\n').filter((l) => !l.startsWith('#')).join('\n'));
  const out = [];
  let ok = true;
  const refuse = (text) => { ok = false; out.push(text); };

  const product = runCheck(root, { phase: 'product', candidate: 'index' });
  if (product.violations.length) refuse(product.text);

  const code = staged.filter(isProduct);
  const specs = staged.filter((p) => p.startsWith(CAPABILITIES));
  for (const p of specs.filter((p) => !/^[^/]+\.md$/.test(p.slice(CAPABILITIES.length)))) {
    refuse(`Document gate refused this commit: ${p} is not a capability document. ${CAPABILITIES} holds only <capability>.md files written from the skills' capability template.`);
  }
  if (!code.length && !specs.length) return { ok, text: out.join('\n\n') };

  const documents = readJson(source(root, 'index'), '.shady2k/documents.json');
  const { issues } = tracker(root);
  const parent = new Map(issues.map((i) => [i.id, i.parent]));
  const exempt = (id) => { for (let x = id, n = 0; x && n < 100; x = parent.get(x), n++) if ((documents.exempt?.tasks ?? []).includes(x)) return true; return false; };
  const index = changeIndex(source(root, 'index'));
  const owning = (id) => index.filter((c) => c.taskIds.includes(id));
  const checked = new Set();
  const gate = (phase, changeId) => {
    if (checked.has(`${phase}:${changeId}`)) return;
    checked.add(`${phase}:${changeId}`);
    const r = runCheck(root, { phase, change: changeId, candidate: 'index' });
    if (r.violations.length) refuse(r.text);
  };

  if (code.length) {
    for (const id of ids) {
      if (exempt(id)) continue;
      const changes = owning(id);
      if (!changes.length) {
        refuse([`Document gate refused this commit: it carries product code (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', …' : ''}) for task ${id}, and no change record admits that task.`,
          'Product code lands with an admitted change: a behavior change (new or changed requirements) or a no-behavior change (a refactor or bug fix that keeps them).',
          `Write docs/changes/<change>/change.md from ${TEMPLATE}, with the lines`,
          '  Change: <change>   (the directory name)',
          '  Base: <git rev-parse main>',
          `  Tasks: ${id}`,
          '  Kind: behavior | no-behavior',
          'and, for behavior, complete proposed capability files in docs/changes/<change>/capabilities/<capability>.md.',
          'The gate reads what is staged: a change record that exists but is not staged is not seen.',
          'Then: node .shady2k/documents.mjs check --phase feature --change <change>',
          'Guide: .shady2k/integration.md, "Document gate".'].join('\n'));
        continue;
      }
      for (const c of changes) {
        const kind = (source(root, 'index').read(`${CHANGES}${c.id}/change.md`) ?? '').match(/^Kind: (.*)$/m)?.[1]?.trim();
        if (kind === 'supporting') {
          refuse(`Document gate refused this commit: task ${id} belongs to change ${c.id}, kind supporting, and the commit carries product code (${code.slice(0, 3).join(', ')}). A supporting change owes ${OWES.supporting}. Move the code to a task of a behavior or no-behavior change.`);
        } else gate('feature', c.id);
      }
    }
  }

  if (specs.length) {
    const linked = [...new Set(ids.flatMap((id) => owning(id).map((c) => c.id)))];
    const src = source(root, 'index');
    const owners = new Map();
    for (const c of linked) {
      for (const p of src.entries().map((e) => e.path).filter((p) => p.startsWith(`${CHANGES}${c}/capabilities/`) && p.endsWith('.md'))) {
        const cap = p.slice(`${CHANGES}${c}/capabilities/`.length, -3);
        owners.set(cap, [...(owners.get(cap) ?? []), c]);
      }
    }
    for (const path of specs) {
      const cap = path.slice(CAPABILITIES.length, -3);
      if (!owners.has(cap)) {
        refuse([`Document gate refused this commit: it edits the current spec ${path}, and no change linked by its tasks (${ids.join(', ') || 'none'}) proposes capability ${cap}.`,
          'Current specs change only at closure, by replaying an accepted change: link the commit to a task of that change,',
          `whose docs/changes/<change>/capabilities/${cap}.md holds the proposal, and run: node .shady2k/documents.mjs check --phase close --change <change>`].join('\n'));
      } else for (const c of owners.get(cap)) gate('close', c);
    }
  }
  return { ok, text: out.join('\n\n') };
}

// ---- command line -----------------------------------------------------------

function main(args) {
  const [cmd, ...rest] = args;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === '--json') { opts.json = true; continue; }
    if (!['--phase', '--change', '--candidate', '--target', '--message'].includes(k)) throw new Error(`unknown option ${k}`);
    const v = rest[++i];
    if (!v || v.startsWith('--')) throw new Error(`missing value for ${k}`);
    opts[k.slice(2)] = v;
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  if (cmd === 'commit') {
    if (!opts.message) throw new Error('commit needs --message <file>');
    const r = commitGate(root, readFileSync(opts.message, 'utf8'));
    if (r.text) console.log(r.text);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'revision') { console.log(revisionOf(root, opts.candidate ?? 'HEAD')); return 0; }
  if (cmd === 'check' || cmd === 'export') {
    if (!['product', 'feature', 'acceptance', 'close'].includes(opts.phase)) throw new Error('--phase must be product, feature, acceptance or close');
    // Acceptance judges a committed revision, the one its receipts are recorded against.
    const o = { phase: opts.phase, change: opts.change ?? null, candidate: opts.candidate ?? (opts.phase === 'acceptance' ? 'HEAD' : 'worktree'), target: opts.target ?? 'main' };
    if (cmd === 'export') {
      const { model, policy, evidence } = buildInputs(root, o);
      console.log(JSON.stringify({ model, policy, evidence }, null, 2));
      return 0;
    }
    const r = runCheck(root, o);
    console.log(opts.json ? JSON.stringify({ violations: r.violations }) : r.text);
    return r.violations.length ? 1 : 0;
  }
  throw new Error('usage: documents.mjs check|export --phase <phase> [--change <id>] [--candidate index|worktree|<rev>] [--target <rev>] | commit --message <file> | revision [--candidate <rev>]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error(`Document gate: invalid input: ${e.message}\nGuide: .shady2k/integration.md, "Document gate".`); process.exitCode = 2; }
}

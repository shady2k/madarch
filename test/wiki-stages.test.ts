import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readStagesIndex, stagesSourceDigest } from '../src/wiki/stages.js';
import { startServer, type StartedServer } from '../src/index.js';

/**
 * The SDLC stage index (docs/changes/wiki-sdlc/capabilities/product-wiki.md,
 * requirement `stages`): every stage of the set's life cycle in order, each
 * holding the artifacts the product really has — the set-form documents under
 * their folders, the Build stage's tasks read from the tracker's own export,
 * the acceptance, release and incident records from the places the skills
 * write — and, where a stage holds nothing, the skill that fills it. The
 * index never writes and never throws on a folder it can read: an export
 * that cannot be parsed is a problem named with its path, the rest stands.
 */

let folder: string | undefined;
let server: StartedServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  if (folder !== undefined) {
    rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  }
});

function thisFolder(): string {
  return folder!;
}

function draft(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-stages-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  return folder;
}

function write(path: string, content: string): void {
  const full = join(folder!, path);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

const CHILD = { id: 'proj-aa1', title: 'Write the reader', issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'proj-aa1', depends_on_id: 'proj-ep1', type: 'parent-child' }] } as const;
const CHILD_DONE = { id: 'proj-aa2', title: 'Ship the reader', issue_type: 'task', status: 'closed', dependencies: [{ issue_id: 'proj-aa2', depends_on_id: 'proj-ep1', type: 'parent-child' }] } as const;
const CHILD_PROGRESS = { id: 'proj-aa3', title: 'Review the reader', issue_type: 'task', status: 'in_progress', dependencies: [{ issue_id: 'proj-aa3', depends_on_id: 'proj-ep1', type: 'parent-child' }] } as const;
const EPIC = { id: 'proj-ep1', title: 'The reading feature', issue_type: 'epic', status: 'open', dependencies: [] as unknown[] } as const;
const ORPHAN = { id: 'proj-bb1', title: 'A task with no feature', issue_type: 'task', status: 'open', dependencies: [] as unknown[] } as const;
const GRANDCHILD = { id: 'proj-aa1.1', title: 'Split the reader', issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'proj-aa1.1', depends_on_id: 'proj-aa1', type: 'parent-child' }] } as const;

function tracker(lines: unknown[]): void {
  write('.beads/issues.jsonl', lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

describe('the stage index of a product', () => {
  test('every stage of the life cycle answers, in the set\'s order, an empty product all missing', () => {
    draft();
    const index = readStagesIndex(folder!);
    expect(index.stages.map((stage) => stage.id)).toEqual(['idea', 'requirements', 'design', 'build', 'verify', 'release', 'operate']);
    expect(index.stages.every((stage) => stage.empty)).toBe(true);
    // The skills the missing lines name: the set's own, one per stage.
    const skills = Object.fromEntries(index.stages.map((stage) => [stage.id, stage.missing.map((m) => m.skill)]));
    expect(skills['idea']).toContain('define-product');
    expect([...new Set(skills['requirements'])]).toEqual(['to-spec']);
    expect(skills['design']).toContain('to-design');
    expect([...new Set(skills['verify'])]).toEqual(['take-task']);
    expect([...new Set(skills['release'])]).toEqual(['ship-release']);
    expect([...new Set(skills['operate'])]).toEqual(['handle-incident']);
    expect([...new Set(skills['build'])]).toEqual(['take-task']);
    // The design stage of a model-less product also names the missing views.
    expect(skills['design']).toContain('write-intended-model');
    expect(index.problems).toEqual([]);
  });

  test('the set-form documents land on their stage with their page paths and identity titles', () => {
    draft();
    write('docs/vision.md', '# A cafe lists its leftovers\n\nWhy.\n');
    write('docs/sources/S-001-first-talk.md', '# S-001 — First talk\n\nKind: conversation\n');
    write('docs/hypotheses/H-001-fast.md', '# H-001 — Fast enough\n\nGrew from: VISION\n');
    write('docs/questions/Q-001-who.md', '# Q-001 — Who collects?\n\nConcerns: VISION\n');
    write('docs/stories/US-001-list.md', "# US-001 — List tonight's leftovers\n\nGrew from: H-001\n");
    write('docs/use-cases/UC-001-list.md', '# UC-001 — List leftovers\n\nServes: US-001\n');
    write('docs/requirements/FR-001-minute.md', '# FR-001 — Under a minute\n\nServes: UC-001\n');
    write('docs/decisions/0001-own-reader.md', '# Own the reader\n\n## Decision\nOwn it.\n');
    const index = readStagesIndex(folder!);
    const idea = index.stages.find((stage) => stage.id === 'idea')!;
    expect(idea.empty).toBe(false);
    expect(idea.artifacts.map((a) => a.path)).toEqual([
      'docs/hypotheses/H-001-fast.md',
      'docs/questions/Q-001-who.md',
      'docs/sources/S-001-first-talk.md',
      'docs/vision.md',
    ]);
    expect(idea.artifacts.find((a) => a.kind === 'vision')!.title).toBe('A cafe lists its leftovers');
    expect(idea.artifacts.find((a) => a.kind === 'source')!.title).toBe('First talk');
    const requirements = index.stages.find((stage) => stage.id === 'requirements')!;
    expect(requirements.artifacts.map((a) => a.kind)).toEqual(['product requirement', 'user story', 'use case']);
    expect(requirements.artifacts.find((a) => a.kind === 'product requirement')!.title).toBe('Under a minute');
    const design = index.stages.find((stage) => stage.id === 'design')!;
    expect(design.artifacts.map((a) => a.kind)).toEqual(['decision']);
    expect(design.artifacts[0]!.title).toBe('Own the reader');
    // The idea stage holds no prototype and no result in this product: the two missing kinds name the skill that writes them.
    expect(index.stages.find((stage) => stage.id === 'idea')!.missing.map((m) => m.kind)).toEqual(['prototype', 'result']);
    expect(index.stages.find((stage) => stage.id === 'idea')!.missing.every((m) => m.skill === 'define-product')).toBe(true);
    expect(index.stages.find((stage) => stage.id === 'requirements')!.missing).toEqual([]);
  });

  test('a design spec lands on the Design stage beside the decisions', () => {
    draft();
    write('docs/specs/2026-10-01-reading.md', '# The reading spec\n\n## Behaviour\nCalm.\n');
    write('docs/decisions/0001-own-reader.md', '# Own the reader\n');
    const design = readStagesIndex(folder!).stages.find((stage) => stage.id === 'design')!;
    expect(design.artifacts.map((a) => a.path)).toEqual(['docs/decisions/0001-own-reader.md', 'docs/specs/2026-10-01-reading.md']);
    expect(design.artifacts[1]!.kind).toBe('design spec');
    // The decisions and specs are both held; the product has no model, so the
    // views are still named as missing, with the skill that writes them.
    expect(design.missing).toEqual([{ kind: 'architecture views', skill: 'write-intended-model' }]);
  });

  test("the Build stage's tasks are read from the tracker export, grouped by feature, counts carried", () => {
    draft();
    tracker([CHILD, CHILD_DONE, CHILD_PROGRESS, EPIC, ORPHAN, GRANDCHILD]);
    const build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    expect(build.empty).toBe(false);
    expect(build.tasks).toHaveLength(2);
    const feature = build.tasks![0]!;
    expect(feature.id).toBe('proj-ep1');
    expect(feature.title).toBe('The reading feature');
    expect(feature.open).toBe(1);
    expect(feature.inProgress).toBe(1);
    expect(feature.done).toBe(1);
    expect(feature.tasks.map((task) => task.id)).toEqual(['proj-aa1', 'proj-aa2', 'proj-aa3']);
    const orphan = build.tasks![1]!;
    expect(orphan.id).toBe('none');
    // A grandchild hangs under a task, not an epic: it is grouped without a feature.
    expect(orphan.tasks.map((task) => task.id)).toEqual(['proj-aa1.1', 'proj-bb1']);
  });

  test('the features stand in code point order of their ids, the group without a feature last', () => {
    draft();
    const epicB = { id: 'proj-ep2', title: 'Later alphabetically', issue_type: 'epic', status: 'open', dependencies: [] as unknown[] };
    const childB = { id: 'proj-cc1', title: "Another feature's task", issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'proj-cc1', depends_on_id: 'proj-ep2', type: 'parent-child' }] };
    tracker([epicB, childB, EPIC, CHILD, ORPHAN]);
    const build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    expect(build.tasks!.map((feature) => feature.id)).toEqual(['proj-ep1', 'proj-ep2', 'none']);
  });

  test('epics are never listed as tasks, and edges that are not parent-child group nothing', () => {
    draft();
    const blocker = { id: 'proj-bb1', title: 'A blocker edge', issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'proj-bb1', depends_on_id: 'proj-ep1', type: 'blocks' }] };
    const related = { id: 'proj-bb2', title: 'A related edge', issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'proj-bb2', depends_on_id: 'proj-ep1', type: 'related' }] };
    tracker([blocker, related, EPIC]);
    const build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    // The edge types group nothing: the two tasks name no feature, so they
    // stand in the group without one, and the epic itself is never a task.
    expect(build.tasks).toHaveLength(1);
    expect(build.tasks![0]!.id).toBe('none');
    expect(build.tasks![0]!.tasks.map((task) => task.id)).toEqual(['proj-bb1', 'proj-bb2']);
  });

  test('a tracker export that exists but cannot be parsed is a problem naming the file and the line, the rest stands', () => {
    draft();
    write('.beads/issues.jsonl', '{"id": "proj-aa1"\nnot json at all\n\n[]\n');
    const index = readStagesIndex(folder!);
    const build = index.stages.find((stage) => stage.id === 'build')!;
    expect(build.tasks).toEqual([]);
    expect(index.problems).toHaveLength(1);
    expect(index.problems[0]!.where).toBe(join(folder!, '.beads', 'issues.jsonl'));
    expect(index.problems[0]!.message).toContain('line 1');
    expect(index.problems[0]!.message).toContain('line 2');
    expect(index.problems[0]!.message).toContain('line 4');
    expect(index.problems[0]!.message).toContain('; ');
  });

  test('an issue with no id, and a dependency edge that is not an object, are named and not served', () => {
    draft();
    write(
      '.beads/issues.jsonl',
      JSON.stringify({ title: 'No id here', issue_type: 'task', status: 'open', dependencies: [] }) + '\n' +
      JSON.stringify({ id: 'proj-aa1', title: 'Bad edge', issue_type: 'task', status: 'open', dependencies: ['not-an-edge', null, { issue_id: 'proj-aa1', depends_on_id: 7, type: 'parent-child' }] }) + '\n' +
      JSON.stringify(EPIC) + '\n' +
      JSON.stringify(CHILD) + '\n',
    );
    const index = readStagesIndex(folder!);
    expect(index.problems[0]!.message).toContain('line 1');
    const build = index.stages.find((stage) => stage.id === 'build')!;
    // A damaged export answers no groups at all: a smaller list would read as
    // the whole tracker. The problem line carries what could not be read.
    expect(build.tasks).toEqual([]);
  });

  test('a task with a status the stages do not group is left out AND surfaced at its line', () => {
    draft();
    tracker([{ id: 'proj-cc1', title: 'Deferred work', issue_type: 'task', status: 'deferred', dependencies: [] }]);
    const index = readStagesIndex(folder!);
    const build = index.stages.find((stage) => stage.id === 'build')!;
    expect(build.empty).toBe(true);
    // The export stands, so the empty table stays: the app names the tracker
    // as holding no task. The dropped row is surfaced at its full path and
    // line — it never disappears in silence.
    expect(build.tasks).toEqual([]);
    expect(build.notes).toHaveLength(1);
    expect(build.notes![0]!.where).toBe(join(folder!, '.beads', 'issues.jsonl'));
    expect(build.notes![0]!.line).toBe(1);
    expect(build.notes![0]!.message).toContain('deferred');
    // The missing line names take-task all the same.
    expect(build.missing.map((m) => m.skill)).toEqual(['take-task']);
  });

  test('a status the tracker spells differently is still a stage status', () => {
    draft();
    tracker([
      { id: 'proj-aa1', title: 'Done the other way', issue_type: 'task', status: 'done', dependencies: [{ issue_id: 'proj-aa1', depends_on_id: 'proj-ep1', type: 'parent-child' }] },
      EPIC,
    ]);
    const build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    expect(build.tasks![0]!.done).toBe(1);
    expect(build.tasks![0]!.open).toBe(0);
  });

  test("Verify reads the set's records folder; Release reads the change records and the first changelog", () => {
    draft();
    write('.shady2k/records/stage-one.md', 'accepted: {"base": "aaaa", "final": "bbbb"}\nCriteria hold.\n');
    write('.shady2k/records/stage-two.md', '# Stage two accepted\n\nFinal: 0e46cba2f5ab381f9732e93a9c0f47f89b53c878 in prose, the older form.\n');
    write('.shady2k/records/not-a-record.md', '# Just a note\n\nNothing accepted here.\n');
    const index = readStagesIndex(folder!);
    const verify = index.stages.find((stage) => stage.id === 'verify')!;
    expect(verify.artifacts.map((a) => a.path)).toEqual(['.shady2k/records/stage-one.md', '.shady2k/records/stage-two.md']);
    expect(verify.artifacts[0]!.kind).toBe('acceptance record');
    // Records outside the served pages are named, never linked.
    expect(verify.artifacts[0]!.served).toBe(false);
    expect(verify.missing).toEqual([]);
    // Unshipped change proposals are never presented as releases.
    const release = index.stages.find((stage) => stage.id === 'release')!;
    expect(release.artifacts).toEqual([]);
    expect(release.missing.map((m) => m.skill)).toEqual(['ship-release']);
    // Operate: the skills hold no incident folder; the stage says what fills it.
    const operate = index.stages.find((stage) => stage.id === 'operate')!;
    expect(operate.artifacts).toEqual([]);
    expect(operate.empty).toBe(true);
    expect(operate.missing.map((m) => m.skill)).toEqual(['handle-incident']);
  });

  test('the release notes are the FIRST changelog that exists, never both, and proposals are not releases', () => {
    draft();
    write('docs/changes/wiki-i18n/change.md', '# A proposal, not a release\n');
    write('CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\nEverything.\n');
    write('docs/CHANGELOG.md', '# Stale changelog\n');
    let release = readStagesIndex(folder!).stages.find((stage) => stage.id === 'release')!;
    expect(release.artifacts.map((a) => a.path)).toEqual(['CHANGELOG.md']);
    expect(release.artifacts[0]!.kind).toBe('release notes');
    expect(release.missing).toEqual([]);
    rmSync(join(folder!, 'CHANGELOG.md'));
    // The fallback: no root changelog, the docs one answers.
    release = readStagesIndex(folder!).stages.find((stage) => stage.id === 'release')!;
    expect(release.artifacts.map((a) => a.path)).toEqual(['docs/CHANGELOG.md']);
    // The change proposal never appears beside them, whatever the changelogs.
    expect(release.artifacts.map((a) => a.path)).not.toContain('docs/changes/wiki-i18n/change.md');
  });

  test('an unreadable changelog is a problem naming the file, and the stage still answers', () => {
    draft();
    mkdirSync(join(folder!, '.shady2k', 'records'), { recursive: true });
    const changelog = join(folder!, 'CHANGELOG.md');
    writeFileSync(changelog, '# Changelog\n');
    chmodSync(changelog, 0o000);
    const index = readStagesIndex(folder!);
    chmodSync(changelog, 0o644);
    expect(index.problems).toHaveLength(1);
    expect(index.problems[0]!.where).toBe(changelog);
    expect(index.problems[0]!.message).toContain('EACCES');
    expect(index.stages.find((stage) => stage.id === 'release')!.missing.map((m) => m.skill)).toEqual(['ship-release']);
  });

  test('an unreadable kind folder is a problem naming the folder, never a silently empty stage', () => {
    draft();
    const folder = join(thisFolder(), 'docs', 'hypotheses');
    mkdirSync(join(thisFolder(), 'docs', 'hypotheses'), { recursive: true });
    write('docs/hypotheses/H-001-fast.md', '# H-001 — Fast enough\n');
    chmodSync(folder, 0o000);
    const index = readStagesIndex(thisFolder());
    chmodSync(folder, 0o755);
    const idea = index.stages.find((stage) => stage.id === 'idea')!;
    expect(index.problems.some((p) => p.where === folder && p.message.includes('could not be read'))).toBe(true);
    expect(idea.artifacts).toEqual([]);
  });

  test('the other features\' sections are named where the product holds what they read, absent otherwise', () => {
    draft();
    const nothing = readStagesIndex(folder!);
    expect(nothing.stages.find((stage) => stage.id === 'design')!.sections).toEqual([]);
    expect(nothing.stages.find((stage) => stage.id === 'build')!.sections).toBeUndefined();
    mkdirSync(join(folder!, 'model'), { recursive: true });
    write('workspace.yaml', 'schemaVersion: 1\nid: demo\nname: Demo\nrepos:\n  - name: api\n    url: https://example.invalid/api.git\n');
    const held = readStagesIndex(folder!);
    expect(held.stages.find((stage) => stage.id === 'design')!.sections).toEqual([{ kind: 'architecture', present: true }]);
    expect(held.stages.find((stage) => stage.id === 'design')!.missing.map((m) => m.kind)).not.toContain('architecture views');
    expect(held.stages.find((stage) => stage.id === 'build')!.sections).toEqual([{ kind: 'repositories', present: true }]);
  });

  test('a cloned repos/ folder alone names the Repositories section, as a declared manifest alone does', () => {
    draft();
    mkdirSync(join(folder!, 'repos', 'api'), { recursive: true });
    let build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    expect(build.sections).toEqual([{ kind: 'repositories', present: true }]);
    // A manifest with no repos clause and no repos folder names nothing.
  });

  test('the stages answer over the server at /api/stages, read-only like every wiki route', () => {
    draft();
    tracker([CHILD, EPIC]);
    write('docs/vision.md', '# Vision\n\nWhat it is for.\n');
    const app = mkdtempSync(join(tmpdir(), 'madarch-stages-app-'));
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>');
    server = startServer({ productFolder: folder!, appFolder: app, port: 0, log: () => {}, errorLog: () => {} });
    return (async () => {
      const answer = await fetch(`${server!.url}/api/stages`);
      expect(answer.status).toBe(200);
      const body = (await answer.json()) as { stages: { id: string; artifacts: unknown[] }[] };
      expect(body.stages.map((stage) => stage.id)).toEqual(['idea', 'requirements', 'design', 'build', 'verify', 'release', 'operate']);
      expect(body.stages.find((stage) => stage.id === 'idea')!.artifacts).toHaveLength(1);
      const again = await fetch(`${server!.url}/api/stages`);
      expect(await again.text()).toBe(JSON.stringify(body));
    })();
  });

  test('a title inside a fence is not the artifact title, and a file with no heading takes the file name', () => {
    draft();
    write('docs/sources/S-001-notes.md', '```\n# Not a heading\n```\nplain text\n');
    write('docs/questions/Q-009.md', 'no heading at all\n');
    const idea = readStagesIndex(folder!).stages.find((stage) => stage.id === 'idea')!;
    expect(idea.artifacts.find((a) => a.path === 'docs/sources/S-001-notes.md')!.title).toBe('S-001-notes');
    expect(idea.artifacts.find((a) => a.path === 'docs/questions/Q-009.md')!.title).toBe('Q-009');
  });


  test('a prototype and a result land on the Idea stage from their folders, the vision file as itself', () => {
    draft();
    write('docs/prototypes/P-001-map.md', '# P-001 — A page on a map\n\nTests: H-001\n');
    write('docs/results/R-001-week.md', '# R-001 — The first week\n\nVerdict: confirmed.\n');
    write('docs/vision.md', '# The vision itself\n');
    const idea = readStagesIndex(folder!).stages.find((stage) => stage.id === 'idea')!;
    // Code point order of the paths: prototypes < results < vision.md.
    expect(idea.artifacts.map((a) => [a.path, a.kind])).toEqual([
      ['docs/prototypes/P-001-map.md', 'prototype'],
      ['docs/results/R-001-week.md', 'result'],
      ['docs/vision.md', 'vision'],
    ]);
  });

  test('a heading that merely names an id is not read as the identity line', () => {
    draft();
    write('docs/sources/S-001-talk.md', '# see FR-001 — fake title\n');
    const idea = readStagesIndex(folder!).stages.find((stage) => stage.id === 'idea')!;
    expect(idea.artifacts[0]!.title).toBe('see FR-001 — fake title');
  });

  test('an unreadable export and a non-UTF-8 export are problems naming the file, never empty groups in silence', () => {
    draft();
    mkdirSync(join(folder!, '.beads'), { recursive: true });
    const exportPath = join(folder!, '.beads', 'issues.jsonl');
    writeFileSync(exportPath, JSON.stringify(EPIC) + '\n');
    chmodSync(exportPath, 0o000);
    let index = readStagesIndex(folder!);
    chmodSync(exportPath, 0o644);
    expect(index.problems).toHaveLength(1);
    expect(index.problems[0]!.where).toBe(exportPath);
    expect(index.problems[0]!.message).toContain('could not be read');
    writeFileSync(exportPath, Buffer.from([0xff, 0xfe, 0x7b, 0x7d, 0x0a]));
    index = readStagesIndex(folder!);
    expect(index.problems[0]!.message).toContain('not UTF-8');
  });

  test('a parent edge naming a non-string id groups the task under no feature, never crashes the read', () => {
    draft();
    const badParent = { id: 'proj-dd1', title: 'A numeric parent', issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'proj-dd1', depends_on_id: 7, type: 'parent-child' }] };
    tracker([badParent, EPIC]);
    const build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    expect(build.tasks).toHaveLength(1);
    expect(build.tasks![0]!.id).toBe('none');
    expect(build.tasks![0]!.tasks.map((task) => task.id)).toEqual(['proj-dd1']);
  });

  test('a row that is an array or null is a problem line, and healthy rows around it are named as unread too', () => {
    draft();
    write('.beads/issues.jsonl', '[1, 2]\nnull\n');
    const index = readStagesIndex(folder!);
    expect(index.problems).toHaveLength(1);
    expect(index.problems[0]!.message).toContain('line 1');
    expect(index.problems[0]!.message).toContain('line 2');
  });

  test('an identity needs the spaced em dash: a cramped one leaves the whole heading as the title', () => {
    draft();
    write('docs/sources/S-002-cramped.md', '# S-002—Cramped dash\n');
    write('docs/sources/S-003-keep.md', '# S-003 — Kept title\n');
    const idea = readStagesIndex(folder!).stages.find((stage) => stage.id === 'idea')!;
    expect(idea.artifacts.find((a) => a.path === 'docs/sources/S-002-cramped.md')!.title).toBe('S-002—Cramped dash');
    expect(idea.artifacts.find((a) => a.path === 'docs/sources/S-003-keep.md')!.title).toBe('Kept title');
  });

  test('the group without a feature stands last even when its id would sort first', () => {
    draft();
    const zz = { id: 'zz-ep1', title: 'The only feature', issue_type: 'epic', status: 'open', dependencies: [] as unknown[] };
    const child = { id: 'zz-aa1', title: 'Its task', issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'zz-aa1', depends_on_id: 'zz-ep1', type: 'parent-child' }] };
    tracker([zz, child, ORPHAN]);
    const build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    expect(build.tasks!.map((feature) => feature.id)).toEqual(['zz-ep1', 'none']);
  });

  test('a stage input outside the pages moves the wiki revision: the stream reports it', () => {
    draft();
    tracker([CHILD, EPIC]);
    write('docs/vision.md', '# Vision\n');
    const app = mkdtempSync(join(tmpdir(), 'madarch-stages-app2-'));
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>');
    server = startServer({ productFolder: folder!, appFolder: app, port: 0, log: () => {}, errorLog: () => {} });
    return (async () => {
      const before = ((await (await fetch(`${server!.url}/api/pages`)).json()) as { revision: string }).revision;
      // A tracker write is a wiki change: the revision moves.
      tracker([CHILD, EPIC, { id: 'proj-aa4', title: 'One more task', issue_type: 'task', status: 'open', dependencies: [{ issue_id: 'proj-aa4', depends_on_id: 'proj-ep1', type: 'parent-child' }] }]);
      const after = ((await (await fetch(`${server!.url}/api/pages`)).json()) as { revision: string }).revision;
      expect(after).not.toBe(before);
      // An acceptance record is one too.
      const held = after;
      mkdirSync(join(folder!, '.shady2k', 'records'), { recursive: true });
      writeFileSync(join(folder!, '.shady2k', 'records', 'stage.md'), 'accepted: {"base": "a", "final": "b"}\n');
      const third = ((await (await fetch(`${server!.url}/api/pages`)).json()) as { revision: string }).revision;
      expect(third).not.toBe(held);
    })();
  });


  test('a repeated id keeps the first row and surfaces the later one', () => {
    draft();
    tracker([CHILD, { ...CHILD, title: 'The duplicate row' }]);
    const build = readStagesIndex(folder!).stages.find((stage) => stage.id === 'build')!;
    expect(build.tasks![0]!.tasks).toHaveLength(1);
    expect(build.notes).toHaveLength(1);
    expect(build.notes![0]!.line).toBe(2);
    expect(build.notes![0]!.message).toContain('already held');
  });

  test('an edit of the release notes moves the wiki revision: the stage page asks again', () => {
    draft();
    write('CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\nEverything.\n');
    const before = stagesSourceDigest(folder!);
    write('CHANGELOG.md', '# Changelog\n\n## 1.0.1\n\nMore.\n');
    expect(stagesSourceDigest(folder!)).not.toBe(before);
    // The docs spelling is an input too, once it exists.
    write('docs/CHANGELOG.md', '# Changelog\n');
    const withDocs = stagesSourceDigest(folder!);
    write('docs/CHANGELOG.md', '# Changelog\n\n## 2.0.0\n');
    expect(stagesSourceDigest(folder!)).not.toBe(withDocs);
    // A docs changelog whose root one is gone still moves it.
    rmSync(join(folder!, 'docs', 'CHANGELOG.md'));
    expect(stagesSourceDigest(folder!)).not.toBe(withDocs);
  });

  test("a described repository's derived documents land on their stages beside the product's own", () => {
    draft();
    write('docs/stories/US-001-own.md', "# US-001 — The product's own story\nGrew from: H-001\n");
    write('docs/repositories/library/stories/US-002-parse.md', '# US-002 derived from code — parse the model\nGrew from: H-001\n');
    write('docs/repositories/library/use-cases/UC-002-load.md', '# UC-002 derived from code — load a model\nServes: US-002\n');
    write('docs/repositories/library/requirements/FR-010-parse.md', '# FR-010 derived from code — parse in a second\nServes: UC-002\n');
    write('docs/repositories/library/decisions/0002-refine.md', '# Keep the ids the change does not concern\n');
    write('docs/repositories/library/architecture.md', "# The library's architecture\n\nViews and their links.\n");
    const index = readStagesIndex(folder!);
    const requirements = index.stages.find((stage) => stage.id === 'requirements')!;
    expect(requirements.artifacts.map((a) => a.path)).toEqual([
      'docs/repositories/library/requirements/FR-010-parse.md',
      'docs/repositories/library/stories/US-002-parse.md',
      'docs/repositories/library/use-cases/UC-002-load.md',
      'docs/stories/US-001-own.md',
    ]);
    expect(requirements.artifacts.every((a) => a.served)).toBe(true);
    expect(requirements.artifacts.find((a) => a.path === 'docs/repositories/library/stories/US-002-parse.md')!.title)
      .toBe('US-002 derived from code — parse the model');
    const design = index.stages.find((stage) => stage.id === 'design')!;
    expect(design.artifacts.map((a) => a.path)).toEqual([
      'docs/repositories/library/architecture.md',
      'docs/repositories/library/decisions/0002-refine.md',
    ]);
    expect(design.artifacts.find((a) => a.kind === 'repository architecture')).toBeDefined();
    expect(design.artifacts.find((a) => a.path === 'docs/repositories/library/decisions/0002-refine.md')!.kind).toBe('decision');
  });

  test('a repository subtree that cannot be read is a problem naming the folder, never silence', () => {
    draft();
    const repo = join(thisFolder(), 'docs', 'repositories', 'library', 'stories');
    mkdirSync(join(thisFolder(), 'docs', 'repositories', 'library', 'stories'), { recursive: true });
    write('docs/repositories/library/stories/US-009.md', '# US-009\n');
    chmodSync(join(thisFolder(), 'docs', 'repositories', 'library', 'stories'), 0o000);
    const index = readStagesIndex(thisFolder());
    chmodSync(join(thisFolder(), 'docs', 'repositories', 'library', 'stories'), 0o755);
    expect(index.problems.some((p) => p.where === repo && p.message.includes('could not be read'))).toBe(true);
  });

  test('a set-form document is counted by its id wherever it lives', () => {
    draft();
    write('docs/repositories/x/notes/FR-099-derived.md', '# FR-099 derived from code — anything it does\nServes: UC-001\n');
    write('docs/repositories/x/US-042-elsewhere.md', '# US-042 derived from code — another slice\nGrew from: H-001\n');
    write('docs/elsewhere/Q-003-unowned.md', '# Q-003 — Who owns this?\nConcerns: VISION\n');
    // A page with no identity line is nobody's artifact.
    write('docs/repositories/x/README.md', '# The library\n');
    const index = readStagesIndex(folder!);
    const requirements = index.stages.find((stage) => stage.id === 'requirements')!;
    expect(requirements.artifacts.map((a) => a.path)).toEqual([
      'docs/repositories/x/US-042-elsewhere.md',
      'docs/repositories/x/notes/FR-099-derived.md',
    ]);
    const idea = index.stages.find((stage) => stage.id === 'idea')!;
    expect(idea.artifacts.map((a) => a.path)).toEqual(['docs/elsewhere/Q-003-unowned.md']);
    expect(idea.artifacts[0]!.kind).toBe('open question');
  });

  test('reading the stages changes nothing in the product', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    tracker([CHILD, EPIC]);
    const before = readStagesIndex(folder!);
    const after = readStagesIndex(folder!);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

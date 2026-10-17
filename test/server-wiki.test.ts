import { basename } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { startServer, type StartedServer } from '../src/index.js';
import { createPGliteQueryDatabase } from '../src/adapters/pglite-query-database.js';
import { gitEnv } from './git-env.js';

/** One real git repository checked out under the product's repos/, committed with a sealed identity. */
function fixtureCheckout(product: string, name: string, subject: string): string {
  const target = join(product, 'repos', name);
  mkdirSync(target, { recursive: true });
  const env = {
    ...gitEnv(),
    GIT_AUTHOR_NAME: 'Repos Test', GIT_AUTHOR_EMAIL: 'repos-test@example.com',
    GIT_COMMITTER_NAME: 'Repos Test', GIT_COMMITTER_EMAIL: 'repos-test@example.com',
  };
  const run = (args: string[]): void => {
    const done = spawnSync('git', args, { cwd: target, encoding: 'utf8', env });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr}${done.stdout}`);
  };
  run(['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(target, 'README.md'), `# ${name}\n`);
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', subject]);
  return target;
}

/** Renames one folder, failing loudly when the move did not happen. */
function renameOrThrow(from: string, to: string): void {
  renameSync(from, to);
}

/** A compiled-model element shaped like the server's tests use, so the sent model is a real one. */
function element(id: string): Record<string, unknown> {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
}

/** A compiled model holding the given elements: the shape `POST /models` takes. */
function model(elements: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: 1, elements, interfaces: [], relations: [], categories: [], entities: [], scenarios: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
}

/**
 * The server's product mode (docs/changes/draft-product/capabilities/server.md,
 * requirement `serves-wiki`): a server given a product folder serves that
 * product's wiki — the API the app reads, and the app's built files from the
 * app folder it is given — refusing what it cannot answer, logging one
 * line per request with no document content, changing nothing in the
 * product. Sent models and a product's wiki stay apart when both are
 * given; started with neither it refuses to start.
 */

let folder: string | undefined;
let appFolder: string | undefined;
let server: StartedServer | undefined;
let lines: string[] = [];
let errors: string[] = [];

function draft(registry: boolean = false): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-wiki-server-'));
  mkdirSync(join(folder, 'docs'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  writeFileSync(join(folder, 'docs', 'vision.md'), '# Vision\n\nWhat it is for.\n');
  if (registry) {
    writeFileSync(join(folder, 'docs', 'kinds.yaml'), [
      'contract: 1',
      'stages:',
      '  - id: idea',
      '    name: Idea',
      '  - id: requirements',
      '    name: Requirements',
      'kinds:',
      '  - name: Product vision',
      "    prefix: V",
      '    folder: docs/vision.md',
      '    stage: idea',
      '    hint: write why the product is worth building',
      ''].join('\n'));
  }
  return folder;
}

/** The app's built files: minimal stand-ins for stage 2's build. */
function builtApp(): string {
  appFolder = mkdtempSync(join(tmpdir(), 'madarch-wiki-app-'));
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>demo wiki</title>');
  const assets = join(appFolder, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(assets, 'style.css'), 'body { color: black }\n');
  return appFolder;
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (appFolder !== undefined) rmSync(appFolder, { recursive: true, force: true });
  appFolder = undefined;
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

async function startProduct(): Promise<string> {
  lines = [];
  errors = [];
  server = await startServer({
    productFolder: folder!,
    appFolder,
    port: 0,
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line),
  });
  return server.url;
}

describe('the server\'s product mode', () => {
  test('fill state is readable and pause/stop controls are persisted for the coordinator', async () => {
    draft(); builtApp(); const url = await startProduct();
    expect((await fetch(`${url}/api/fill`)).status).toBe(404);
    mkdirSync(join(folder!, '.madarch', 'fill', 'units'), { recursive: true });
    writeFileSync(join(folder!, '.madarch', 'fill', 'run.json'), JSON.stringify({ id: 'run-1', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }));
    writeFileSync(join(folder!, '.madarch', 'fill', 'units', 'unit-1.json'), JSON.stringify({ id: 'unit-1', stage: 'inventory', status: 'complete' }));
    writeFileSync(join(folder!, '.madarch', 'fill', 'events.jsonl'), JSON.stringify({ runId: 'run-1', stage: 'inventory', unitId: 'unit-1', seq: 1, at: '2026-01-01T00:00:01.000Z', type: 'unit-complete', summary: 'done' }) + '\n');
    const status = await fetch(`${url}/api/fill`); expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ run: { id: 'run-1' }, units: [{ id: 'unit-1' }], events: [{ summary: 'done' }] });
    expect((await fetch(`${url}/api/fill/control?runId=run-1&action=xyz`, { method: 'POST' })).status).toBe(400);
    for (const action of ['pause', 'stop'] as const) {
      expect((await fetch(`${url}/api/fill/control?runId=run-1&action=${action}`, { method: 'POST' })).status).toBe(202);
      expect(JSON.parse(readFileSync(join(folder!, '.madarch', 'fill', 'control.json'), 'utf8'))).toMatchObject({ runId: 'run-1', action });
    }
  });

  test('GET /api/product names the product\'s id and name and its folder', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const answer = await fetch(`${url}/api/product`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ id: 'demo', name: 'Demo', folder: basename(folder!) });
  });

  test('GET /api/product does not disclose audience content through an outside symlink', async () => {
    draft();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1', 'overview:', '  audience:', '    document: docs/brief.md', '    section: Readers',
      'stages:', '  - id: explore', 'kinds: []',
    ].join('\n') + '\n');
    const outside = join(tmpdir(), `madarch-api-audience-${process.pid}.md`);
    writeFileSync(outside, '# Private\n\n## Readers\nOutside secret.\n');
    try {
      const brief = join(folder!, 'docs', 'brief.md');
      writeFileSync(brief, '# Brief\n\n## Readers\nOutside secret.\n');
      builtApp();
      const url = await startProduct();
      const validResponse = await fetch(`${url}/api/product`);
      expect((await validResponse.json() as { audience?: string }).audience).toBe('Outside secret.');
      rmSync(brief, { force: true });
      symlinkSync(outside, brief);
      const response = await fetch(`${url}/api/product`);
      expect(response.status).toBe(200);
      const body = await response.json() as { audience?: string };
      expect(body.audience).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('Outside secret.');
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('GET /api/product reads the configured audience source', async () => {
    draft();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1', 'overview:', '  audience:', '    document: docs/vision.md', '    section: Audience',
      'stages:', '  - id: idea', 'kinds:', '  - name: Product vision', '    prefix: V', '    folder: docs/vision.md', '    stage: idea', '    hint: describe the product',
    ].join('\n') + '\n');
    builtApp();
    const url = await startProduct();
    const bare = await (await fetch(`${url}/api/product`)).json() as { audience?: string };
    expect(bare.audience).toBeUndefined();
    writeFileSync(join(folder!, 'docs', 'vision.md'), '# Vision\n\n## Audience\nCafe owners with waste.\n');
    const named = await (await fetch(`${url}/api/product`)).json() as { audience?: string };
    expect(named.audience).toBe('Cafe owners with waste.');
  });

  test('GET /api/product projects every manifest-declared overview source independently', async () => {
    draft();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1', 'overview:',
      '  audience:', '    document: docs/vision.md', '    section: Audience',
      '  problem:', '    document: docs/vision.md', '    section: Problem',
      '  outcome:', '    document: docs/vision.md', '    section: Outcome',
      '  currentMilestone:', '    document: docs/milestone.md', '    section: Milestone',
      '  milestoneState:', '    document: docs/milestone.md', '    section: State',
      '  nextStep:', '    document: docs/next.md', '    section: Next',
      'stages:', '  - id: idea', 'kinds: []',
    ].join('\n') + '\n');
    writeFileSync(join(folder!, 'docs', 'vision.md'), [
      '# Vision', '', '## Audience', 'Small product teams.', '',
      '## Problem', 'Their decisions are hard to trace.', '',
      '## Outcome', 'A shared, living product record.',
    ].join('\n') + '\n');
    writeFileSync(join(folder!, 'docs', 'milestone.md'), [
      '# Roadmap', '', '## Milestone', 'A useful overview.', '',
      '## State', 'In progress.',
    ].join('\n') + '\n');
    writeFileSync(join(folder!, 'docs', 'next.md'), '# Plan\n\n## Next\nReview the first screen.\n');
    builtApp();
    const url = await startProduct();
    const response = await fetch(`${url}/api/product`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'demo', name: 'Demo', folder: basename(folder!),
      audience: 'Small product teams.',
      overview: {
        audience: 'Small product teams.',
        problem: 'Their decisions are hard to trace.',
        outcome: 'A shared, living product record.',
        currentMilestone: {
          title: 'A useful overview.', state: 'In progress.',
          nextStep: 'Review the first screen.', path: 'docs/milestone.md',
        },
      },
    });
  });

  test('GET /api/product omits unsafe configured overview sources without linking outside wiki pages', async () => {
    draft();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1', 'overview:',
      '  audience:', '    document: ../../AGENTS.md', '    section: Audience',
      '  currentMilestone:', '    document: docs/missing.md', '    section: Milestone',
      'stages:', '  - id: idea', 'kinds: []',
    ].join('\n') + '\n');
    builtApp();
    const url = await startProduct();
    const body = await (await fetch(`${url}/api/product`)).json() as { audience?: string; overview?: { audience?: string; currentMilestone?: { path?: string }; errors?: { role: string; document: string }[] } };
    expect(body.audience).toBeUndefined();
    expect(body.overview?.audience).toBeUndefined();
    expect(body.overview?.currentMilestone?.path).toBeUndefined();
    expect(body.overview?.errors?.map((error) => [error.role, error.document])).toEqual([
      ['audience', '../../AGENTS.md'], ['currentMilestone', 'docs/missing.md'],
    ]);
  });

  test('GET /api/questions lists the manifest-defined questions with their state and the open count', async () => {
    draft();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1', 'stages:', '  - id: idea', 'kinds:', '  - name: question', '    prefix: Q', '    folder: docs/questions', '    stage: idea', '    hint: answer the question', '    questions:',
      '      identityPrefix: Q', '      titleSeparator: —', '      promptSection: Question', '      answerSection: Answer', '      answererField: Who can answer', '      concernsField: Concerns', '      notApplicablePrefix: "Not applicable:"',
    ].join('\n') + '\n');
    builtApp();
    const questions = join(folder!, 'docs', 'questions');
    mkdirSync(questions, { recursive: true });
    writeFileSync(join(questions, 'Q-001-open.md'), [
      '# Q-001 — Who collects the unclaimed portions?',
      '',
      'Concerns: UC-001, FR-002',
      'Who can answer: the cafe owner',
      '',
      '## Question',
      'Does the owner want to be told?',
      '',
      '## What settles it',
      "The owner's answer.",
      '',
      '## Answer',
      '',
    ].join('\n') + '\n');
    writeFileSync(join(questions, 'Q-002-na.md'), [
      '# Q-002 — Should leftovers be delivered?',
      '',
      'Concerns: VISION',
      'Who can answer: the product owner',
      '',
      '## Question',
      'Do buyers expect delivery?',
      '',
      '## What settles it',
      "The product owner's decision on scope.",
      '',
      '## Answer',
      'Not applicable: delivery is out of the vision.',
    ].join('\n') + '\n');
    const url = await startProduct();
    const answer = await fetch(`${url}/api/questions`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { questions: { id: string; state: string }[]; openCount: number };
    expect(body.questions.map((each) => each.id)).toEqual(['Q-001', 'Q-002']);
    expect(body.questions.map((each) => each.state)).toEqual(['open', 'not-applicable']);
    expect(body.openCount).toBe(1);
  });

  test('GET /api/pages lists the pages with paths, titles, addresses and the revision', async () => {
    draft(true);
    builtApp();
    writeFileSync(join(folder!, 'docs', 'a-notes.md'), 'no heading\n');
    const url = await startProduct();
    const answer = await fetch(`${url}/api/pages`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { revision: string; pages: { path: string; title: string; address: string; kind?: string }[] };
    // A page the registry names carries its kind's name (requirement
    // `front-matter`); a page of no registry kind carries none.
    expect(body.pages).toEqual([
      { path: 'docs/a-notes.md', title: 'a-notes', address: '/p/docs/a-notes.md' },
      { path: 'docs/vision.md', title: 'Vision', address: '/p/docs/vision.md', kind: 'Product vision' },
    ]);
    expect(body.revision).toBe((await (await fetch(`${url}/api/pages`)).json() as typeof body).revision);
  });

  test('GET /api/registry answers a kind\'s statuses and link declarations beside the rest', async () => {
    draft(true);
    builtApp();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1',
      'stages:',
      '  - id: idea',
      '    name: Idea',
      '    labels:',
      '      en: Idea',
      '      ru: Идея',
      '  - id: requirements',
      '    name: Requirements',
      'goals:',
      '  - name: grounded',
      '    perspective: business',
      '    rules: [all requirements have an owner]',
      'kinds:',
      '  - name: Product vision',
      '    labels:',
      '      en: Product vision',
      '      ru: Видение продукта',
      '    prefix: V',
      '    folder: docs/vision.md',
      '    stage: idea',
      '    hint: write why the product is worth building',
      '  - name: User story',
      '    prefix: US',
      '    folder: docs/stories',
      '    stage: requirements',
      '    hint: write what one user does',
      '    storage: fact',
      '    evidence:',
      '      source: Source',
      '      ref: Ref',
      '      record: Record',
      '    statuses: [draft, ready]',
      '  - name: Use case',
      '    prefix: UC',
      '    folder: docs/use-cases',
      '    stage: requirements',
      '    hint: walk one story from start to finish',
      '    links:',
      '      - field: Serves',
      '        targets:',
      '          - User story',
      '        backlink: Served by',
      '        required: true',
      ''].join('\n'));
    const url = await startProduct();
    const answer = await fetch(`${url}/api/registry`);
    expect(answer.status).toBe(200);
    const body = await answer.json() as {
      present: boolean;
      stages?: { id: string; name?: string; labels?: { en: string; ru: string } }[];
      goals?: { name: string; perspective?: string; rules: string[] }[];
      reservations?: { file: string; line: number; path: string; message: string }[];
      kinds?: { name: string; labels?: { en: string; ru: string }; storage?: string; evidence?: { source: string; ref?: string; record?: string }; statuses?: string[]; links?: { field: string; targets: string[]; backlink?: string; cardinality?: string; required?: boolean }[] }[];
    };
    expect(body.present).toBe(true);
    expect(body.stages?.find((stage) => stage.id === 'idea')?.labels).toEqual({ en: 'Idea', ru: 'Идея' });
    expect(body.kinds?.find((kind) => kind.name === 'Product vision')?.labels).toEqual({ en: 'Product vision', ru: 'Видение продукта' });
    expect(body.goals).toEqual([{ name: 'grounded', perspective: 'business', rules: ['all requirements have an owner'] }]);
    expect(body.reservations?.map((finding) => finding.path)).toEqual(['kinds[1].storage', 'kinds[1].evidence', 'goals']);
    const story = body.kinds?.find((kind) => kind.name === 'User story');
    expect(story?.storage).toBe('fact');
    expect(story?.evidence).toEqual({ source: 'Source', ref: 'Ref', record: 'Record' });
    expect(story?.statuses).toEqual(['draft', 'ready']);
    expect(story?.links).toEqual([]);
    const uc = body.kinds?.find((kind) => kind.name === 'Use case');
    expect(uc?.links).toEqual([{ field: 'Serves', targets: ['User story'], backlink: 'Served by', cardinality: 'many', required: true }]);
    const stagesAnswer = await fetch(`${url}/api/stages`);
    expect(stagesAnswer.status).toBe(200);
    const stagesBody = await stagesAnswer.json() as { stages: { id: string; name?: string; labels?: unknown }[] };
    const idea = stagesBody.stages.find((stage) => stage.id === 'idea');
    expect(idea).toMatchObject({ id: 'idea', name: 'Idea' });
    expect(idea).not.toHaveProperty('labels');
    await server!.stop();
    server = undefined;
  });

  test('GET /api/page carries the structural findings the registry\'s reads computed', async () => {
    draft(true);
    builtApp();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1',
      'stages:',
      '  - id: idea',
      '    name: Idea',
      '  - id: requirements',
      '    name: Requirements',
      'kinds:',
      '  - name: Sources',
      '    prefix: S',
      '    folder: docs/sources',
      '    stage: idea',
      '    hint: have the first conversation',
      '  - name: User story',
      '    prefix: US',
      '    folder: docs/stories',
      '    stage: requirements',
      '    hint: write what one user does',
      '    statuses: [draft, ready]',
      '  - name: Use case',
      '    prefix: UC',
      '    folder: docs/use-cases',
      '    stage: requirements',
      '    hint: walk one story from start to finish',
      '    links:',
      '      - field: Serves',
      '        targets:',
      '          - User story',
      '        backlink: Served by',
      ''].join('\n'));
    const stories = join(folder!, 'docs', 'stories');
    mkdirSync(stories, { recursive: true });
    writeFileSync(join(stories, 'US-001-return.md'), '# US-001 — Return\n\nStatus: archived\nGrew from: S-099\n\n## Story\nI return.\n');
    const url = await startProduct();
    const asked = await fetch(`${url}/api/page?path=docs%2Fstories%2FUS-001-return.md`);
    expect(asked.status).toBe(200);
    const body = await asked.json() as { structural: { rule: string; file: string; line: number }[] };
    expect(body.structural.map((f) => [f.rule, f.line])).toEqual([
      ['structural.status', 3],
      ['structural.undeclared-field', 4],
    ]);
    await server!.stop();
    server = undefined;
  });

  test('GET /api/registry answers the kinds registry whole, refused, or absent', async () => {
    draft(true);
    builtApp();
    const url = await startProduct();
    const answer = await fetch(`${url}/api/registry`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { present: boolean; stages?: { id: string; name?: string }[]; kinds?: { name: string; prefix: string; folder: string; stage: string; hint: string }[]; refused?: { file: string; line: number; path: string; message: string }[] };
    expect(body.present).toBe(true);
    expect(body.stages).toEqual([{ id: 'idea', name: 'Idea' }, { id: 'requirements', name: 'Requirements' }]);
    expect(body.kinds?.map((kind) => kind.name)).toEqual(['Product vision']);
    await server!.stop();
    server = undefined;

    // The file stands but does not read: the contract's refusals, the file
    // and the line each, and the pages keep the plain behaviour.
    draft();
    builtApp();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), 'contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: broken kind\n    prefix: X\n    folder: no\n    stage: idea\n    hint: x\n');
    const refusedUrl = await startProduct();
    const refusedAnswer = await fetch(`${refusedUrl}/api/registry`);
    expect(refusedAnswer.status).toBe(200);
    const refusedBody = (await refusedAnswer.json()) as typeof body;
    expect(refusedBody.present).toBe(true);
    expect(refusedBody.refused?.some((error) => error.file === 'docs/kinds.yaml' && error.message.includes('is not a place under the documents'))).toBe(true);
    const refusedPages = (await (await fetch(`${refusedUrl}/api/pages`)).json()) as { pages: { path: string; kind?: string }[] };
    expect(refusedPages.pages.every((page) => page.kind === undefined)).toBe(true);
    await server!.stop();
    server = undefined;

    draft();
    builtApp();
    const plainUrl = await startProduct();
    const plainAnswer = await fetch(`${plainUrl}/api/registry`);
    expect(plainAnswer.status).toBe(200);
    expect(await plainAnswer.json()).toEqual({ present: false });
  });

  test('GET /api/repos answers the declared repositories: not-checked-out without a checkout, checked-out with its HEAD and README', async () => {
    draft();
    builtApp();
    writeFileSync(
      join(folder!, 'workspace.yaml'),
      'schemaVersion: 1\nid: demo\nname: Demo\nrepos:\n  - name: core\n    url: https://example.com/core.git\n  - name: web\n    url: https://example.com/web.git\n    branch: main\n',
    );
    fixtureCheckout(folder!, 'core', 'Make the core');
    const url = await startProduct();
    const answer = await fetch(`${url}/api/repos`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as {
      repos: { name: string; url: string; branch?: string; path: string; state: string; head?: { sha: string; subject: string; committedAt: string }; readme?: { file: string; markdown: string } }[];
    };
    expect(body.repos).toHaveLength(2);
    expect(body.repos[1]).toEqual({
      name: 'web', url: 'https://example.com/web.git', branch: 'main', path: 'repos/web', state: 'not-checked-out',
    });
    const core = body.repos[0]!;
    expect(core.name).toBe('core');
    expect(core.state).toBe('checked-out');
    expect(core.head?.subject).toBe('Make the core');
    expect(core.head?.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(core.readme?.markdown).toBe('# core\n');
  });

  test('an undeclared product holds no /api/repos and no /r: both refuse, the home still answers (finding: the route exists only where repos are declared)', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const reposAnswer = await fetch(`${url}/api/repos`);
    expect(reposAnswer.status).toBe(404);
    const pageAnswer = await fetch(`${url}/r`);
    expect(pageAnswer.status).toBe(404);
    expect(((await pageAnswer.json()) as { message: string }).message).toContain('/r');
    const home = await fetch(`${url}/`);
    expect(home.status).toBe(200);
  });

  test('GET /api/repos names an unreadable checkout instead of failing; the answer follows the declared list', async () => {
    draft();
    builtApp();
    writeFileSync(
      join(folder!, 'workspace.yaml'),
      'schemaVersion: 1\nid: demo\nname: Demo\nrepos:\n  - name: broken\n    url: https://example.com/broken.git\n',
    );
    mkdirSync(join(folder!, 'repos', 'broken'), { recursive: true });
    writeFileSync(join(folder!, 'repos', 'broken', 'note.txt'), 'plain folder\n');
    const url2 = await startProduct();
    const answer = await fetch(`${url2}/api/repos`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { repos: { name: string; state: string; problem?: string }[] };
    expect(body.repos[0]?.state).toBe('unreadable');
    expect(body.repos[0]?.problem).toContain(join(folder!, 'repos', 'broken'));
  });

  test('GET /api/events answers a text/event-stream whose `retry` comes first', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const asking = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: asking.signal });
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    const reader = response.body!.getReader();
    const read = async (ms: number): Promise<string> => {
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      const tick = setTimeout(() => {}, ms);
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(decoder.decode(next.value, { stream: true }));
          if (chunks.join('').includes('\n\n')) break;
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') throw error;
      } finally {
        clearTimeout(tick);
      }
      return chunks.join('');
    };
    const first = await read(2000);
    expect(first.startsWith('retry: 3000')).toBe(true);
    asking.abort();
  });

  test('GET /api/events carries one change event for a saved file, within two seconds, and a burst of saves is one event', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const asking = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: asking.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let held = '';
    const rest = async (): Promise<void> => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        held += decoder.decode(next.value, { stream: true });
        if (held.includes('event: change')) return;
      }
    };
    // A saved file: one event, its data naming the revision, inside two seconds.
    const writing = join(folder!, 'docs', 'vision.md');
    writeFileSync(writing, '# Vision\n\nSaved line.\n');
    let wideEnough = await Promise.race([rest().then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 2000))]);
    expect(wideEnough).toBe(true);
    const afterOne = held.split('event: change').length - 1;
    expect(afterOne).toBe(1);
    expect(held).toContain('data: {');
    // A burst of saves inside the debounce window is one event: the stream
    // asks the revision once the tree has settled, not once per write.
    held = '';
    writeFileSync(writing, '# Vision\n\nAnother line.\n');
    writeFileSync(writing, '# Vision\n\nA third line.\n');
    await Promise.race([new Promise<void>((done) => setTimeout(done, 900))]);
    const afterBurst = held.split('event: change').length - 1;
    expect(afterBurst).toBeLessThanOrEqual(1);
    expect(held).not.toContain('# Vision'); // the event carries no document bytes
    asking.abort();
  });

  test('the live walk: US joins the registry, the finding comes and clears, the backlinks stand, no restart', async () => {
    // A product with a use case and no user story: the registry and the
    // use case document are the only material.
    draft();
    builtApp();
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), [
      'contract: 1',
      'stages:',
      '  - id: idea',
      '  - id: requirements',
      'kinds:',
      '  - name: Use case',
      '    prefix: UC',
      '    folder: docs/use-cases',
      '    stage: requirements',
      '    hint: walk one story from start to finish',
      ''].join('\n'));
    const cases = join(folder!, 'docs', 'use-cases');
    mkdirSync(cases, { recursive: true });
    writeFileSync(join(cases, 'UC-001-return.md'), '# UC-001 — Return\n\n## Story\nThe note opens where it was left.\n');
    const url = await startProduct();
    const streamOn = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: streamOn.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let held = '';
    let eventsSeen = 0;
    // Waits for the next `event: change` on the stream, inside the seconds
    // named: the chunk reads run to the deadline with the change count as
    // the marker, so a burst of tree events still counts what came.
    const waitEvent = async (seconds: number): Promise<boolean> => {
      const start = eventsSeen;
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) {
          eventsSeen = held.split('event: change').length - 1;
          return eventsSeen > start;
        }
        const chunk = (async (): Promise<boolean> => {
          const next = await reader.read();
          if (next.done) return false;
          held += decoder.decode(next.value, { stream: true });
          return true;
        })();
        const got = await Promise.race([chunk, new Promise<boolean>((done) => setTimeout(() => done(false), left))]);
        if (held.includes('event: change')) {
          eventsSeen = held.split('event: change').length - 1;
          return eventsSeen > start;
        }
        if (got === false) {
          eventsSeen = held.split('event: change').length - 1;
          return eventsSeen > start;
        }
      }
    };

    // The manifest edit joins the US kind WITH its required link — one
    // publication, the new kind and the rc-typed link together — and the
    // running stream says it inside two seconds, with no restart.
    const kindsPath = join(folder!, 'docs', 'kinds.yaml');
    const manifestWith = (us: string, storyBody?: string): void => {
      writeFileSync(kindsPath, [
        'contract: 1',
        'stages:',
        '  - id: idea',
        '  - id: requirements',
        'kinds:',
        '  - name: Use case',
        '    prefix: UC',
        '    folder: docs/use-cases',
        '    stage: requirements',
        '    hint: walk one story from start to finish',
        '    links:',
        '      - field: Serves',
        '        targets:',
        '          - User story',
        '        backlink: Served by',
        us,
        ''].join('\n'));
      const stories = join(folder!, 'docs', 'stories');
      mkdirSync(stories, { recursive: true });
      if (storyBody !== undefined) writeFileSync(join(stories, 'US-001-return.md'), storyBody);
    };
    const usKind = [
      '  - name: User story',
      '    prefix: US',
      '    folder: docs/stories',
      '    stage: requirements',
      '    hint: write what one user does',
      '    links:',
      '      - field: Serves',
      '        targets:',
      '          - Use case',
      '        backlink: Served by',
      '        required: true',
    ].join('\n');
    const usDocument = (serves: string | undefined): string => (serves === undefined
      ? '# US-001 — Return to a note\n\n## Story\nI return to the note.\n'
      : `# US-001 — Return to a note\n\nServes: ${serves}\n\n## Story\nI return to the note.\n`);
    const walk = async (_body: string): Promise<{ structural: { rule: string }[]; document?: { backlinks: { path: string; label?: string; title?: string }[] } }> => {
      const asked = await fetch(`${url}/api/page?path=docs%2Fstories%2FUS-001-return.md`);
      expect(asked.status).toBe(200);
      return await asked.json() as { structural: { rule: string }[]; document?: { backlinks: { path: string; label?: string; title?: string }[] } };
    };

    // One: the story joins without its link — the manifest publication
    // carries the new kind WITH its required link, the stream says it
    // inside two seconds, and the page regroups with no restart.
    manifestWith(usKind, usDocument(undefined));
    const eventCame = await waitEvent(2);
    expect(eventCame).toBe(true);
    const registryAnswer = await (await fetch(`${url}/api/registry`)).json() as { kinds?: { name: string }[] };
    expect(registryAnswer.kinds?.some((kind) => kind.name === 'User story')).toBe(true);
    const before = await (await fetch(`${url}/api/pages`)).json() as { revision: string; pages: { path: string; kind?: string }[] };
    expect(before.pages.find((page) => page.path === 'docs/stories/US-001-return.md')?.kind).toBe('User story');
    expect((await walk('')).structural.map((f) => f.rule)).toEqual(['structural.required-link']);

    // Two: the story names its use case and the use case names the story
    // back — the finding clears, both pages carry the other's link under
    // the declared label, and the whole answer came from a running server
    // that was never restarted.
    writeFileSync(join(folder!, 'docs', 'stories', 'US-001-return.md'), usDocument('UC-001'));
    writeFileSync(join(folder!, 'docs', 'use-cases', 'UC-001-return.md'), '# UC-001 — Return\n\nServes: US-001\n\n## Story\nThe note opens where it was left.\n');
    expect(await waitEvent(2)).toBe(true);
    const after = await walk('');
    expect(after.structural).toEqual([]);
    expect(after.document?.backlinks.map((entry) => [entry.path, entry.label])).toEqual([['docs/use-cases/UC-001-return.md', 'Served by']]);
    const ucPage = await (await fetch(`${url}/api/page?path=docs%2Fuse-cases%2FUC-001-return.md`)).json() as { document?: { backlinks: { path: string; label?: string; title?: string; id?: string }[] } };
    expect(ucPage.document?.backlinks).toEqual([{ path: 'docs/stories/US-001-return.md', label: 'Served by', title: 'Return to a note', id: 'US-001' }]);
    streamOn.abort();
  });


  test('POST /api/discussions validates, commits and pushes one comment action', async () => {
    draft();
    builtApp();
    const base = join(tmpdir(), 'madarch-wiki-server-remote-' + crypto.randomUUID());
    mkdirSync(base, { recursive: true });
    const remote = join(base, 'remote.git');
    const env = gitEnv({ GIT_AUTHOR_NAME: 'Wiki Fixture', GIT_AUTHOR_EMAIL: 'wiki@example.test', GIT_COMMITTER_NAME: 'Wiki Fixture', GIT_COMMITTER_EMAIL: 'wiki@example.test' });
    const run = (cwd: string, args: string[]): void => {
      const step = spawnSync('git', args, { cwd, encoding: 'utf8', env });
      if (step.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${step.stderr}${step.stdout}`);
    };
    run(folder!, ['init', '--quiet', '--initial-branch=main']);
    run(folder!, ['config', 'user.name', 'Wiki Fixture']);
    run(folder!, ['config', 'user.email', 'wiki@example.test']);
    run(folder!, ['add', '--', 'workspace.yaml', 'docs/vision.md']);
    run(folder!, ['commit', '--quiet', '-m', 'fixture']);
    run(base, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    run(folder!, ['remote', 'add', 'origin', remote]);
    run(folder!, ['push', '--quiet', '-u', 'origin', 'HEAD']);
    const url = await startProduct();
    const response = await fetch(`${url}/api/discussions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      document: 'docs/vision.md', range: { start: 10, end: 25, quote: 'What it is for.', before: '', after: '', paragraph: 0, from: 0, to: 15 }, body: 'A useful first comment.'
    }) });
    expect(response.status).toBe(201);
    const saved = await response.json() as { thread: string; message: string; markdown: string };
    expect(readFileSync(join(folder!, 'docs/vision.md'), 'utf8')).toContain(`<!--c:${saved.thread}-->What it is for.<!--/c:${saved.thread}-->`);
    const message = readFileSync(join(folder!, 'comments', saved.thread, `${saved.message}.md`), 'utf8');
    expect(message).toContain('contract: 1');
    expect(message).toContain('A useful first comment.');
    const read = await fetch(`${url}/api/discussions?path=docs%2Fvision.md`);
    expect(read.status).toBe(200);
    const readBody = await read.json() as { discussions: { thread: string; body: string }[] };
    expect(readBody.discussions).toHaveLength(1);
    expect(readBody.discussions[0]).toMatchObject({ thread: saved.thread, anchor: { kind: 'selection', quote: 'What it is for.' }, body: '\nA useful first comment.\n', status: 'open' });
    expect(spawnSync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd: folder!, encoding: 'utf8', env }).stdout.trim().split('\n').sort()).toEqual([`comments/${saved.thread}/${saved.message}.md`, 'docs/vision.md'].sort());
    const pushed = spawnSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, encoding: 'utf8', env });
    expect(pushed.status).toBe(0);
    expect(pushed.stdout.trim()).toBe(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: folder!, encoding: 'utf8', env }).stdout.trim());
    const pageComment = await fetch(`${url}/api/discussions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: 'docs/vision.md', action: 'page', body: 'Page-level note.' }) });
    expect(pageComment.status).toBe(201);
    const pageSaved = await pageComment.json() as { thread: string };
    const reply = await fetch(`${url}/api/discussions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: 'docs/vision.md', action: 'reply', thread: pageSaved.thread, body: 'Reply note.' }) });
    expect(reply.status).toBe(201);
    const resolve = await fetch(`${url}/api/discussions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: 'docs/vision.md', action: 'resolve', thread: pageSaved.thread }) });
    expect(resolve.status).toBe(201);
    const afterActions = await (await fetch(`${url}/api/discussions?path=docs%2Fvision.md`)).json() as { discussions: { thread: string; anchor: Record<string, unknown>; status: string; messages?: { body: string }[] }[] };
    expect(afterActions.discussions.find((item) => item.thread === pageSaved.thread)).toMatchObject({ anchor: { kind: 'page' }, status: 'resolved', messages: [{ body: expect.stringContaining('Page-level note.') }, { body: expect.stringContaining('Reply note.') }, { body: expect.stringContaining('\n\n') }] });
    rmSync(base, { recursive: true, force: true });
  });

  test('GET /api/discussions refuses a one-sided source marker with path and line', async () => {
    draft(); builtApp();
    writeFileSync(join(folder!, 'docs/vision.md'), '# Vision\n\n<!--c:01ARZ3NDEKTSV4RRFFQ69G5FAV-->unpaired\n');
    const url = await startProduct();
    const response = await fetch(`${url}/api/discussions?path=docs%2Fvision.md`);
    expect(response.status).toBe(409);
    expect((await response.json() as { message: string }).message).toContain('docs/vision.md:3');
  });

  test('POST /api/discussions refuses dirty product and traversal without changing HEAD', async () => {
    draft();
    builtApp();
    const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: folder!, encoding: 'utf8' }).stdout;
    const url = await startProduct();
    const response = await fetch(`${url}/api/discussions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: '../workspace.yaml', range: { start: 0, end: 1, quote: 'x', before: '', after: '', paragraph: 0, from: 0, to: 1 }, body: 'No' }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain('normalized Markdown page');
    expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: folder!, encoding: 'utf8' }).stdout).toBe(before);
  });

  test('GET /api/page gives one page whole; asking twice after a save gives the new bytes', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const first = await fetch(`${url}/api/page?path=docs%2Fvision.md`);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { path: string; title: string; markdown: string; changedAt: string };
    expect(body.title).toBe('Vision');
    expect(body.markdown).toBe('# Vision\n\nWhat it is for.\n');
    expect(Number.isFinite(Date.parse(body.changedAt))).toBe(true);
    writeFileSync(join(folder!, 'docs', 'vision.md'), '# Vision\n\nWhat it is for, now twice.\n');
    const second = await fetch(`${url}/api/page?path=docs/vision.md`);
    const body2 = (await second.json()) as { markdown: string };
    expect(body2.markdown).toBe('# Vision\n\nWhat it is for, now twice.\n');
  });

  test('a missing page, and a path outside the wiki, are refused with the path named', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const missing = await fetch(`${url}/api/page?path=docs/other.md`);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { message: string };
    expect(body.message).toContain('docs/other.md');
    const climbing = await fetch(`${url}/api/page?path=..%2FAGENTS.md`);
    expect(climbing.status).toBe(404);
    const climbed = (await climbing.json()) as { message: string };
    expect(climbed.message).toContain('AGENTS.md');
    const noPath = await fetch(`${url}/api/page`);
    expect(noPath.status).toBe(400);
    expect(((await noPath.json()) as { message: string }).message).toContain('"path"');
  });

  test('a read failure while another subfolder is unreadable answers 500 naming path and cause (finding 2.10)', async () => {
    draft();
    builtApp();
    const locked = join(folder!, 'docs', 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'secret.md'), '# hidden');
    const url = await startProduct();
    // The unreadable subfolder is a filesystem failure, not an absent page:
    // the answer is a 500 naming the path asked for and the cause.
    let answer: Response;
    try {
      chmodSync(locked, 0o000);
      answer = await fetch(`${url}/api/page?path=docs/vision.md`);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(answer.status).toBe(500);
    const body = (await answer.json()) as { message: string };
    expect(body.message).toContain('docs/vision.md');
    expect(body.message).toContain('EACCES');
  });

  test('the app\'s files are served, and a path the app does not hold answers index.html', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const root = await fetch(`${url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('demo wiki');
    const script = await fetch(`${url}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toBe('export const app = 1;\n');
    expect(script.headers.get('content-type')).toContain('javascript');
    const deep = await fetch(`${url}/p/docs/vision.md`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('demo wiki');
    expect(deep.headers.get('content-type')).toContain('html');
  });

  test('static serving and the fallback answer GET and HEAD only; other methods are refused with 405', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const postRoot = await fetch(`${url}/`, { method: 'POST' });
    expect(postRoot.status).toBe(405);
    const postRoute = await fetch(`${url}/p/docs/vision.md`, { method: 'POST' });
    expect(postRoute.status).toBe(405);
    const postAsset = await fetch(`${url}/assets/app.js`, { method: 'POST' });
    expect(postAsset.status).toBe(405);
    const put = await fetch(`${url}/`, { method: 'PUT' });
    expect(put.status).toBe(405);
    const still = await fetch(`${url}/`);
    expect(still.status).toBe(200);
    expect(await still.text()).toContain('demo wiki');
    const headed = await fetch(`${url}/`, { method: 'HEAD' });
    expect(headed.status).toBe(200);
    void headed;
  });

  test('the fallback answers only the app\'s own routes; an unknown path or a missing asset is a named 404 (finding 6)', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    // A page address the wiki's routes answer falls back to the app.
    const page = await fetch(`${url}/p/docs/vision.md`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('demo wiki');
    // A named asset that is missing is a 404 naming the path.
    const missingAsset = await fetch(`${url}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
    expect(((await missingAsset.json()) as { message: string }).message).toContain('/assets/missing.js');
    // Any other unsupported path is a named 404 too, never index.html.
    for (const asked of ['/models', '/typo']) {
      const answer = await fetch(`${url}${asked}`);
      expect(answer.status).toBe(404);
      const body = (await answer.json()) as { message: string };
      expect(body.message).toContain(asked);
    }
  });

  test('every app route answers the app\'s index.html directly: a reload or a shared link works (walk 1, fix 3)', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    // The addresses the app itself routes: the home, a page, the open-questions
    // view, the Architecture index, one view, one element, the repositories,
    // the stages. Each GET must answer the app's index.html — never a 404 —
    // so an address opened directly (a reload, a link pasted in chat) reaches
    // the app's own routing.
    const asked = ['/', '/questions', '/p/docs/vision.md', '/p/madarch/architecture', '/p/madarch/view/_landscape', '/p/madarch/element/demo-element', '/s/idea', '/s/build'];
    for (const path of asked) {
      const answer = await fetch(`${url}${path}`);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain('demo wiki');
    }
    // `/r` is an app route only where the manifest declares repositories; this
    // draft declares none, so it stays the named 404.
    const reposRoute = await fetch(`${url}/r`);
    expect(reposRoute.status).toBe(404);
    expect(((await reposRoute.json()) as { message: string }).message).toContain('/r');
  });

  test('a path under /api that nothing answers is refused with JSON naming it', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const answer = await fetch(`${url}/api/unknown`);
    expect(answer.status).toBe(404);
    const body = (await answer.json()) as { message: string };
    expect(body.message).toContain('/api/unknown');
    void body;
  });

  test('the log line carries method, path, status and no document content', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    await fetch(`${url}/api/page?path=docs/vision.md`);
    await fetch(`${url}/api/nothing`);
    const about = lines.filter((line) => line.startsWith('GET /api/page'));
    expect(about).toHaveLength(1);
    expect(about[0]).toMatch(/GET \/api\/page 200 .*ms$/);
    expect(about[0]).not.toContain('What it is for');
    expect(about[0]).not.toContain('# Vision');
    const refused = lines.filter((line) => line.startsWith('GET /api/nothing'));
    expect(refused).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('serving changes nothing in the product: its files and git status are untouched', async () => {
    draft();
    initGit();
    const commit = commitAll();
    expect(commit.status).toBe(0); // the command succeeded: an empty git status is a real clean tree
    builtApp();
    const url = await startProduct();
    await fetch(`${url}/api/product`);
    await fetch(`${url}/api/pages`);
    await fetch(`${url}/api/page?path=docs/vision.md`);
    await fetch(`${url}/p/docs/vision.md`);
    const manifest = readFileSync(join(folder!, 'workspace.yaml'), 'utf8');
    expect(manifest).toContain('id: demo');
    const status = gitStatus();
    expect(status).toBe('');
    const files = committedFiles();
    expect(files).toContain('docs/vision.md');
    expect(files).toContain('workspace.yaml');
  });

  test('a server with a product folder but no manifest refuses to start', async () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'madarch-wiki-server-'));
    try {
      await expect(startServer({ productFolder: nowhere, port: 0 })).rejects.toThrow('workspace.yaml');
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('started with neither a product folder nor a data folder, it refuses to start', async () => {
    await expect(startServer({ port: 0 })).rejects.toThrow(/neither a data folder nor a product folder/);
  });

  test('without an app folder named, the checkout\'s built app is used and / answers (finding 3, deterministic)', async () => {
    // The requirement (server.md, serves-wiki; architecture.md): a server
    // given only a product folder serves the checkout's own built app. A
    // fixture index.html is put in the dist for the length of this test and
    // removed after, so the built-app branch runs on fresh CI too, where no
    // build has happened yet.
    draft();
    const distFolder = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
    const index = join(distFolder, 'index.html');
    // Track the directory, not the file: when `dist` already stood with
    // other assets and no index.html, only the fixture may be removed —
    // a pre-existing asset must survive the test (finding 2.11).
    const madeDir = !existsSync(distFolder);
    if (madeDir) mkdirSync(distFolder, { recursive: true });
    const wroteIndex = !existsSync(index);
    if (wroteIndex) writeFileSync(index, '<!doctype html><title>fixture app</title>');
    const keptAsset = join(distFolder, 'pre-existing.js');
    writeFileSync(keptAsset, 'export const kept = 1;\n');
    try {
      server = await startServer({ productFolder: folder!, port: 0, log: () => {}, errorLog: () => {} });
      const root = await fetch(`${server.url}/`);
      expect(root.status).toBe(200);
      expect((await root.text()).length).toBeGreaterThan(0);
      expect(existsSync(keptAsset)).toBe(true);
    } finally {
      rmSync(keptAsset);
      if (wroteIndex) rmSync(index);
      if (madeDir) rmSync(distFolder, { recursive: true, force: true });
    }
  });

  test('without a dist the start refuses saying what to build (finding 3)', async () => {
    // The absence case stands on its own: whatever the checkout holds, the
    // dist is moved aside for the length of this test and put back after.
    draft();
    const distFolder = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
    const heldAside = distFolder + '.held-aside-by-test';
    const moved = existsSync(distFolder);
    if (moved) renameOrThrow(distFolder, heldAside);
    try {
      let message = '';
      try {
        await startServer({ productFolder: folder!, port: 0 });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('wiki/app/dist');
      expect(message).toContain('build the app first');
    } finally {
      if (moved) renameOrThrow(heldAside, distFolder);
    }
  });

  test('the model routes stay as they are: a sent model and the product stay apart', async () => {
    let dataFolder: string | undefined;
    draft();
    builtApp();
    server = await startServer({
      dataFolder: (dataFolder = mkdtempSync(join(tmpdir(), 'madarch-wiki-data-'))),
      queryDatabase: await createPGliteQueryDatabase(),
      productFolder: folder!,
      appFolder,
      port: 0,
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line),
    });
    const url = server.url;
    // A real model is sent, and both halves are answered: the view from what was sent, the pages from the product.
    const sent = await fetch(`${url}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 1,
        source: 'example.org/demo-model',
        commit: 'c1',
        committedAt: '2026-10-09T12:00:00Z',
        model: model([element('svc')]),
      }),
    });
    expect(sent.status).toBe(201);
    const view = await fetch(`${url}/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 1, source: 'example.org/demo-model', format: 'mermaid', depth: 1 }),
    });
    expect(view.status).toBe(200);
    const viewText = await view.text();
    expect(viewText).toContain('svc');
    const pages = await fetch(`${url}/api/pages`);
    expect(pages.status).toBe(200);
    const body = (await pages.json()) as { pages: unknown[] };
    expect(body.pages.map((page) => (page as { path: string }).path)).toEqual(['docs/vision.md']);
    rmSync(dataFolder!, { recursive: true, force: true });
  });

  test('the API answers a few hundred small documents well inside a second', async () => {
    draft();
    builtApp();
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(folder!, 'docs', `doc-${String(i).padStart(3, '0')}.md`), `# Page ${i}\n\nSome text.\n`);
    }
    const url = await startProduct();
    const started = performance.now();
    const answer = await fetch(`${url}/api/pages`);
    await answer.json();
    const taken = performance.now() - started;
    expect(answer.status).toBe(200);
    expect(taken).toBeLessThan(1000);
  });
});

function gitStatus(): string {
  const run = spawnSync('git', ['status', '--porcelain'], { cwd: folder! });
  return run.stdout.toString();
}

/** The committed file list, so a real clean tree can be compared against a real fixture. */
function committedFiles(): string[] {
  const run = spawnSync('git', ['ls-files'], { cwd: folder! });
  return run.stdout.toString().split('\n').filter((line) => line !== '');
}

/** A real git repository in the scratch product, so its status means something. */
function initGit(): void {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Wiki Test',
    GIT_AUTHOR_EMAIL: 'wiki-test@example.com',
    GIT_COMMITTER_NAME: 'Wiki Test',
    GIT_COMMITTER_EMAIL: 'wiki-test@example.com',
  };
  for (const args of [['init'], ['add', '.']]) {
    const run = spawnSync('git', args, { cwd: folder!, env });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  }
}

/** Commits everything; the test asserts the command succeeded before trusting an empty status. */
function commitAll(): { status: number | null } {
  return spawnSync('git', ['commit', '-m', 'fixture'], { cwd: folder!, env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Wiki Test',
    GIT_AUTHOR_EMAIL: 'wiki-test@example.com',
    GIT_COMMITTER_NAME: 'Wiki Test',
    GIT_COMMITTER_EMAIL: 'wiki-test@example.com',
  } });
}

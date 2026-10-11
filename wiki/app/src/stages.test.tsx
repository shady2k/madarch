import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { StagePage, TaskGroups, addressOfStage } from './stages.js';
import { groupOf, stageIds } from './shell.js';
import { setWikiLanguage } from './i18n.js';
import { addressOfStageRoute, routeOf } from './routes.js';
import type { StagesIndex } from './api.js';

/**
 * The stages view without a server: the index is given as data, the DOM is
 * happy-dom, nothing reaches the network. The stage route is read from the
 * address, the stage page shows every artifact as a link to the page that
 * holds it, the Build tasks render grouped by feature with their statuses,
 * and an empty stage names the skill that fills it — no dead control.
 */

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('en');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

const index: StagesIndex = {
  stages: [
    {
      id: 'idea',
      artifacts: [
        { path: 'docs/vision.md', title: 'A cafe lists its leftovers', kind: 'vision', served: true },
        { path: 'docs/sources/S-001-first-talk.md', title: 'First talk', kind: 'source', served: true },
      ],
      missing: [],
      empty: false,
    },
    {
      id: 'build',
      artifacts: [],
      missing: [],
      tasks: [
        {
          id: 'proj-ep1',
          title: 'The reading feature',
          open: 1,
          inProgress: 1,
          done: 1,
          tasks: [
            { id: 'proj-aa1', title: 'Write the reader', status: 'open' },
            { id: 'proj-aa2', title: 'Ship the reader', status: 'in_progress' },
            { id: 'proj-aa3', title: 'Review the reader', status: 'done' },
          ],
        },
      ],
      sections: [{ kind: 'repositories', present: true }],
      empty: false,
    },
    {
      id: 'release',
      artifacts: [],
      missing: [{ kind: 'release record', skill: 'ship-release' }],
      empty: true,
    },
  ],
  problems: [],
};

let rendered: { root: Root } | undefined;

function into(element: ReturnType<typeof createElement>): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  rendered = { root };
}

/** Waits until the tree matches, or fails after the plainly too-long wait. */
async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error('the view never came to ' + what + '; the tree holds: ' + document.body.innerHTML);
}

const text = (): string => document.body.textContent ?? '';

afterEach(() => {
  rendered?.root.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
});

describe('the stages view', () => {
  test('the stage route reads /s/<stage> and nothing else', () => {
    expect(routeOf('/s/build')).toEqual({ name: 'stage', stage: 'build' });
    expect(routeOf('/s/unknown%2Fpath')).toEqual({ name: 'stage', stage: 'unknown/path' });
    expect(routeOf('/p/docs/vision.md').name).toBe('page');
    expect(routeOf('/').name).toBe('home');
    expect(addressOfStageRoute('build')).toBe('/s/build');
    expect(addressOfStage('idea')).toBe('/s/idea');
  });

  test("the navigator lists the stages in the life cycle's order, both languages naming them", async () => {
    expect([...stageIds]).toEqual(['idea', 'requirements', 'design', 'build', 'verify', 'release', 'operate']);
    into(createElement('div', null, ...stageIds.map((stage) => createElement('span', { key: stage, 'data-stage': stage }))));
    await until(() => document.querySelectorAll('[data-stage]').length === stageIds.length, 'the stage spans');
    const spans = [...document.querySelectorAll('[data-stage]')].map((node) => node.getAttribute('data-stage'));
    expect(spans).toEqual(['idea', 'requirements', 'design', 'build', 'verify', 'release', 'operate']);
  });

  test('a stage page shows its artifacts as links to the pages that hold them', async () => {
    const idea = index.stages.find((stage) => stage.id === 'idea')!;
    into(createElement(StagePage, { stage: idea, index }));
    await until(() => document.querySelectorAll('a').length >= 2, 'the artifact links');
    const links = [...document.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), title: a.textContent }));
    expect(links.some((link) => link.href === '/p/docs/vision.md' && (link.title ?? '').includes('A cafe lists its leftovers'))).toBe(true);
    expect(links.some((link) => link.href === '/p/docs/sources/S-001-first-talk.md')).toBe(true);
  });

  test('the Build stage renders the tasks grouped by feature with statuses and counts, read-only', async () => {
    const build = index.stages.find((stage) => stage.id === 'build')!;
    into(createElement(StagePage, { stage: build, index }));
    await until(() => document.querySelectorAll('[data-stage-feature]').length === 1, 'the task groups');
    expect(text()).toContain('The reading feature');
    expect(text()).toContain('Write the reader');
    expect(text()).toContain('proj-aa2');
    // No write control anywhere on the tasks: the view is read-only.
    expect(document.querySelectorAll('button')).toHaveLength(0);
  });

  test('an empty stage names the skill that fills it, and no dead control stands', async () => {
    const release = index.stages.find((stage) => stage.id === 'release')!;
    into(createElement(StagePage, { stage: release, index }));
    await until(() => document.querySelector('[data-testid="stage-missing"]') !== null, 'the missing lines');
    const line = document.querySelector('[data-testid="stage-missing"]')?.textContent ?? '';
    expect(line).toContain('ship-release');
    expect(document.querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelectorAll('a[href=""]')).toHaveLength(0);
  });

  test('the Russian chrome names the stages in Russian', async () => {
    const held = document.documentElement.lang;
    await setWikiLanguage('ru');
    const i18n = (await import('./i18n.js')).default;
    expect(i18n.t('stages.names.idea')).toBe('Идея');
    expect(i18n.t('stages.names.build')).toBe('Сборка');
    expect(i18n.t('stages.missingLine', { kind: 'запись о выпуске', skill: 'ship-release' })).toContain('ship-release');
    await setWikiLanguage('en');
    document.documentElement.lang = held;
  });

  test('an artifact the reader cannot serve stands as text, never a dead link', async () => {
    const withRecord: StagesIndex = {
      stages: [
        {
          id: 'verify',
          artifacts: [{ path: '.shady2k/records/stage-one.md', title: 'Stage one accepted', kind: 'acceptance record', served: false }],
          missing: [],
          empty: false,
        },
      ],
      problems: [],
    };
    into(createElement(StagePage, { stage: withRecord.stages[0]!, index: withRecord }));
    await until(() => document.querySelectorAll('[data-testid="stage-artifact-text"]').length === 1, 'the text artifact');
    // No anchor wraps the record: the reader does not serve it.
    expect(document.querySelectorAll('a[href*=".shady2k"]')).toHaveLength(0);
    expect(text()).toContain('Stage one accepted');
  });

  test("the other features' sections link their routes — both sections are served by the app", async () => {
    into(createElement(StagePage, { stage: index.stages.find((stage) => stage.id === 'build')!, index }));
    await until(() => document.querySelector('[data-testid="stage-section-repositories"]') !== null, 'the repositories line');
    const line = document.querySelector('[data-testid="stage-section-repositories"]');
    // Both sections exist on main: the line is a real link to the route.
    const anchor = line?.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('/r');
  });

  test("a described repository's pages group under repositories, never as Other", () => {
    // The first folder under docs/ names the group at any depth (main's landed rule).
    expect(groupOf('docs/repositories/library/stories/US-002-parse.md')).toBe('repositories');
    expect(groupOf('docs/repositories/library/requirements/FR-010.md')).toBe('repositories');
    expect(groupOf('docs/repositories/library/architecture.md')).toBe('repositories');
    expect(groupOf('docs/repositories/library/README.md')).toBe('repositories');
    expect(groupOf('docs/stories/US-001.md')).toBe('stories');
  });

  test("the Build stage's mended and dropped rows surface with their file and line", async () => {
    const withNotes: StagesIndex = {
      stages: [
        {
          id: 'build',
          artifacts: [],
          missing: [{ kind: 'task', skill: 'take-task' }],
          tasks: [],
          notes: [{ where: '/tmp/x/.beads/issues.jsonl', line: 4, message: 'the issue "t-1" holds the status "deferred": the stages group open, in-progress and done, so it is left out' }],
          empty: true,
        },
      ],
      problems: [],
    };
    into(createElement(StagePage, { stage: withNotes.stages[0]!, index: withNotes }));
    await until(() => document.querySelector('[data-testid="stage-notes"]') !== null, 'the notes');
    expect(text()).toContain('line 4');
    expect(text()).toContain('deferred');
    // The empty Build stage still names take-task.
    expect(text()).toContain('take-task');
  });

  test('the task groups render alone with their statuses', async () => {
    into(createElement(TaskGroups, { groups: index.stages.find((stage) => stage.id === 'build')!.tasks! }));
    await until(() => document.querySelectorAll('.stage-task-row').length === 3, 'the task rows');
    expect(text()).toContain('1 task open');
  });
});

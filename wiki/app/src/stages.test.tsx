import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { StagePage, TaskGroups, addressOfStage } from './stages.js';
import { stageIds } from './shell.js';
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
        { path: 'docs/vision.md', title: 'A cafe lists its leftovers', kind: 'vision' },
        { path: 'docs/sources/S-001-first-talk.md', title: 'First talk', kind: 'source' },
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

  test('the task groups render alone with their statuses', async () => {
    into(createElement(TaskGroups, { groups: index.stages.find((stage) => stage.id === 'build')!.tasks! }));
    await until(() => document.querySelectorAll('.stage-task-row').length === 3, 'the task rows');
    expect(text()).toContain('1 task open');
  });
});

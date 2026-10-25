import { expect, test } from 'bun:test';
import { adjacentKeys, requireHint, sameKeys } from '../scripts/diagram-plan.js';
import { diagramAcceptanceCases } from '../scripts/diagram-acceptance-cases.js';

test('fixed acceptance plan refuses missing, duplicate, unexpected and duplicate planned keys', () => {
  expect(() => sameKeys(['en', 'ru'], ['ru', 'en'], 'plan')).not.toThrow();
  expect(() => sameKeys(['en', 'ru'], ['en'], 'plan')).toThrow('missing ["ru"]');
  expect(() => sameKeys(['en', 'ru'], ['en', 'en', 'ru'], 'plan')).toThrow('duplicates 1');
  expect(() => sameKeys(['en', 'ru'], ['en', 'ru', 'other'], 'plan')).toThrow('unexpected ["other"]');
  expect(() => sameKeys(['en', 'en'], ['en'], 'plan')).toThrow('expected/actual 2/1');
});

for (const lang of ['en', 'ru']) test(`fixed rendered fixtures preserve all ER64 and forty-five-element facts (${lang})`, async () => {
  const cases = await diagramAcceptanceCases(lang);
  expect(cases.map(item => item.name)).toEqual(['case-er64', 'case-roots45', 'case-one-group45']);
  const er = cases[0]!.views[0]!;
  expect(er.renderers).toEqual(['mermaid']);
  expect(er.elements[0]!.columns).toHaveLength(64);
  expect(er.elements[0]!.href).not.toBeNull();
  expect(er.mermaidSource).toContain('uuid column_0 PK,FK');
  expect(er.mermaidSource).toContain('uuid column_63 FK');
  expect(er.edges.map(edge => edge.label)).toEqual(['column_0', 'column_63']);
  for (const item of cases.slice(1)) {
    const view = item.views[0]!;
    expect(view.elements).toHaveLength(40);
    expect(view.fullElements!.length).toBe(item.name === 'case-roots45' ? 45 : 46);
    expect(view.marker).not.toBeNull();
    if (item.name === 'case-one-group45') expect(view.fullEdges).toHaveLength(44);
  }
});


test('adjacent list identities reject duplicate or substituted members despite equal counts', () => {
  const expected = adjacentKeys({ spec: { type: 'deployment' }, elements: [{ id: 'shown' }], fullElements: [{ id: 'a' }, { id: 'b' }], edges: [] });
  expect(expected).toEqual(['a', 'b']);
  expect(() => sameKeys(expected, ['a', 'a'], 'members')).toThrow();
  expect(() => sameKeys(expected, ['a', 'other'], 'members')).toThrow();
  expect(adjacentKeys({ spec: { type: 'sequence' }, elements: [], edges: [{ step: 1, from: 'a', to: 'b', label: 'call', href: '/target' }] })).toEqual(['[1,"a","b","call","/target"]']);
});
test('a visible hint must match its actual matrix language, not merely contain text', () => {
  expect(() => requireHint('Read more', ' Read  more ', 'en')).not.toThrow();
  expect(() => requireHint('Читать дальше', 'Read more', 'ru')).toThrow('reading hint ru');
});


test('controller cancels only explicitly owned active requests and keeps unknown provisioners unknown', async () => {
  const child = Bun.spawn(['python3', 'scripts/diagram-acceptance-launch.py', '--request-classification-fixture'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(JSON.stringify([
    { request_id: 'ours', name: 'sky.launch', status: 'RUNNING', cluster_name: 'fixture-cluster' },
    { request_id: 'other', name: 'sky.launch', status: 'RUNNING', cluster_name: 'other-cluster' },
    { request_id: 'unknown', name: 'sky.launch', status: 'RUNNING', cluster_name: null },
    { request_id: 'finished', name: 'sky.launch', status: 'SUCCEEDED', cluster_name: 'fixture-cluster' },
  ]));
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual([['ours'], ['unknown']]);
});

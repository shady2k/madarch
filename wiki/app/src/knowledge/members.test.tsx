/**
 * A class page's members (madarch-m38l.21): one compact table, shared facts once,
 * each row a member with its name, the columns that differ, and short reader and
 * writer lists. The test is written against the block the server sends.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setWikiLanguage } from '../i18n.js';
import { BlockView } from './blocks.js';
import type { Block, EntityRef } from './types.js';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  await setWikiLanguage('ru');
});

afterAll(async () => {
  await new Promise((rest) => setTimeout(rest, 50));
  GlobalRegistrator.unregister();
});

let rendered: Root | undefined;
function into(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  rendered = createRoot(container);
  rendered.render(element);
  return container;
}
async function until(holds: () => boolean | undefined, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (holds()) return;
    await new Promise((step) => setTimeout(step, 10));
  }
  throw new Error(`never came to ${what}; the tree holds: ${document.body.innerHTML.slice(0, 3000)}`);
}
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

const entity = (id: string, label: string): EntityRef => ({ id, kind: 'code.symbol', label, href: `/k/e/${encodeURIComponent(id)}` });
const readers = Array.from({ length: 5 }, (_, index) => entity(`code.symbol:src/a.ts#read${index}`, `read${index}`));
const writers = [entity('code.symbol:src/a.ts#write', 'write')];
const values = (name: string, type: string) => [
  { name: 'symbolKind', label: 'Вид символа', value: 'field' },
  { name: 'typeText', label: 'Тип', value: type },
  { name: 'language', label: 'Язык', value: 'go' },
];

function members(): Block {
  return {
    type: 'members',
    title: 'Поля и свойства',
    kindLabel: 'Поле',
    kindLabelName: 'Вид символа',
    total: 3,
    rows: [
      { entity: entity('code.field:src/a.ts#Order.CancelReason', 'Order.CancelReason'), name: 'CancelReason', anchor: 'member-code.field%3Asrc%2Fa.ts%23Order.CancelReason', values: values('CancelReason', 'string'), readers, writers },
      { entity: entity('code.field:src/a.ts#Order.CreatedAt', 'Order.CreatedAt'), name: 'CreatedAt', anchor: 'member-code.field%3Asrc%2Fa.ts%23Order.CreatedAt', values: values('CreatedAt', 'time.Time'), readers: readers.slice(0, 4), writers: [] },
      { entity: entity('code.field:src/a.ts#Order.Discount', 'Order.Discount'), name: 'Discount', anchor: 'member-code.field%3Asrc%2Fa.ts%23Order.Discount', values: values('Discount', 'int64'), readers: [], writers: [] },
    ],
  } as Block;
}

describe('a class page draws its members as one table', () => {
  test('one table, one row per member, shared kind and language once, differing columns only, no per-member Details', async () => {
    const container = into(createElement(BlockView, { block: members(), resolutions: {} }));
    await until(() => container.querySelector('[data-block=members] table') !== null, 'the members table');
    const section = container.querySelector('[data-block=members]')!;
    expect(section.querySelectorAll('table')).toHaveLength(1);
    expect(section.querySelectorAll('tbody tr[data-testid=member-row]')).toHaveLength(3);
    expect(section.querySelectorAll('[data-testid=member-row] table')).toHaveLength(0);
    expect(section.querySelectorAll('[data-testid=member-row] [data-testid=member-shared]')).toHaveLength(0);

    const shared = section.querySelector('[data-testid=member-shared]')!;
    expect(shared.textContent).toContain('Вид символа: Поле');
    expect(shared.textContent).toContain('Язык: go');
    expect(section.textContent).not.toContain('field');
    expect(shared.textContent).not.toContain('Полное имя');

    const headings = [...section.querySelectorAll('thead th')].map((cell) => cell.textContent);
    expect(headings).toEqual(['Имя', 'Тип', 'Читают', 'Пишут']);
    expect(section.textContent).not.toContain('qualifiedName');

    const rows = [...section.querySelectorAll('tbody tr[data-testid=member-row]')];
    expect(rows[0]!.id).toBe('member-code.field%3Asrc%2Fa.ts%23Order.CancelReason');
    expect(rows[0]!.firstElementChild!.textContent).toBe('CancelReason');
    expect(rows[0]!.textContent).toContain('string');

    const read = rows[0]!.querySelector('[data-testid=member-readers]')!;
    expect(read.querySelectorAll('a')).toHaveLength(3);
    const more = read.querySelector('[data-testid=member-more]')!;
    expect(more.textContent).toBe('ещё 2');
    (more as HTMLButtonElement).click();
    await until(() => read.querySelectorAll('a').length === 5, 'the rest of the readers');
    expect(read.querySelector('[data-testid=member-more]')!.textContent).toBe('свернуть');
  });
  test('a kind is stated once even when its rows hold different facts, and a column label comes from the manifest', async () => {
    const facets: Block = {
      type: 'members',
      title: 'Что нашли читатели кода',
      kindLabel: 'Срез файла',
      kindLabelName: 'Вид символа',
      total: 2,
      rows: [
        { entity: entity('code.facet:src/a.ts#one', 'routes.ts · src/a.ts'), name: 'routes.ts · src/a.ts', anchor: 'member-one', values: [
          { name: 'language', label: 'Язык', value: 'typescript' },
          { name: 'role', label: 'Роль', value: 'code' },
          { name: 'parsed', label: 'Разобран', value: 'да' },
        ], readers: [], writers: [] },
        { entity: entity('code.facet:src/a.ts#two', 'src/a.ts · src/a.ts'), name: 'src/a.ts · src/a.ts', anchor: 'member-two', values: [
          { name: 'authors', label: 'Авторы', value: 'Sam Okafor' },
          { name: 'commitCount', label: 'Коммитов', value: '4' },
        ], readers: [], writers: [] },
      ],
    } as Block;
    const container = into(createElement(BlockView, { block: facets, resolutions: {} }));
    await until(() => container.querySelector('[data-block=members] table') !== null, 'the facet table');
    const section = container.querySelector('[data-block=members]')!;
    expect(section.querySelector('[data-testid=member-shared]')!.textContent).toContain('Вид символа: Срез файла');
    const headings = [...section.querySelectorAll('thead th')].map((cell) => cell.textContent);
    expect(headings).toEqual(['Имя', 'Язык', 'Роль', 'Разобран', 'Авторы', 'Коммитов']);
    expect(section.textContent).not.toContain('authors');
    expect(section.textContent).not.toContain('commitCount');
  });

});

import { expect, test } from 'bun:test';
import { colourNodes, folderLevel, heatOf, languageColour, tableRows, totalsOf, type FilesPageFile } from './files-page-data.js';

const file = (path: string, lines: number, bytes: number, language: string | null, heat: [number, number, number, number], authors: number, lastChange: string | null = '2026-11-10T00:00:00.000Z'): FilesPageFile => ({
  id: `code.file:repo/${path}`, node: path, href: `/e/code.file/${path}`, repository: 'repo', path, lines, bytes, language, candidates: language === null ? [] : [language],
  heat: { d30: heat[0], d90: heat[1], d365: heat[2], all: heat[3] }, lastChange, authorCount: authors,
});
const files: FilesPageFile[] = [
  file('src/a.ts', 10, 100, 'TypeScript', [1, 3, 4, 5], 2),
  file('src/b.ts', 20, 200, 'TypeScript', [2, 2, 2, 9], 1),
  file('src/nested/c.md', 30, 300, 'Markdown', [0, 1, 1, 1], 3),
  file('docs/d.md', 40, 400, null, [0, 0, 0, 0], 0, null),
];

test('the totals sentence counts files, lines and accepted languages', () => {
  expect(totalsOf(files)).toEqual({ files: 4, lines: 100, languages: 2, bytes: 1000 });
});

test('the map drills from repositories to folders and keeps folder file counts', () => {
  const roots = folderLevel(files, null, 'lines');
  expect(roots.map((node) => [node.kind, node.label, node.files, node.value])).toEqual([['repository', 'repo', 4, 100]]);
  const top = folderLevel(files, { repository: 'repo', path: '' }, 'lines');
  expect(top.map((node) => [node.kind, node.label, node.files, node.value])).toEqual([['folder', 'docs', 1, 40], ['folder', 'src', 3, 60]]);
  const src = folderLevel(files, { repository: 'repo', path: 'src' }, 'lines');
  expect(src.map((node) => [node.kind, node.label, node.files, node.value])).toEqual([['folder', 'nested', 1, 30], ['file', 'a.ts', 1, 10], ['file', 'b.ts', 1, 20]]);
});

test('every area and colour switch changes the map', () => {
  const level = folderLevel(files, { repository: 'repo', path: '' }, 'lines');
  const byLines = colourNodes(level, files, 'language', '90d', Date.now(), ['Markdown', 'TypeScript']);
  const byBytes = folderLevel(files, { repository: 'repo', path: '' }, 'bytes');
  expect(byLines.map((node) => node.value)).toEqual([40, 60]);
  expect(byBytes.map((node) => node.value)).toEqual([400, 600]);
  const language = colourNodes(level, files, 'language', '90d', Date.now(), ['Markdown', 'TypeScript']);
  const heat = colourNodes(level, files, 'heat', '90d', Date.now(), ['Markdown', 'TypeScript']);
  const age = colourNodes(level, files, 'age', '90d', Date.now(), ['Markdown', 'TypeScript']);
  const authors = colourNodes(level, files, 'authors', '90d', Date.now(), ['Markdown', 'TypeScript']);
  expect(new Set([...language, ...heat].map((node) => node.colour)).size).toBeGreaterThan(1);
  expect(new Set([...language, ...age].map((node) => node.colour)).size).toBeGreaterThan(1);
  expect(new Set([...language, ...authors].map((node) => node.colour)).size).toBeGreaterThan(1);
  expect(languageColour('TypeScript', ['Markdown', 'TypeScript'])).toBe('var(--chart-cat-2)');
});

test('the table filters by path, language and heat, sorts and pages by the graph key cursor', () => {
  const query = { text: 'src', language: '__all', measure: 'heat' as const, window: '90d' as const, from: '', to: '', sort: 'heat' as const, ascending: false, cursor: null };
  const first = tableRows(files, query, Date.parse('2026-11-15T00:00:00.000Z'), 2);
  expect(first.rows.map((row) => row.file.path)).toEqual(['src/a.ts', 'src/b.ts']);
  expect(first.total).toBe(3);
  const second = tableRows(files, { ...query, cursor: first.rows[1]!.file.id }, Date.parse('2026-11-15T00:00:00.000Z'), 2);
  expect(second.rows.map((row) => row.file.path)).toEqual(['src/nested/c.md']);
  expect(second.start).toBe(2);
  const languages = tableRows(files, { ...query, language: 'Markdown' }, Date.now(), 10);
  expect(languages.rows.map((row) => row.file.path)).toEqual(['src/nested/c.md']);
  const ranged = tableRows(files, { ...query, from: '2', to: '3' }, Date.now(), 10);
  expect(ranged.rows.map((row) => heatOf(row.file, '90d'))).toEqual([3, 2]);
});

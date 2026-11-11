import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtractContext, Unit, UnitResult } from '../src/plugin-sdk.js';
import { expect, test } from 'bun:test';
import { usagesOf } from '../plugins/glossary/usages.js';
import { termBlock, termUsages } from '../src/knowledge/blocks.js';

test('mentions count whole names, aliases and code names once, outside every definition range', () => {
  const usages = usagesOf({ name: 'Fill', synonyms: ['body fill', 'Наполнение'], code: ['fillRun', 'x.y'] }, [
    { repository: 'own', path: 'glossary.md', text: '**Fill** — fill fillRun\nbody fill\nFILL and body fill; fillRun x.y НАПОЛНЕНИЕ. refill fillRunExtra xZy _Fill Fill$ наполнением\n\nFill', definitions: [{ lineStart: 1, lineEnd: 2 }] },
    { repository: 'app', path: 'z.ts', text: 'Fill fill', definitions: [] },
    { repository: 'app', path: 'a.ts', text: 'Nothing', definitions: [] },
  ]);
  expect(usages).toEqual([
    { repository: 'app', path: 'z.ts', lineStart: 1, lineEnd: 1, count: 2 },
    { repository: 'own', path: 'glossary.md', lineStart: 3, lineEnd: 3, count: 5 },
    { repository: 'own', path: 'glossary.md', lineStart: 5, lineEnd: 5, count: 1 },
  ]);
  expect(termUsages({ ownRepository: 'own', repositories: ['app'] }, usages)).toEqual([
    { location: '[app/z.ts:1](/src?repo=app&path=z.ts&line=1)', count: 2 },
    { location: '[glossary.md:3](/src?path=glossary.md&line=3)', count: 5 },
    { location: '[glossary.md:5](/src?path=glossary.md&line=5)', count: 1 },
  ]);
});

test('an absent usages claim is an empty list, not the definition evidence', () => {
  expect(termUsages({ ownRepository: 'own', repositories: [] }, undefined)).toEqual([]);
  expect(usagesOf({ name: 'Fill', synonyms: [], code: [] }, [])).toEqual([]);
});


test('the plugin reads every graph-held text and publishes usages with its definition', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'glossary-plugin-'));
  try {
    const source = readFileSync(new URL('../plugins/glossary/main.ts', import.meta.url), 'utf8');
    writeFileSync(join(folder, 'main.ts'), source.replace("from 'madarch-plugin-sdk'", "from './sdk.ts'"));
    writeFileSync(join(folder, 'usages.ts'), readFileSync(new URL('../plugins/glossary/usages.ts', import.meta.url), 'utf8'));
    writeFileSync(join(folder, 'sdk.ts'), 'export let plugin; export async function definePlugin(value) { plugin = value; }');
    await import(join(folder, 'main.ts'));
    const { plugin } = await import(join(folder, 'sdk.ts')) as { plugin: { extract(unit: Unit, context: ExtractContext): Promise<UnitResult> } };
    const files = [
      { kind: 'code.file', key: { repository: 'own', path: 'docs/glossary.md' } },
      { kind: 'code.file', key: { repository: 'app', path: 'source.ts' } },
      { kind: 'code.file', key: { repository: 'app', path: 'binary.bin' } },
    ];
    const requests: string[] = [];
    const context: ExtractContext = {
      signal: new AbortController().signal, heartbeat() {}, progress() {},
      graph: {
        async files(pattern) { requests.push(pattern); return pattern === '**/*' ? files : files.slice(0, 1); },
        async value<T>(_kind: string, key: Readonly<Record<string, string | number>>) {
          return (key['path'] === 'docs/glossary.md' ? '- **Fill** — Fill reads the graph.\n  Also called: body fill\n  In code: fillRun\n- **Other** — Fill is mentioned here.\n' : key['path'] === 'source.ts' ? 'FILL fillRun body fill refill fillRunExtra' : null) as T;
        },
        async unresolved() { return { rows: [] }; }, async removedEnds() { return { rows: [] }; }, async unevidenced() { return { rows: [] }; },
      },
    };
    const answer = await plugin.extract({ unitId: 'terms', kind: 'doc.term', key: {} }, context);
    expect(requests).toEqual(['**/glossary*.md', '**/*']);
    expect(answer.vertices?.[0]?.values).toEqual({ definition: 'Fill reads the graph.', synonyms: ['body fill'], code: ['fillRun'], usages: [{ repository: 'app', path: 'source.ts', lineStart: 1, lineEnd: 1, count: 3 }, { repository: 'own', path: 'docs/glossary.md', lineStart: 4, lineEnd: 4, count: 1 }] });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});


test('the term block keeps definition evidence separate from counted usages', () => {
  const block = termBlock({ ownRepository: 'own', repositories: ['app'] }, { source: 'graph', entity: {
    key: 'doc.term:Fill', kind: 'doc.term', label: 'Fill', nodeIds: [], scope: '',
    properties: { definition: 'The run.', synonyms: [], code: [], usages: [{ repository: 'app', path: 'source.ts', lineStart: 2, lineEnd: 2, count: 3 }] },
    evidence: [{ field: 'definition', repository: 'own', path: 'docs/glossary.md', lineStart: 3, lineEnd: 5, commit: null }],
  } }, {}, '', 1);
  expect(block).toEqual({ type: 'term', title: 'Definition', definition: 'The run.', synonyms: [], code: [], definedIn: '[docs/glossary.md:3-5](/src?path=docs%2Fglossary.md&line=3)', usages: [{ location: '[app/source.ts:2](/src?repo=app&path=source.ts&line=2)', count: 3 }], usageCount: 3, ambiguous: null });
});

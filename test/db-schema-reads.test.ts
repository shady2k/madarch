import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';
import type { ExtractContext, KeyValues, Unit, UnitResult } from '../src/plugin-sdk.js';

test('db-schema reads every pattern match with bounded overlap and keeps the same ordered answer', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'db-schema-reads-'));
  try {
    const pluginFolder = new URL('../plugins/db-schema/', import.meta.url);
    const source = readFileSync(new URL('main.ts', pluginFolder), 'utf8');
    writeFileSync(join(folder, 'main.ts'), source.replace("from 'madarch-plugin-sdk'", "from './sdk.ts'"));
    symlinkSync(new URL('node_modules', pluginFolder).pathname, join(folder, 'node_modules'), 'dir');
    writeFileSync(join(folder, 'sdk.ts'), 'export let plugin; export async function definePlugin(value) { plugin = value; }');
    await import(join(folder, 'main.ts'));
    type Extractor = { extract(unit: Unit, context: ExtractContext): Promise<UnitResult> };
    const { plugin } = await import(join(folder, 'sdk.ts')) as { plugin: Extractor };
    const serialSource = source.replace(/const CONTENT_READ_CONCURRENCY = 8;/, 'const CONTENT_READ_CONCURRENCY = 1;');
    writeFileSync(join(folder, 'serial.ts'), serialSource.replace("from 'madarch-plugin-sdk'", "from './serial-sdk.ts'"));
    writeFileSync(join(folder, 'serial-sdk.ts'), 'export let plugin; export async function definePlugin(value) { plugin = value; }');
    await import(join(folder, 'serial.ts'));
    const { plugin: serial } = await import(join(folder, 'serial-sdk.ts')) as { plugin: Extractor };
    const definitions = Array.from({ length: 18 }, (_, index) => ({ kind: 'code.file', key: { repository: 'own', path: `${index}.ts` } }));
    const run = async (extractor: Extractor, delayed: boolean) => {
      let active = 0;
      let peak = 0;
      let pattern = '';
      const reads: string[] = [];
      const patterns: string[] = [];
      const context: ExtractContext = {
        signal: new AbortController().signal, heartbeat() {}, progress() {},
        async agent() { throw new Error('no agent requested'); },
        graph: {
          async files(value) { pattern = value; patterns.push(value); return value === 'first' ? definitions : [...definitions].reverse(); },
          async value<T>(_kind: string, key: KeyValues, field: string) {
            const index = Number(String(key['path']).split('.')[0]);
            const heldPattern = pattern;
            reads.push(`${heldPattern}:${String(key['path'])}:${field}`);
            peak = Math.max(peak, ++active);
            if (delayed) await new Promise<void>((resolve) => setTimeout(resolve, (18 - index) % 4));
            active--;
            return (index === 0 ? null : index === 1 ? '' : `const sql = "CREATE TABLE ${heldPattern}_${index} (id integer PRIMARY KEY)";`) as T;
          },
          async unresolved() { return { rows: [] }; }, async removedEnds() { return { rows: [] }; }, async unevidenced() { return { rows: [] }; },
        },
      };
      const answer = await extractor.extract({ unitId: 'schema', kind: 'code.table', key: {}, inputs: { patterns: ['first', 'second'] } }, context);
      return { answer, reads, peak, patterns };
    };
    const immediate = await run(serial, false);
    const delayed = await run(plugin, true);
    expect(delayed.answer).toEqual(immediate.answer);
    expect(delayed.answer.end).toEqual({ state: 'complete' });
    const tables = delayed.answer.vertices?.filter((vertex) => vertex.kind === 'code.table') ?? [];
    expect(tables).toHaveLength(16);
    expect(tables.every((vertex) => String(vertex.key['name']).startsWith('second_'))).toBe(true);
    expect(delayed.patterns).toEqual(['first', 'second']);
    expect(delayed.reads).toEqual([
      ...definitions.map((file) => `first:${file.key.path}:content`),
      ...[...definitions].reverse().map((file) => `second:${file.key.path}:content`),
    ]);
    expect(delayed.peak).toBeGreaterThan(1);
    expect(delayed.peak).toBeLessThanOrEqual(8);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

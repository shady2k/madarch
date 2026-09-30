import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteHistory,
  createSourceStores,
  sourceNameProblem,
  type Clock,
  type CompiledElement,
  type CompiledModel,
  type CompiledRelation,
  type HistoryStore,
  type StoreInput,
} from '../src/index.js';

const DAY = (day: number) => Date.UTC(2026, 8, day); // September 2026

/** A clock a test moves by hand, never the real one. */
function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return {
    now: () => current,
    set(t: number) {
      current = t;
    },
  };
}

function element(id: string, extra: Partial<CompiledElement> = {}): CompiledElement {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], ...extra };
}

function model(elements: CompiledElement[], relations: CompiledRelation[] = []): CompiledModel {
  return {
    schemaVersion: 1,
    elements,
    interfaces: [],
    relations,
    categories: [],
    zones: [],
    environments: [],
    states: [{ id: 'as-is' }],
  };
}

function storeInput(source: string, commit: string, committedAt: number, elements: CompiledElement[]): StoreInput {
  return { source, commit, committedAt, model: model(elements) };
}

let folder: string;

afterEach(() => {
  if (folder !== undefined) {
    rmSync(folder, { recursive: true, force: true });
    folder = undefined as unknown as string;
  }
});

function scratchFolder(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-server-sources-'));
  return folder;
}

describe('source names become file names', () => {
  test('a source with path separators is stored inside the folder only, never outside it', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(2));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('../../etc/passwd', 'c1', DAY(1), [element('a')]));
    sources.close();

    expect(existsSync(join(dir, '..%2F..%2Fetc%2Fpasswd.sqlite'))).toBe(true);
    expect(existsSync(join(dir, '..%2F..%2Fetc%2Fpasswd.json'))).toBe(true);
  });

  test('two names that only differ in encoding shape never share a file', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(2));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('a/b', 'c1', DAY(1), [element('a')]));
    sources.store(storeInput('a%2Fb', 'c1', DAY(1), [element('a')]));
    sources.close();

    expect(existsSync(join(dir, 'a%2Fb.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'a%252%46b.sqlite'))).toBe(true);
  });

  test('two names that differ only in case get file names that differ lower-cased, so one file cannot shadow the other', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(2));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('Acme/Shop', 'c1', DAY(1), [element('a')]));
    sources.store(storeInput('acme/shop', 'c1', DAY(1), [element('a')]));
    sources.close();

    // The upper-case letters are percent-encoded, so both stems hold only
    // lower-case letters, digits and escapes: a case-insensitive file
    // system still sees two different names.
    expect(existsSync(join(dir, '%41cme%2F%53hop.sqlite'))).toBe(true);
    expect(existsSync(join(dir, '%41cme%2F%53hop.json'))).toBe(true);
    expect(existsSync(join(dir, 'acme%2Fshop.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'acme%2Fshop.json'))).toBe(true);
    expect('%41cme%2F%53hop'.toLowerCase()).not.toBe('acme%2Fshop');
  });

  test('a file name carrying a raw upper-case letter was not written by this server and is refused', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'Acme%2FShop.sqlite'), '');
    writeFileSync(join(dir, 'Acme%2FShop.json'), JSON.stringify({ source: 'Acme/Shop', commit: 'c1', committedAt: 1, storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/Acme%2FShop\.json/);
  });

  test('a name holding a control character is refused naming the field', () => {
    expect(sourceNameProblem('a\nb')).toMatch(/control character/);
    expect(sourceNameProblem('a\u0000b')).toMatch(/control character/);
    expect(sourceNameProblem('a\u007Fb')).toMatch(/control character/);
    expect(sourceNameProblem('a\u009Fb')).toMatch(/control character/);
  });
});

describe('sourceNameProblem', () => {
  test('a name with separators, dots and non-ASCII letters is fine', () => {
    expect(sourceNameProblem('../../etc/passwd')).toBeUndefined();
    expect(sourceNameProblem('github.com/shady2k/nocx')).toBeUndefined();
    expect(sourceNameProblem('github.com/ünicode/repo')).toBeUndefined();
    expect(sourceNameProblem('..')).toBeUndefined();
  });

  test('an empty or non-string name is a problem naming the field', () => {
    expect(sourceNameProblem('')).toMatch(/source/);
    expect(sourceNameProblem(42)).toMatch(/source/);
    expect(sourceNameProblem(undefined)).toMatch(/source/);
  });

  test('a name whose file name would be too long is refused naming the limit', () => {
    expect(sourceNameProblem('x'.repeat(201))).toMatch(/200/);
    expect(sourceNameProblem('x'.repeat(200))).toBeUndefined();
    expect(sourceNameProblem('%/'.repeat(70))).toMatch(/200/); // 140 raw bytes, 420 encoded
  });
});

describe('heads', () => {
  test('a stored source is listed with its commit, commit time and storing moment, in code point order', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    clock.set(DAY(11));
    sources.store(storeInput('zeta', 'c1', DAY(1), [element('a')]));
    clock.set(DAY(12));
    sources.store(storeInput('alpha', 'c2', DAY(2), [element('b')]));
    sources.close();

    expect(sources.heads()).toEqual([
      { source: 'alpha', commit: 'c2', committedAt: DAY(2), storedAt: DAY(12) },
      { source: 'zeta', commit: 'c1', committedAt: DAY(1), storedAt: DAY(11) },
    ]);
  });

  test('the head is the newest commit by commit time, not the latest arrival', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'c3', DAY(3), [element('c3')]));
    sources.store(storeInput('shop', 'c1', DAY(1), [element('c1')])); // arrives later, is older
    sources.close();

    expect(sources.heads()).toEqual([{ source: 'shop', commit: 'c3', committedAt: DAY(3), storedAt: DAY(10) }]);
  });

  test('commits at the same time are ordered by the commit id in code point order', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'zzz', DAY(1), [element('a')]));
    sources.store(storeInput('shop', 'aaa', DAY(1), [element('b')]));
    sources.close();

    expect(sources.heads()).toEqual([{ source: 'shop', commit: 'zzz', committedAt: DAY(1), storedAt: DAY(10) }]);
  });

  test('a repeat store changes nothing', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const before = sources.heads();
    const repeat = sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    sources.close();

    expect(repeat.wasNew).toBe(false);
    expect(repeat.result.errors).toEqual([]);
    expect(sources.heads()).toEqual(before);
  });

  test('store reports whether the commit was new', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const first = sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    sources.close();
    expect(first.wasNew).toBe(true);
  });
});

describe('restart on the same data folder', () => {
  test('the sources are known again with the same heads', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const first = createSourceStores({ dataFolder: dir, clock });
    first.store(storeInput('github.com/shady2k/nocx', 'c1', DAY(1), [element('a')]));
    first.store(storeInput('github.com/acme/shop', 'c2', DAY(2), [element('b')]));
    const before = first.heads();
    first.close();

    const second = createSourceStores({ dataFolder: dir, clock });
    const after = second.heads();
    second.close();

    expect(after).toEqual(before);
  });

  test('a history keeps storing after the restart', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const first = createSourceStores({ dataFolder: dir, clock });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    first.close();

    const second = createSourceStores({ dataFolder: dir, clock });
    const store = second.store(storeInput('shop', 'c2', DAY(2), [element('a'), element('b')]));
    expect(store.wasNew).toBe(true);
    expect(second.heads()).toEqual([{ source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) }]);

    const history: HistoryStore = second.historyOf('shop');
    const read = history.read({ source: 'shop', valid: DAY(2), known: DAY(10) });
    expect(read.errors).toEqual([]);
    expect(read.model && 'elements' in read.model ? read.model.elements.map((e) => e.id) : []).toEqual(['a', 'b']);
    second.close();
  });
});

describe('a corrupt data folder refuses to open, naming the file', () => {
  test('a sidecar without its history file', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'lonely.json'), JSON.stringify({ source: 'lonely', commit: 'c1', committedAt: 1, storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/lonely\.json/);
  });

  test('a history file without its sidecar', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'bare.sqlite'), '');
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/bare\.sqlite/);
  });

  test('a sidecar that is not valid JSON', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), '');
    writeFileSync(join(dir, 'shop.json'), '{not json');
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/shop\.json/);
  });

  test('a sidecar whose source does not match its file name', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), '');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'other', commit: 'c1', committedAt: 1, storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/shop\.json/);
  });

  test('a sidecar missing a field', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), '');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/shop\.json/);
  });
});

describe('the data folder itself', () => {
  test('a folder that does not exist is refused, naming the path', () => {
    const dir = join(scratchFolder(), 'missing');
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/missing/);
  });

  test('a path that is a file, not a folder, is refused naming the path', () => {
    const dir = scratchFolder();
    const filePath = join(dir, 'afile');
    writeFileSync(filePath, '');
    expect(() => createSourceStores({ dataFolder: filePath, clock: fakeClock(DAY(1)) })).toThrow(/afile/);
  });

  test('stray files that are not histories or sidecars are ignored', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'README.md'), 'notes');
    writeFileSync(join(dir, 'shop.json.tmp'), 'leftover');
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(sources.heads()).toEqual([]);
    sources.close();
  });
});

describe('the history behind a source', () => {
  test('one history per source, reused across calls', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const first = sources.historyOf('shop');
    const second = sources.historyOf('shop');
    expect(first).toBe(second);
    const other = sources.historyOf('other');
    expect(other).not.toBe(first);
    sources.close();
  });

  test('a source that was never sent is not in the heads', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(sources.heads()).toEqual([]);
    sources.close();
  });

  test('a refused store leaves the head alone', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const before = sources.heads();

    const refused = sources.store(storeInput('shop', 'c1', DAY(9), [element('different')]));
    sources.close();

    expect(refused.result.errors).toHaveLength(1);
    expect(refused.result.errors[0]!.id).toBe('c1');
    expect(sources.heads()).toEqual(before);
  });
});

describe('an in-memory history still works beside the file-backed ones', () => {
  test('createSqliteHistory without a path is unaffected', () => {
    const history = createSqliteHistory({ clock: fakeClock(DAY(2)) });
    history.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    expect(history.sources()).toEqual(['shop']);
    history.close();
  });
});


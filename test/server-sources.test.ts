import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  test('the first-stored commit of a tie is superseded by the bigger id, not kept', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'aaa', DAY(1), [element('a')]));
    sources.store(storeInput('shop', 'zzz', DAY(1), [element('b')]));
    sources.close();

    // The second store closes the first's rows, so its own recorded
    // moment is clamped strictly past the clock's reading.
    expect(sources.heads()).toEqual([{ source: 'shop', commit: 'zzz', committedAt: DAY(1), storedAt: DAY(10) + 1 }]);
  });

  test('a later commit time wins even when the older commit sorts the other way', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'a9', DAY(2), [element('a')]));
    sources.store(storeInput('shop', 'z9', DAY(1), [element('b')])); // older, though its id sorts higher
    sources.close();

    expect(sources.heads()).toEqual([{ source: 'shop', commit: 'a9', committedAt: DAY(2), storedAt: DAY(10) }]);
  });

  test('a sidecar write that fails after the commit was stored is healed by retrying the same commit', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));

    // Sabotage at the file-system boundary: the sidecar's own temporary
    // path is a folder, so the history stores the commit and the sidecar
    // write then fails.
    mkdirSync(join(dir, 'shop.json.tmp'));
    expect(() => sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).toThrow();
    rmdirSync(join(dir, 'shop.json.tmp'));

    clock.set(DAY(20));

    const retry = sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
    expect(retry.wasNew).toBe(false);
    expect(retry.result.errors).toEqual([]);
    // The repaired head carries the original c2 store's own moment,
    // held by the history's commit row — not the retry's later clock.
    // The first c2 store closed c1's row, so its recorded moment was
    // clamped 1 ms past the then-frozen clock.
    expect(sources.heads()).toEqual([{ source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    sources.close();
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

  test('a restart repairs a sidecar that went missing, from the history itself, and logs it', () => {
    const dir = scratchFolder();
    const lines: string[] = [];
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    first.close();
    rmSync(join(dir, 'shop.json'));

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    expect(second.heads()).toEqual([{ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(existsSync(join(dir, 'shop.json'))).toBe(true);
    expect(lines.join('\n')).toContain('repaired');
    second.close();
  });

  test('a restart repairs a stale sidecar from the history, and logs it', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    mkdirSync(join(dir, 'shop.json.tmp')); // the sidecar write for c2 fails
    expect(() => first.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).toThrow();
    rmdirSync(join(dir, 'shop.json.tmp'));
    first.close(); // the sidecar on disk still names c1

    const lines: string[] = [];
    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    expect(second.heads()).toEqual([{ source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    expect(lines.join('\n')).toContain('repaired');
    second.close();
  });

  test('a restart with an agreeing sidecar changes nothing and logs no repair', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    first.close();

    const lines: string[] = [];
    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    expect(second.heads()).toEqual([{ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(lines.join('\n')).not.toContain('repaired');
    second.close();
  });
});

describe('a corrupt data folder refuses to open, naming the file', () => {
  test('a sidecar without its history file', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'lonely.json'), JSON.stringify({ source: 'lonely', commit: 'c1', committedAt: 1, storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/lonely\.json/);
  });

  test('a history holding more than one source cannot be named by one file and is refused naming it', () => {
    const dir = scratchFolder();
    const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-multi-'));
    const built = createSqliteHistory({ path: join(elsewhere, 'built.sqlite'), clock: fakeClock(DAY(10)) });
    built.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    built.store(storeInput('other', 'c1', DAY(1), [element('b')]));
    built.close();
    renameSync(join(elsewhere, 'built.sqlite'), join(dir, 'multi.sqlite'));
    rmSync(elsewhere, { recursive: true, force: true });

    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/multi\.sqlite/);
  });

  test('a sidecar naming a source its history does not hold is refused naming both files', () => {
    const dir = scratchFolder();
    const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-foreign-'));
    const built = createSqliteHistory({ path: join(elsewhere, 'built.sqlite'), clock: fakeClock(DAY(10)) });
    built.store(storeInput('other', 'c1', DAY(1), [element('b')]));
    built.close();
    renameSync(join(elsewhere, 'built.sqlite'), join(dir, 'shop.sqlite'));
    rmSync(elsewhere, { recursive: true, force: true });
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2 }));

    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/shop\.sqlite/);
  });

  test('the refusal about an unreadable folder carries the file-system error as its cause', () => {
    const dir = join(scratchFolder(), 'missing');
    let thrown: unknown;
    try {
      createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/ENOENT|no such file|not exist/i);
  });

  test('the refusal about a sidecar that is not JSON carries the parse error as its cause', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), '');
    writeFileSync(join(dir, 'shop.json'), '{not json');
    let thrown: unknown;
    try {
      createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
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

  test('a sidecar holding a field of the wrong shape is refused naming its file and the field', () => {
    const broken: { name: string; sidecar: Record<string, unknown> }[] = [
      { name: 'source is not a string', sidecar: { source: 42, commit: 'c1', committedAt: 1, storedAt: 2 } },
      { name: 'source is empty', sidecar: { source: '', commit: 'c1', committedAt: 1, storedAt: 2 } },
      { name: 'commit is not a string', sidecar: { source: 'shop', commit: 42, committedAt: 1, storedAt: 2 } },
      { name: 'committedAt is not a number', sidecar: { source: 'shop', commit: 'c1', committedAt: '1', storedAt: 2 } },
      { name: 'committedAt is not finite', sidecar: { source: 'shop', commit: 'c1', committedAt: Number.NaN, storedAt: 2 } },
      { name: 'storedAt is not a number', sidecar: { source: 'shop', commit: 'c1', committedAt: 1, storedAt: '2' } },
      { name: 'storedAt is not finite', sidecar: { source: 'shop', commit: 'c1', committedAt: 1, storedAt: Number.POSITIVE_INFINITY } },
    ];
    for (const { name, sidecar } of broken) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-'));
      try {
        writeFileSync(join(dir, 'shop.sqlite'), '');
        writeFileSync(join(dir, 'shop.json'), JSON.stringify(sidecar));
        expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), name).toThrow(/shop\.json/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a file name this server never writes is refused, even when the sidecar matches what it would decode to', () => {
    // A raw `~` is always encoded, a `%zz` escape is not hexadecimal, and
    // `%FF` alone is not valid UTF-8: none of these stems was written by
    // this server, whatever the sidecar beside them claims.
    const stems: [string, string][] = [
      ['sh~op', 'sh~op'],
      ['a%zzb', 'azzb'],
      ['a%FFb', 'a\uFFFDb'],
    ];
    for (const [stem, source] of stems) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-'));
      try {
        writeFileSync(join(dir, `${stem}.sqlite`), '');
        writeFileSync(join(dir, `${stem}.json`), JSON.stringify({ source, commit: 'c1', committedAt: 1, storedAt: 2 }));
        expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), stem).toThrow(/does not decode to a source name/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
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
    expect(() => createSourceStores({ dataFolder: filePath, clock: fakeClock(DAY(1)) })).toThrow(/afile.*is not a folder|is not a folder.*afile/s);
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

  test('a store reached with a name that must be refused first throws as a caller defect', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(() => sources.store(storeInput('a\nb', 'c1', DAY(1), [element('a')]))).toThrow(/refused first/);
    sources.close();
  });

  test('a model with no assertions at all still stores, and the restart reads its sidecar', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    const stored = sources.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: { ...model([]), states: [] } });
    expect(stored.result.errors).toEqual([]);
    expect(stored.result.opened).toEqual([]);
    sources.close();

    const second = createSourceStores({ dataFolder: dir, clock });
    expect(second.heads()).toEqual([{ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    second.close();
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


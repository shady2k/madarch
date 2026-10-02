import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommitRecord } from '../src/history/types.js';
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

  test('a too-long name is echoed cut to 64 code points, never whole', () => {
    const problem = sourceNameProblem('x'.repeat(300));
    expect(problem).toMatch(/200/);
    expect(problem).toContain('x'.repeat(64));
    expect(problem).toContain('…');
    expect(problem).not.toContain('x'.repeat(65));
  });

  test('a too-long name of astral characters is echoed cut at the 64th code point, never inside one', () => {
    // 63 one-code-point letters, then astral characters of two UTF-16
    // units each: the 64th code point is an astral character that
    // `slice`, counting UTF-16 units, would cut in half. Encoded, the
    // name is 63 + 4 x 35 = 203 bytes, past the 200-byte limit.
    const name = 'a'.repeat(63) + '𝐀'.repeat(35);
    const problem = sourceNameProblem(name);
    expect(problem).toMatch(/200/);
    expect(problem).toContain('a'.repeat(63) + '𝐀');
    expect(problem).toContain('…');
    expect(problem).not.toContain('a'.repeat(63) + '𝐀'.repeat(2));
    // A surrogate half never appears, not even as an escaped lone one.
    expect(problem).not.toContain('\\ud835');
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
      { id: expect.any(String), source: 'alpha', commit: 'c2', committedAt: DAY(2), storedAt: DAY(12) },
      { id: expect.any(String), source: 'zeta', commit: 'c1', committedAt: DAY(1), storedAt: DAY(11) },
    ]);
  });

  test('the head is the newest commit by commit time, not the latest arrival', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'c3', DAY(3), [element('c3')]));
    sources.store(storeInput('shop', 'c1', DAY(1), [element('c1')])); // arrives later, is older
    sources.close();

    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c3', committedAt: DAY(3), storedAt: DAY(10) }]);
  });

  test('commits at the same time are ordered by the commit id in code point order', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'zzz', DAY(1), [element('a')]));
    sources.store(storeInput('shop', 'aaa', DAY(1), [element('b')]));
    sources.close();

    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'zzz', committedAt: DAY(1), storedAt: DAY(10) }]);
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
    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'zzz', committedAt: DAY(1), storedAt: DAY(10) + 1 }]);
  });

  test('a later commit time wins even when the older commit sorts the other way', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });

    sources.store(storeInput('shop', 'a9', DAY(2), [element('a')]));
    sources.store(storeInput('shop', 'z9', DAY(1), [element('b')])); // older, though its id sorts higher
    sources.close();

    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'a9', committedAt: DAY(2), storedAt: DAY(10) }]);
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
    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    sources.close();
  });
  test('retrying the first send after a sidecar failure keeps the committed registry id', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    mkdirSync(join(dir, 'shop.json.tmp'));
    const input = storeInput('shop', 'c1', DAY(1), [element('a')]);
    expect(() => sources.store(input)).toThrow();
    const id = sources.historyOf('shop').registry('shop')?.id;
    expect(id).toEqual(expect.any(String));
    rmdirSync(join(dir, 'shop.json.tmp'));

    sources.store(input);

    expect(sources.heads()).toEqual([{ id: id!, source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    sources.close();
  });
  test('a registry write failure rolls back the commit that needs that identity', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const history = sources.historyOf('shop');
    const database = new Database(join(dir, 'shop.sqlite'));
    database.run("CREATE TRIGGER fail_registry_insert BEFORE INSERT ON source_registry BEGIN SELECT RAISE(ABORT, 'registry write failed'); END");
    database.close();

    const result = sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));

    expect(result.result.errors).toHaveLength(1);
    expect(history.hasCommit('shop', 'c1')).toBe(false);
    expect(history.registry('shop')).toBeUndefined();
    sources.close();
  });

  test('a store reads the commit\'s own row, never the source\'s whole history', () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = createSourceStores({ dataFolder: dir, clock });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
    const history = sources.historyOf('shop');

    // Counting through the history's public interface, at the storage
    // boundary: a store must not grow with the history's length, so it
    // may not load the whole commit list to read one commit's storing
    // moment.
    let commitLists = 0;
    const original = history.commits.bind(history);
    history.commits = (source: string) => {
      commitLists += 1;
      return original(source);
    };

    clock.set(DAY(11));
    sources.store(storeInput('shop', 'c3', DAY(3), [element('c')]));
    sources.close();

    expect(commitLists).toBe(0);
    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c3', committedAt: DAY(3), storedAt: DAY(11) }]);
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
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) }]);

    const history: HistoryStore = second.historyOf('shop');
    const read = history.read({ source: 'shop', valid: DAY(2), known: DAY(10) });
    expect(read.errors).toEqual([]);
    expect(read.model && 'elements' in read.model ? read.model.elements.map((e) => e.id) : []).toEqual(['a', 'b']);
    second.close();
  });

  test('a missing sidecar is rebuilt from history without changing identity or retired names', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = first.heads()[0]!.id;
    first.rename(id, 'renamed');
    first.close();
    rmSync(join(dir, 'renamed.json'));

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()).toEqual([{ id, source: 'renamed', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(second.retiredHead('shop')?.id).toBe(id);
    expect(() => second.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).toThrow(/renamed/);
    second.close();
  });
  test('two missing sidecars rebuild distinct persisted identities at startup', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('alpha', 'c1', DAY(1), [element('a')]));
    first.store(storeInput('beta', 'c1', DAY(1), [element('b')]));
    const before = first.heads();
    first.close();
    rmSync(join(dir, 'alpha.json'));
    rmSync(join(dir, 'beta.json'));

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()).toEqual(before);
    expect(second.heads()[0]?.id).not.toBe(second.heads()[1]?.id);
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
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    expect(lines.join('\n')).toContain('repaired');
    second.close();
  });

  test('a sidecar whose storing moment disagrees is repaired, even when the commit and its time agree', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    first.close();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(9) }));

    const lines: string[] = [];
    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { storedAt: number };
    expect(sidecar.storedAt).toBe(DAY(10));
    expect(lines.join('\n')).toContain('repaired');
    second.close();
  });

  test('a sidecar naming another commit is repaired, even when the storing moment agrees', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    // c2 asserts what c1 already had, so it opens no row and is recorded
    // at the same frozen moment: the two commits share their storedAt.
    first.store(storeInput('shop', 'c2', DAY(2), [element('a')]));
    first.close();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }));

    const lines: string[] = [];
    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { commit: string };
    expect(sidecar.commit).toBe('c2');
    expect(lines.join('\n')).toContain('repaired');
    second.close();
  });
  test('a stale sidecar formerNames list is repaired from the registry', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    first.rename(first.heads()[0]!.id, 'renamed');
    first.close();
    const sidecar = JSON.parse(readFileSync(join(dir, 'renamed.json'), 'utf8')) as Record<string, unknown>;
    sidecar.formerNames = [];
    writeFileSync(join(dir, 'renamed.json'), JSON.stringify(sidecar));

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });

    expect(JSON.parse(readFileSync(join(dir, 'renamed.json'), 'utf8')).formerNames).toEqual(['shop']);
    expect(second.retiredHead('shop')?.source).toBe('renamed');
    second.close();
  });

  test('a sidecar whose commit time disagrees is repaired, even when the commit and its storing moment agree', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    first.close();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(5), storedAt: DAY(10) }));

    const lines: string[] = [];
    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { committedAt: number };
    expect(sidecar.committedAt).toBe(DAY(1));
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
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(lines.join('\n')).not.toContain('repaired');
    second.close();
  });
});

describe('source ids', () => {
  test('the first send assigns the source an id, and the name plays no part in it', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });

    sources.store(storeInput('github.com/shady2k/nocx', 'c1', DAY(1), [element('a')]));
    const head = sources.heads()[0]!;
    sources.close();

    expect(head.id).toEqual(expect.any(String));
    expect(head.id.length).toBeGreaterThan(0);
    expect(head.id).not.toBe(head.source);
    expect(head.id).not.toContain(head.source);
  });

  test('further sends of the same source keep its id', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const first = sources.heads()[0]!.id;

    sources.store(storeInput('shop', 'c2', DAY(2), [element('a'), element('b')]));
    sources.close();

    expect(sources.heads()).toHaveLength(1);
    expect(sources.heads()[0]!.id).toBe(first);
    expect(sources.heads()[0]!.commit).toBe('c2');
  });

  test('a restart on the same data folder keeps the id, which the sidecar beside the history holds', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = first.heads()[0]!.id;
    first.close();

    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { id: unknown };
    expect(sidecar.id).toBe(id);

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()[0]!.id).toBe(id);
    second.close();
  });

  test('two different sources hold different ids', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('github.com/a/first', 'c1', DAY(1), [element('a')]));
    sources.store(storeInput('github.com/b/second', 'c1', DAY(1), [element('a')]));
    const heads = sources.heads();
    sources.close();

    expect(heads[0]!.id).not.toBe(heads[1]!.id);
  });

  test('a data folder from before the ids existed: every source gets an id at start, and no stored answer changes', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('github.com/shady2k/nocx', 'c2', DAY(2), [element('b')]));
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const before = first.heads().map(({ id: _id, ...rest }) => rest);
    const commitsBefore: Record<string, CommitRecord[]> = {};
    for (const head of first.heads()) commitsBefore[head.source] = first.historyOf(head.source).commits(head.source);
    first.close();

    // The folder as an older server left it: sidecars without an id.
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.endsWith('.json.tmp')) continue;
      const sidecar = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      delete sidecar.id;
      writeFileSync(join(dir, name), JSON.stringify(sidecar));
    }

    const lines: string[] = [];
    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const heads = second.heads();
    expect(heads.map(({ id: _id, ...rest }) => rest)).toEqual(before);
    for (const head of heads) {
      expect(head.id.length).toBeGreaterThan(0);
      const commitsOf = commitsBefore[head.source];
      if (commitsOf === undefined) throw new Error(`the test took no snapshot of the commits of "${head.source}"`);
      expect(second.historyOf(head.source).commits(head.source)).toEqual(commitsOf);
    }
    expect(lines.join('\n')).toContain('assigned the source id');
    second.close();
  });

  test('a restart that repairs a stale sidecar keeps the id the sidecar held', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    first.store(storeInput('shop', 'c2', DAY(2), [element('a')]));
    const id = first.heads()[0]!.id;
    first.close();
    // The sidecar an interrupted write left behind: the older head, the id included.
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10), id }));

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const head = second.heads()[0]!;
    expect(head.commit).toBe('c2');
    expect(head.id).toBe(id);
    second.close();
  });

  test('a sidecar whose id is not a non-empty string refuses to open, naming the file and the field', () => {
    for (const bad of [7, '']) {
      const dir = scratchFolder();
      const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
      first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
      first.close();
      writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10), id: bad }));

      expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) })).toThrow(new RegExp(`shop\\.json[\\s\\S]*"id"[\\s\\S]*non-empty string`));
    }
  });
});

describe('a rename claim on the stores', () => {
  test('the id, the head and the history survive the rename; the files move to the new name', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
    const id = sources.heads()[0]!.id;
    const commitsBefore = sources.historyOf('shop').commits('shop');
    const readBefore = sources.historyOf('shop').read({ source: 'shop', valid: DAY(2), known: DAY(20) });

    expect(sources.rename(id, 'github.com/shady2k/nocx')).toEqual({ formerSource: 'shop' });

    // c2 closed c1's rows, so its own recorded moment sits 1 ms past the
    // frozen clock; the rename leaves it exactly as it was.
    expect(sources.heads()).toEqual([{ id, source: 'github.com/shady2k/nocx', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    expect(existsSync(join(dir, 'github.com%2Fshady2k%2Fnocx.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'github.com%2Fshady2k%2Fnocx.json'))).toBe(true);
    expect(existsSync(join(dir, 'shop.sqlite'))).toBe(false);
    expect(existsSync(join(dir, 'shop.json'))).toBe(false);

    const history = sources.historyOf('github.com/shady2k/nocx');
    expect(history.commits('github.com/shady2k/nocx')).toEqual(commitsBefore);
    expect(history.read({ source: 'github.com/shady2k/nocx', valid: DAY(2), known: DAY(20) })).toEqual(readBefore);
    sources.close();
  });

  test('the old name is retired: a store reached with it is a caller defect naming the rename, and retiredHead answers the new head', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    sources.rename(id, 'moved');

    expect(sources.retiredHead('shop')?.source).toBe('moved');
    expect(sources.retiredHead('never-named')).toBeUndefined();
    expect(() => sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).toThrow(/refused first[\s\S]*"shop"[\s\S]*"moved"/);
    sources.close();
  });

  test('a rename to a name another source holds is refused naming both, and nothing moves', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    sources.store(storeInput('other', 'c1', DAY(1), [element('b')]));
    const shopId = sources.heads().find((head) => head.source === 'shop')!.id;
    const before = sources.heads();

    expect(() => sources.rename(shopId, 'other')).toThrow(/the name "other" is already the name of the source with id "[^"]*"/);
    expect(sources.heads()).toEqual(before);
    expect(existsSync(join(dir, 'shop.sqlite'))).toBe(true);
    sources.close();
  });

  test('a rename reached with an id no source holds is a caller defect naming it', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(() => sources.rename('no-such-id', 'x')).toThrow(/no-such-id/);
    sources.close();
  });

  test('former names are kept in the sidecar, sorted, and a restart retires them again', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    sources.rename(id, 'bbb');
    sources.rename(id, 'aaa');
    sources.close();

    const sidecar = JSON.parse(readFileSync(join(dir, 'aaa.json'), 'utf8')) as { formerNames: unknown };
    expect(sidecar.formerNames).toEqual(['bbb', 'shop']);

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()).toEqual([{ id, source: 'aaa', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(second.retiredHead('shop')?.source).toBe('aaa');
    expect(second.retiredHead('bbb')?.source).toBe('aaa');
    expect(() => second.store(storeInput('bbb', 'c2', DAY(2), [element('b')]))).toThrow(/refused first/);
    second.close();
  });

  test('renaming back to a former name retires the middle names and keeps every former name explained', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    sources.rename(id, 'bbb');
    sources.rename(id, 'aaa');
    sources.rename(id, 'shop');

    expect(sources.heads()).toEqual([{ id, source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(sources.retiredHead('aaa')?.source).toBe('shop');
    expect(sources.retiredHead('bbb')?.source).toBe('shop');
    expect(sources.retiredHead('shop')).toBeUndefined();
    expect(() => sources.store(storeInput('aaa', 'c2', DAY(2), [element('b')]))).toThrow(/refused first/);
    sources.close();

    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { formerNames: unknown };
    expect(sidecar.formerNames).toEqual(['aaa', 'bbb']);
  });
  test('a failed registry row rename restores the original sidecar and old history name', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    const originalSidecar = readFileSync(join(dir, 'shop.json'));
    const database = new Database(join(dir, 'shop.sqlite'));
    database.run("CREATE TRIGGER fail_source_rename BEFORE UPDATE OF source ON source_commits BEGIN SELECT RAISE(ABORT, 'rename failed'); END");
    database.close();

    expect(() => sources.rename(id, 'renamed')).toThrow(/rename failed/);

    expect(sources.heads().map((head) => head.source)).toEqual(['shop']);
    expect(existsSync(join(dir, 'shop.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'renamed.sqlite'))).toBe(false);
    expect(readFileSync(join(dir, 'shop.json'))).toEqual(originalSidecar);
    expect(sources.historyOf('shop').sources()).toEqual(['shop']);
    sources.close();
  });
  test('a sidecar failure after rename commits keeps the identity through retry and restart', () => {
    const dir = scratchFolder();
    const sources = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    mkdirSync(join(dir, 'renamed.json.tmp'));

    expect(() => sources.rename(id, 'renamed')).toThrow();
    expect(sources.heads().map((head) => head.source)).toEqual(['renamed']);
    expect(sources.historyOf('renamed').registry('renamed')?.id).toBe(id);
    rmdirSync(join(dir, 'renamed.json.tmp'));

    const retry = sources.store(storeInput('renamed', 'c2', DAY(2), [element('b')]));
    expect(retry.result.errors).toEqual([]);
    expect(sources.heads()).toEqual([{ id, source: 'renamed', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    sources.close();

    const restarted = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(restarted.heads()[0]?.id).toBe(id);
    expect(restarted.retiredHead('shop')?.source).toBe('renamed');
    expect(restarted.heads()).toHaveLength(1);
    restarted.close();
  });

  test('a sidecar whose former names are not an array of non-empty strings is refused naming the file and the field', () => {
    for (const formerNames of ['shop', [42], [''], ['shop', 'shop']]) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-former-'));
      try {
        writeFileSync(join(dir, 'shop.sqlite'), '');
        writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2, formerNames }));
        expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), JSON.stringify(formerNames)).toThrow(
          new RegExp(`shop\\.json[\\s\\S]*"formerNames"`),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a sidecar naming its own current name among its former names is refused naming the file', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), '');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['shop'] }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/shop\.json[\s\S]*"formerNames"[\s\S]*"shop"/);
  });

  /** A real one-source history planted in the folder under a stem, as only this server writes them. */
  function plantedHistory(dir: string, stem: string, source: string): void {
    const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-plant-'));
    const built = createSqliteHistory({ path: join(elsewhere, `${stem}.sqlite`), clock: fakeClock(DAY(10)) });
    built.store(storeInput(source, 'c1', DAY(1), [element('a')]));
    built.close();
    renameSync(join(elsewhere, `${stem}.sqlite`), join(dir, `${stem}.sqlite`));
    rmSync(elsewhere, { recursive: true, force: true });
  }

  test('a restart refuses a folder where one source\'s former name is another source\'s name, naming both', () => {
    const dir = scratchFolder();
    plantedHistory(dir, 'aaa', 'aaa');
    plantedHistory(dir, 'taken', 'taken');
    writeFileSync(join(dir, 'aaa.json'), JSON.stringify({ source: 'aaa', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['taken'] }));
    writeFileSync(join(dir, 'taken.json'), JSON.stringify({ source: 'taken', commit: 'c1', committedAt: 1, storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(
      /"formerNames" naming "taken"[\s\S]*is the current name of the source beside it/,
    );
  });

  test('a restart refuses a folder where two sources hold the same former name, naming both', () => {
    const dir = scratchFolder();
    plantedHistory(dir, 'aaa', 'aaa');
    plantedHistory(dir, 'bbb', 'bbb');
    writeFileSync(join(dir, 'aaa.json'), JSON.stringify({ source: 'aaa', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['gone'] }));
    writeFileSync(join(dir, 'bbb.json'), JSON.stringify({ source: 'bbb', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['gone'] }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/"aaa"[\s\S]*"bbb"[\s\S]*"gone"[\s\S]*"formerNames"/);
  });
  test('duplicate stale sidecar ids do not override distinct persisted registry ids', () => {
    const dir = scratchFolder();
    const first = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    first.store(storeInput('alpha', 'c1', DAY(1), [element('a')]));
    first.store(storeInput('beta', 'c1', DAY(1), [element('b')]));
    const before = first.heads();
    first.close();
    const alpha = JSON.parse(readFileSync(join(dir, 'alpha.json'), 'utf8')) as Record<string, unknown>;
    const beta = JSON.parse(readFileSync(join(dir, 'beta.json'), 'utf8')) as Record<string, unknown>;
    beta.id = alpha.id;
    writeFileSync(join(dir, 'beta.json'), JSON.stringify(beta));

    const second = createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });

    expect(second.heads()).toEqual(before);
    expect(JSON.parse(readFileSync(join(dir, 'beta.json'), 'utf8')).id).toBe(before.find((head) => head.source === 'beta')?.id);
    second.close();
  });
});

describe('a corrupt data folder refuses to open, naming the file', () => {
  test('a sidecar without its history file', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'aardvark.json'), JSON.stringify({ source: 'aardvark', commit: 'c1', committedAt: 1, storedAt: 2 }));
    writeFileSync(join(dir, 'lonely.json'), JSON.stringify({ source: 'lonely', commit: 'c1', committedAt: 1, storedAt: 2 }));
    let thrown: unknown;
    try {
      createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('"lonely.json" but no "lonely.sqlite" beside it');
    expect(message).toContain('"aardvark.json" but no "aardvark.sqlite" beside it');
    expect(message).toContain('; '); // collected, not stopped at the first
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

    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/holds the sources (shop, other|other, shop): a history one sidecar is to name must hold exactly that one source/);
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

    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/holds the sources other, but its sidecar ".*shop\.json" names "shop"/);
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

  test('a history file SQLite cannot open is refused naming the file and carrying the cause', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), 'this is not a SQLite database, only bytes with no header');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2 }));
    let thrown: unknown;
    try {
      createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('"shop.sqlite" cannot be opened');
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  test('a history file without its sidecar', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'bare.sqlite'), '');
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/no source it could be named from/);
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
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/its file name decodes to "shop"/);
  });

  test('a sidecar missing a field', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), '');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/shop\.json/);
  });

  test('a sidecar holding a field of the wrong shape is refused naming its file and the field', () => {
    const broken: { name: string; sidecar: Record<string, unknown>; problem: RegExp }[] = [
      { name: 'source is not a string', sidecar: { source: 42, commit: 'c1', committedAt: 1, storedAt: 2 }, problem: /"source" must be a non-empty string/ },
      { name: 'source is empty', sidecar: { source: '', commit: 'c1', committedAt: 1, storedAt: 2 }, problem: /"source" must be a non-empty string/ },
      { name: 'commit is not a string', sidecar: { source: 'shop', commit: 42, committedAt: 1, storedAt: 2 }, problem: /"commit" must be a non-empty string/ },
      { name: 'commit is empty', sidecar: { source: 'shop', commit: '', committedAt: 1, storedAt: 2 }, problem: /"commit" must be a non-empty string/ },
      { name: 'committedAt is not a number', sidecar: { source: 'shop', commit: 'c1', committedAt: '1', storedAt: 2 }, problem: /"committedAt" must be a number of epoch milliseconds/ },
      { name: 'committedAt is not finite', sidecar: { source: 'shop', commit: 'c1', committedAt: Number.NaN, storedAt: 2 }, problem: /"committedAt" must be a number of epoch milliseconds/ },
      { name: 'storedAt is not a number', sidecar: { source: 'shop', commit: 'c1', committedAt: 1, storedAt: '2' }, problem: /"storedAt" must be a number of epoch milliseconds/ },
      { name: 'storedAt is not finite', sidecar: { source: 'shop', commit: 'c1', committedAt: 1, storedAt: Number.POSITIVE_INFINITY }, problem: /"storedAt" must be a number of epoch milliseconds/ },
    ];
    for (const { name, sidecar, problem } of broken) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-'));
      try {
        writeFileSync(join(dir, 'shop.sqlite'), '');
        writeFileSync(join(dir, 'shop.json'), JSON.stringify(sidecar));
        expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), name).toThrow(problem);
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

  test('a sidecar naming a source its empty history does not hold is refused saying it holds no source', () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), ''); // a valid, empty history
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2 }));
    expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).toThrow(/holds no source, but its sidecar ".*shop\.json" names "shop"/);
  });

  test('a sidecar naming one source of a two-source history is refused naming both', () => {
    // Either source can sit first in the history's own source order, so
    // the sidecar tries each under a stem that decodes to it; whichever
    // one the history names first must still be refused, naming both.
    for (const named of ['shop', 'other']) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-two-'));
      try {
        const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-two-built-'));
        const built = createSqliteHistory({ path: join(elsewhere, 'built.sqlite'), clock: fakeClock(DAY(10)) });
        built.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
        built.store(storeInput('other', 'c1', DAY(1), [element('b')]));
        built.close();
        renameSync(join(elsewhere, 'built.sqlite'), join(dir, `${named}.sqlite`));
        rmSync(elsewhere, { recursive: true, force: true });
        writeFileSync(join(dir, `${named}.json`), JSON.stringify({ source: named, commit: 'c1', committedAt: 1, storedAt: 2 }));

        expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), named).toThrow(/holds the sources (shop, other|other, shop), but its sidecar/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a bare history file whose name was not written by this server, or names another source, is refused', () => {
    // A stem with a raw upper-case letter decodes to nothing; a stem that
    // decodes to another source than the history holds is just as alien.
    // Either way the folder was not written by this server.
    for (const stem of ['Shop.sqlite', 'other.sqlite']) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-'));
      try {
        const built = createSqliteHistory({ path: join(dir, stem), clock: fakeClock(DAY(10)) });
        built.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
        built.close();
        expect(() => createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), stem).toThrow(/does not decode to the history's source "shop"/);
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
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    second.close();
  });
});

describe('renaming a source inside a history', () => {
  test('renameSource moves every row to the new name and leaves the times as they are', () => {
    const history = createSqliteHistory({ clock: fakeClock(DAY(2)) });
    history.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    history.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
    const commitsBefore = history.commits('shop');

    history.renameSource('shop', 'renamed');

    expect(history.sources()).toEqual(['renamed']);
    expect(history.commits('renamed')).toEqual(commitsBefore);
    const early = history.read({ source: 'renamed', valid: DAY(1), known: DAY(3) });
    expect(early.model && 'elements' in early.model ? early.model.elements.map((each) => each.id) : []).toEqual(['a']);
    const late = history.read({ source: 'renamed', valid: DAY(2), known: DAY(3) });
    expect(late.model && 'elements' in late.model ? late.model.elements.map((each) => each.id) : []).toEqual(['b']);
    history.close();
  });

  test('renameSource refuses a history that holds anything but the one source being renamed, and leaves it as it was', () => {
    const history = createSqliteHistory({ clock: fakeClock(DAY(2)) });
    history.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    history.store(storeInput('other', 'c1', DAY(1), [element('b')]));

    expect(() => history.renameSource('shop', 'renamed')).toThrow(/the sources other, shop[\s\S]*"shop"[\s\S]*"renamed"/);
    expect(history.sources()).toEqual(['other', 'shop']);
    history.close();
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


import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommitRecord } from '../src/history/types.js';
import {
  createPGliteHistory,
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
    entities: [],
    scenarios: [],
    zones: [],
    environments: [],
    states: [{ id: 'as-is' }],
  };
}

function storeInput(source: string, commit: string, committedAt: number, elements: CompiledElement[]): StoreInput {
  return { source, commit, committedAt, model: model(elements) };
}

async function emptyHistory(dir: string, stem: string): Promise<void> {
  await createPGliteHistory({ path: join(dir, `${stem}.pglite`), clock: fakeClock(DAY(1)) }).close();
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
  test('a source with path separators is stored inside the folder only, never outside it', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(2));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('../../etc/passwd', 'c1', DAY(1), [element('a')]));
    await sources.close();

    expect(existsSync(join(dir, '..%2F..%2Fetc%2Fpasswd.pglite'))).toBe(true);
    expect(existsSync(join(dir, '..%2F..%2Fetc%2Fpasswd.json'))).toBe(true);
  });

  test('two names that only differ in encoding shape never share a file', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(2));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('a/b', 'c1', DAY(1), [element('a')]));
    await sources.store(storeInput('a%2Fb', 'c1', DAY(1), [element('a')]));
    await sources.close();

    expect(existsSync(join(dir, 'a%2Fb.pglite'))).toBe(true);
    expect(existsSync(join(dir, 'a%252%46b.pglite'))).toBe(true);
  });

  test('two names that differ only in case get file names that differ lower-cased, so one file cannot shadow the other', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(2));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('Acme/Shop', 'c1', DAY(1), [element('a')]));
    await sources.store(storeInput('acme/shop', 'c1', DAY(1), [element('a')]));
    await sources.close();

    // The upper-case letters are percent-encoded, so both stems hold only
    // lower-case letters, digits and escapes: a case-insensitive file
    // system still sees two different names.
    expect(existsSync(join(dir, '%41cme%2F%53hop.pglite'))).toBe(true);
    expect(existsSync(join(dir, '%41cme%2F%53hop.json'))).toBe(true);
    expect(existsSync(join(dir, 'acme%2Fshop.pglite'))).toBe(true);
    expect(existsSync(join(dir, 'acme%2Fshop.json'))).toBe(true);
    expect('%41cme%2F%53hop'.toLowerCase()).not.toBe('acme%2Fshop');
  });

  test('a file name carrying a raw upper-case letter was not written by this server and is refused', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'Acme%2FShop.pglite'), '');
    writeFileSync(join(dir, 'Acme%2FShop.json'), JSON.stringify({ source: 'Acme/Shop', commit: 'c1', committedAt: 1, storedAt: 2 }));
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/Acme%2FShop\.json/);
  });

  test('a name holding a control character is refused naming the field', async () => {
    expect(sourceNameProblem('a\nb')).toMatch(/control character/);
    expect(sourceNameProblem('a\u0000b')).toMatch(/control character/);
    expect(sourceNameProblem('a\u007Fb')).toMatch(/control character/);
    expect(sourceNameProblem('a\u009Fb')).toMatch(/control character/);
  });
});

describe('sourceNameProblem', () => {
  test('a name with separators, dots and non-ASCII letters is fine', async () => {
    expect(sourceNameProblem('../../etc/passwd')).toBeUndefined();
    expect(sourceNameProblem('github.com/shady2k/nocx')).toBeUndefined();
    expect(sourceNameProblem('github.com/ünicode/repo')).toBeUndefined();
    expect(sourceNameProblem('..')).toBeUndefined();
  });

  test('an empty or non-string name is a problem naming the field', async () => {
    expect(sourceNameProblem('')).toMatch(/source/);
    expect(sourceNameProblem(42)).toMatch(/source/);
    expect(sourceNameProblem(undefined)).toMatch(/source/);
  });

  test('a name whose file name would be too long is refused naming the limit', async () => {
    expect(sourceNameProblem('x'.repeat(201))).toMatch(/200/);
    expect(sourceNameProblem('x'.repeat(200))).toBeUndefined();
    expect(sourceNameProblem('%/'.repeat(70))).toMatch(/200/); // 140 raw bytes, 420 encoded
  });

  test('a too-long name is echoed cut to 64 code points, never whole', async () => {
    const problem = sourceNameProblem('x'.repeat(300));
    expect(problem).toMatch(/200/);
    expect(problem).toContain('x'.repeat(64));
    expect(problem).toContain('…');
    expect(problem).not.toContain('x'.repeat(65));
  });

  test('a too-long name of astral characters is echoed cut at the 64th code point, never inside one', async () => {
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
  test('a stored source is listed with its commit, commit time and storing moment, in code point order', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    clock.set(DAY(11));
    await sources.store(storeInput('zeta', 'c1', DAY(1), [element('a')]));
    clock.set(DAY(12));
    await sources.store(storeInput('alpha', 'c2', DAY(2), [element('b')]));
    await sources.close();

    expect(sources.heads()).toEqual([
      { id: expect.any(String), source: 'alpha', commit: 'c2', committedAt: DAY(2), storedAt: DAY(12) },
      { id: expect.any(String), source: 'zeta', commit: 'c1', committedAt: DAY(1), storedAt: DAY(11) },
    ]);
  });

  test('the head is the newest commit by commit time, not the latest arrival', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('shop', 'c3', DAY(3), [element('c3')]));
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('c1')])); // arrives later, is older
    await sources.close();

    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c3', committedAt: DAY(3), storedAt: DAY(10) }]);
  });

  test('commits at the same time are ordered by the commit id in code point order', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('shop', 'zzz', DAY(1), [element('a')]));
    await sources.store(storeInput('shop', 'aaa', DAY(1), [element('b')]));
    await sources.close();

    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'zzz', committedAt: DAY(1), storedAt: DAY(10) }]);
  });

  test('the first-stored commit of a tie is superseded by the bigger id, not kept', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('shop', 'aaa', DAY(1), [element('a')]));
    await sources.store(storeInput('shop', 'zzz', DAY(1), [element('b')]));
    await sources.close();

    // The second store closes the first's rows, so its own recorded
    // moment is clamped strictly past the clock's reading.
    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'zzz', committedAt: DAY(1), storedAt: DAY(10) + 1 }]);
  });

  test('a later commit time wins even when the older commit sorts the other way', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('shop', 'a9', DAY(2), [element('a')]));
    await sources.store(storeInput('shop', 'z9', DAY(1), [element('b')])); // older, though its id sorts higher
    await sources.close();

    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'a9', committedAt: DAY(2), storedAt: DAY(10) }]);
  });

  test('a sidecar write that fails after the commit was stored is healed by retrying the same commit', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));

    // Sabotage at the file-system boundary: the sidecar's own temporary
    // path is a folder, so the history stores the commit and the sidecar
    // write then fails.
    mkdirSync(join(dir, 'shop.json.tmp'));
    await expect(sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).rejects.toThrow();
    rmdirSync(join(dir, 'shop.json.tmp'));

    clock.set(DAY(20));

    const retry = await sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
    expect(retry.wasNew).toBe(false);
    expect(retry.result.errors).toEqual([]);
    // The repaired head carries the original c2 store's own moment,
    // held by the history's commit row — not the retry's later clock.
    // The first c2 store closed c1's row, so its recorded moment was
    // clamped 1 ms past the then-frozen clock.
    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    await sources.close();
  });
  test('retrying the first send after a sidecar failure keeps the committed registry id', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    mkdirSync(join(dir, 'shop.json.tmp'));
    const input = storeInput('shop', 'c1', DAY(1), [element('a')]);
    await expect(sources.store(input)).rejects.toThrow();
    const id = (await sources.historyOf('shop').registry('shop'))?.id;
    expect(id).toEqual(expect.any(String));
    rmdirSync(join(dir, 'shop.json.tmp'));

    await sources.store(input);

    expect(sources.heads()).toEqual([{ id: id!, source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    await sources.close();
  });
  test('a registry write failure rolls back the commit that needs that identity', async () => {
    const dir = scratchFolder();
    const seeded = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await seeded.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await seeded.close();
    const database = new PGlite(join(dir, 'shop.pglite'));
    await database.waitReady;
    // Remove the row so startup repairs it with INSERT; the failure should
    // occur only on the next store's UPDATE, not during startup repair.
    await database.query("DELETE FROM source_registry WHERE source = 'shop'");
    await database.exec(`CREATE FUNCTION fail_registry_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registry write failed'; END $$;
      CREATE TRIGGER fail_registry_write BEFORE UPDATE ON source_registry FOR EACH ROW EXECUTE FUNCTION fail_registry_write()`);
    await database.close();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const history = sources.historyOf('shop');

    const result = await sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]));

    expect(result.result.errors).toHaveLength(1);
    expect(await history.hasCommit('shop', 'c2')).toBe(false);
    expect(await history.registry('shop')).toEqual({ id: expect.any(String), formerNames: [] });
    await sources.close();
  });

  test('a store reads the commit\'s own row, never the source\'s whole history', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
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
    await sources.store(storeInput('shop', 'c3', DAY(3), [element('c')]));
    await sources.close();

    expect(commitLists).toBe(0);
    expect(sources.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c3', committedAt: DAY(3), storedAt: DAY(11) }]);
  });

  test('a repeat store changes nothing', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const before = sources.heads();
    const repeat = await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await sources.close();

    expect(repeat.wasNew).toBe(false);
    expect(repeat.result.errors).toEqual([]);
    expect(sources.heads()).toEqual(before);
  });

  test('close waits for a store already in flight before closing its history', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const history = sources.historyOf('shop');
    const originalStore = history.store.bind(history);
    let started!: () => void;
    let release!: () => void;
    const storeStarted = new Promise<void>((resolve) => { started = resolve; });
    const holdStore = new Promise<void>((resolve) => { release = resolve; });
    history.store = async (input, registry) => {
      started();
      await holdStore;
      return originalStore(input, registry);
    };

    const pendingStore = sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await storeStarted;
    const pendingClose = sources.close();
    release();
    const [result] = await Promise.all([pendingStore, pendingClose]);

    expect(result!.wasNew).toBe(true);
    expect(result!.result.errors).toEqual([]);
  });

  test('concurrent repeats of one commit are serialized: only the first reports it new', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const input = storeInput('shop', 'c1', DAY(1), [element('a')]);

    const results = await Promise.all([sources.store(input), sources.store(input)]);
    const records = await sources.historyOf('shop').commits('shop');
    await sources.close();

    expect(results.map((result) => result.wasNew).sort()).toEqual([false, true]);
    expect(results.every((result) => result.result.errors.length === 0)).toBe(true);
    expect(records.map((record) => record.commit)).toEqual(['c1']);
  });

  test('store reports whether the commit was new', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const first = await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await sources.close();
    expect(first.wasNew).toBe(true);
  });
});

describe('restart on the same data folder', () => {
  test('the sources are known again with the same heads', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const first = await createSourceStores({ dataFolder: dir, clock });
    await first.store(storeInput('github.com/shady2k/nocx', 'c1', DAY(1), [element('a')]));
    await first.store(storeInput('github.com/acme/shop', 'c2', DAY(2), [element('b')]));
    const before = first.heads();
    await first.close();

    const second = await createSourceStores({ dataFolder: dir, clock });
    const after = second.heads();
    await second.close();

    expect(after).toEqual(before);
  });

  test('a history keeps storing after the restart', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const first = await createSourceStores({ dataFolder: dir, clock });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.close();

    const second = await createSourceStores({ dataFolder: dir, clock });
    const store = await second.store(storeInput('shop', 'c2', DAY(2), [element('a'), element('b')]));
    expect(store.wasNew).toBe(true);
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) }]);

    const history: HistoryStore = second.historyOf('shop');
    const read = await history.read({ source: 'shop', valid: DAY(2), known: DAY(10) });
    expect(read.errors).toEqual([]);
    expect(read.model && 'elements' in read.model ? read.model.elements.map((e) => e.id) : []).toEqual(['a', 'b']);
    await second.close();
  });

  test('a missing sidecar is rebuilt from history without changing identity or retired names', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = first.heads()[0]!.id;
    await first.rename(id, 'renamed');
    await first.close();
    rmSync(join(dir, 'renamed.json'));

    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()).toEqual([{ id, source: 'renamed', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(second.retiredHead('shop')?.id).toBe(id);
    await expect(second.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).rejects.toThrow(/renamed/);
    await second.close();
  });
  test('two missing sidecars rebuild distinct persisted identities at startup', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('alpha', 'c1', DAY(1), [element('a')]));
    await first.store(storeInput('beta', 'c1', DAY(1), [element('b')]));
    const before = first.heads();
    await first.close();
    rmSync(join(dir, 'alpha.json'));
    rmSync(join(dir, 'beta.json'));

    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()).toEqual(before);
    expect(second.heads()[0]?.id).not.toBe(second.heads()[1]?.id);
    await second.close();
  });

  test('a restart repairs a stale sidecar from the history, and logs it', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    mkdirSync(join(dir, 'shop.json.tmp')); // the sidecar write for c2 fails
    await expect(first.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).rejects.toThrow();
    rmdirSync(join(dir, 'shop.json.tmp'));
    await first.close(); // the sidecar on disk still names c1

    const lines: string[] = [];
    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    expect(lines.join('\n')).toContain('repaired');
    await second.close();
  });

  test('a sidecar whose storing moment disagrees is repaired, even when the commit and its time agree', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.close();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(9) }));

    const lines: string[] = [];
    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { storedAt: number };
    expect(sidecar.storedAt).toBe(DAY(10));
    expect(lines.join('\n')).toContain('repaired');
    await second.close();
  });

  test('a sidecar naming another commit is repaired, even when the storing moment agrees', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    // c2 asserts what c1 already had, so it opens no row and is recorded
    // at the same frozen moment: the two commits share their storedAt.
    await first.store(storeInput('shop', 'c2', DAY(2), [element('a')]));
    await first.close();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }));

    const lines: string[] = [];
    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { commit: string };
    expect(sidecar.commit).toBe('c2');
    expect(lines.join('\n')).toContain('repaired');
    await second.close();
  });
  test('a stale sidecar formerNames list is repaired from the registry', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.rename(first.heads()[0]!.id, 'renamed');
    await first.close();
    const sidecar = JSON.parse(readFileSync(join(dir, 'renamed.json'), 'utf8')) as Record<string, unknown>;
    sidecar.formerNames = [];
    writeFileSync(join(dir, 'renamed.json'), JSON.stringify(sidecar));

    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });

    expect(JSON.parse(readFileSync(join(dir, 'renamed.json'), 'utf8')).formerNames).toEqual(['shop']);
    expect(second.retiredHead('shop')?.source).toBe('renamed');
    await second.close();
  });

  test('a sidecar whose commit time disagrees is repaired, even when the commit and its storing moment agree', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.close();
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(5), storedAt: DAY(10) }));

    const lines: string[] = [];
    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { committedAt: number };
    expect(sidecar.committedAt).toBe(DAY(1));
    expect(lines.join('\n')).toContain('repaired');
    await second.close();
  });

  test('a restart with an agreeing sidecar changes nothing and logs no repair', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.close();

    const lines: string[] = [];
    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(lines.join('\n')).not.toContain('repaired');
    await second.close();
  });
});

describe('source ids', () => {
  test('the first send assigns the source an id, and the name plays no part in it', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });

    await sources.store(storeInput('github.com/shady2k/nocx', 'c1', DAY(1), [element('a')]));
    const head = sources.heads()[0]!;
    await sources.close();

    expect(head.id).toEqual(expect.any(String));
    expect(head.id.length).toBeGreaterThan(0);
    expect(head.id).not.toBe(head.source);
    expect(head.id).not.toContain(head.source);
  });

  test('further sends of the same source keep its id', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const first = sources.heads()[0]!.id;

    await sources.store(storeInput('shop', 'c2', DAY(2), [element('a'), element('b')]));
    await sources.close();

    expect(sources.heads()).toHaveLength(1);
    expect(sources.heads()[0]!.id).toBe(first);
    expect(sources.heads()[0]!.commit).toBe('c2');
  });

  test('a restart on the same data folder keeps the id, which the sidecar beside the history holds', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = first.heads()[0]!.id;
    await first.close();

    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { id: unknown };
    expect(sidecar.id).toBe(id);

    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()[0]!.id).toBe(id);
    await second.close();
  });

  test('two different sources hold different ids', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('github.com/a/first', 'c1', DAY(1), [element('a')]));
    await sources.store(storeInput('github.com/b/second', 'c1', DAY(1), [element('a')]));
    const heads = sources.heads();
    await sources.close();

    expect(heads[0]!.id).not.toBe(heads[1]!.id);
  });

  test('a data folder from before the ids existed: every source gets an id at start, and no stored answer changes', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('github.com/shady2k/nocx', 'c2', DAY(2), [element('b')]));
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const before = first.heads().map(({ id: _id, ...rest }) => rest);
    const commitsBefore: Record<string, CommitRecord[]> = {};
    for (const head of first.heads()) commitsBefore[head.source] = await first.historyOf(head.source).commits(head.source);
    await first.close();

    // The folder as an older server left it: sidecars without an id.
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.endsWith('.json.tmp')) continue;
      const sidecar = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      delete sidecar.id;
      writeFileSync(join(dir, name), JSON.stringify(sidecar));
    }

    const lines: string[] = [];
    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)), log: (line) => lines.push(line) });
    const heads = second.heads();
    expect(heads.map(({ id: _id, ...rest }) => rest)).toEqual(before);
    for (const head of heads) {
      expect(head.id.length).toBeGreaterThan(0);
      const commitsOf = commitsBefore[head.source];
      if (commitsOf === undefined) throw new Error(`the test took no snapshot of the commits of "${head.source}"`);
      expect(await second.historyOf(head.source).commits(head.source)).toEqual(commitsOf);
    }
    expect(lines.join('\n')).toContain('assigned the source id');
    await second.close();
  });

  test('a restart that repairs a stale sidecar keeps the id the sidecar held', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.store(storeInput('shop', 'c2', DAY(2), [element('a')]));
    const id = first.heads()[0]!.id;
    await first.close();
    // The sidecar an interrupted write left behind: the older head, the id included.
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10), id }));

    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const head = second.heads()[0]!;
    expect(head.commit).toBe('c2');
    expect(head.id).toBe(id);
    await second.close();
  });

  test('a sidecar whose id is not a non-empty string refuses to open, naming the file and the field', async () => {
    for (const bad of [7, '']) {
      const dir = scratchFolder();
      const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
      await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
      await first.close();
      writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10), id: bad }));

      await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) })).rejects.toThrow(new RegExp(`shop\\.json[\\s\\S]*"id"[\\s\\S]*non-empty string`));
    }
  });
});

describe('a rename claim on the stores', () => {
  test('the id, the head and the history survive the rename; the files move to the new name', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
    const id = sources.heads()[0]!.id;
    const commitsBefore = await sources.historyOf('shop').commits('shop');
    const readBefore = await sources.historyOf('shop').read({ source: 'shop', valid: DAY(2), known: DAY(20) });

    expect(await sources.rename(id, 'github.com/shady2k/nocx')).toEqual({ formerSource: 'shop' });

    // c2 closed c1's rows, so its own recorded moment sits 1 ms past the
    // frozen clock; the rename leaves it exactly as it was.
    expect(sources.heads()).toEqual([{ id, source: 'github.com/shady2k/nocx', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    expect(existsSync(join(dir, 'github.com%2Fshady2k%2Fnocx.pglite'))).toBe(true);
    expect(existsSync(join(dir, 'github.com%2Fshady2k%2Fnocx.json'))).toBe(true);
    expect(existsSync(join(dir, 'shop.pglite'))).toBe(false);
    expect(existsSync(join(dir, 'shop.json'))).toBe(false);

    const history = sources.historyOf('github.com/shady2k/nocx');
    expect(await history.commits('github.com/shady2k/nocx')).toEqual(commitsBefore);
    expect(await history.read({ source: 'github.com/shady2k/nocx', valid: DAY(2), known: DAY(20) })).toEqual(readBefore);
    await sources.close();
  });

  test('the old name is retired: a store reached with it is a caller defect naming the rename, and retiredHead answers the new head', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    await sources.rename(id, 'moved');

    expect(sources.retiredHead('shop')?.source).toBe('moved');
    expect(sources.retiredHead('never-named')).toBeUndefined();
    await expect(sources.store(storeInput('shop', 'c2', DAY(2), [element('b')]))).rejects.toThrow(/refused first[\s\S]*"shop"[\s\S]*"moved"/);
    await sources.close();
  });

  test('a rename to a name another source holds is refused naming both, and nothing moves', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await sources.store(storeInput('other', 'c1', DAY(1), [element('b')]));
    const shopId = sources.heads().find((head) => head.source === 'shop')!.id;
    const before = sources.heads();

    await expect(sources.rename(shopId, 'other')).rejects.toThrow(/the name "other" is already the name of the source with id "[^"]*"/);
    expect(sources.heads()).toEqual(before);
    expect(existsSync(join(dir, 'shop.pglite'))).toBe(true);
    await sources.close();
  });

  test('a rename reached with an id no source holds is a caller defect naming it', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await expect(sources.rename('no-such-id', 'x')).rejects.toThrow(/no-such-id/);
    await sources.close();
  });

  test('former names are kept in the sidecar, sorted, and a restart retires them again', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    await sources.rename(id, 'bbb');
    await sources.rename(id, 'aaa');
    await sources.close();

    const sidecar = JSON.parse(readFileSync(join(dir, 'aaa.json'), 'utf8')) as { formerNames: unknown };
    expect(sidecar.formerNames).toEqual(['bbb', 'shop']);

    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(second.heads()).toEqual([{ id, source: 'aaa', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(second.retiredHead('shop')?.source).toBe('aaa');
    expect(second.retiredHead('bbb')?.source).toBe('aaa');
    await expect(second.store(storeInput('bbb', 'c2', DAY(2), [element('b')]))).rejects.toThrow(/refused first/);
    await second.close();
  });

  test('renaming back to a former name retires the middle names and keeps every former name explained', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    await sources.rename(id, 'bbb');
    await sources.rename(id, 'aaa');
    await sources.rename(id, 'shop');

    expect(sources.heads()).toEqual([{ id, source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    expect(sources.retiredHead('aaa')?.source).toBe('shop');
    expect(sources.retiredHead('bbb')?.source).toBe('shop');
    expect(sources.retiredHead('shop')).toBeUndefined();
    await expect(sources.store(storeInput('aaa', 'c2', DAY(2), [element('b')]))).rejects.toThrow(/refused first/);
    await sources.close();

    const sidecar = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as { formerNames: unknown };
    expect(sidecar.formerNames).toEqual(['aaa', 'bbb']);
  });
  test('a failed registry row rename restores the original sidecar and old history name', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    const originalSidecar = readFileSync(join(dir, 'shop.json'));
    await sources.close();
    const database = new PGlite(join(dir, 'shop.pglite'));
    await database.waitReady;
    await database.exec(`CREATE FUNCTION fail_source_rename() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rename failed'; END $$;
      CREATE TRIGGER fail_source_rename BEFORE UPDATE OF source ON source_commits FOR EACH ROW EXECUTE FUNCTION fail_source_rename()`);
    await database.close();
    const restarted = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });

    await expect(restarted.rename(id, 'renamed')).rejects.toThrow(/rename failed/);

    expect(restarted.heads().map((head) => head.source)).toEqual(['shop']);
    expect(existsSync(join(dir, 'shop.pglite'))).toBe(true);
    expect(existsSync(join(dir, 'renamed.pglite'))).toBe(false);
    expect(readFileSync(join(dir, 'shop.json'))).toEqual(originalSidecar);
    expect(await restarted.historyOf('shop').sources()).toEqual(['shop']);
    await restarted.close();
  });
  test('a sidecar failure after rename commits keeps the identity through retry and restart', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const id = sources.heads()[0]!.id;
    mkdirSync(join(dir, 'renamed.json.tmp'));

    await expect(sources.rename(id, 'renamed')).rejects.toThrow();
    expect(sources.heads().map((head) => head.source)).toEqual(['renamed']);
    expect((await sources.historyOf('renamed').registry('renamed'))?.id).toBe(id);
    rmdirSync(join(dir, 'renamed.json.tmp'));

    const retry = await sources.store(storeInput('renamed', 'c2', DAY(2), [element('b')]));
    expect(retry.result.errors).toEqual([]);
    expect(sources.heads()).toEqual([{ id, source: 'renamed', commit: 'c2', committedAt: DAY(2), storedAt: DAY(10) + 1 }]);
    await sources.close();

    const restarted = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(restarted.heads()[0]?.id).toBe(id);
    expect(restarted.retiredHead('shop')?.source).toBe('renamed');
    expect(restarted.heads()).toHaveLength(1);
    await restarted.close();
  });

  test('a sidecar whose former names are not an array of non-empty strings is refused naming the file and the field', async () => {
    for (const formerNames of ['shop', [42], [''], ['shop', 'shop']]) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-former-'));
      try {
        writeFileSync(join(dir, 'shop.pglite'), '');
        writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2, formerNames }));
        await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), JSON.stringify(formerNames)).rejects.toThrow(
          new RegExp(`shop\\.json[\\s\\S]*"formerNames"`),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a sidecar naming its own current name among its former names is refused naming the file', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.pglite'), '');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['shop'] }));
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/shop\.json[\s\S]*"formerNames"[\s\S]*"shop"/);
  });

  /** A real one-source history planted in the folder under a stem, as only this server writes them. */
  async function plantedHistory(dir: string, stem: string, source: string): Promise<void> {
    const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-plant-'));
    const built = createPGliteHistory({ path: join(elsewhere, `${stem}.pglite`), clock: fakeClock(DAY(10)) });
    await built.store(storeInput(source, 'c1', DAY(1), [element('a')]));
    await built.close();
    renameSync(join(elsewhere, `${stem}.pglite`), join(dir, `${stem}.pglite`));
    rmSync(elsewhere, { recursive: true, force: true });
  }

  test('a restart refuses a folder where one source\'s former name is another source\'s name, naming both', async () => {
    const dir = scratchFolder();
    await plantedHistory(dir, 'aaa', 'aaa');
    await plantedHistory(dir, 'taken', 'taken');
    writeFileSync(join(dir, 'aaa.json'), JSON.stringify({ source: 'aaa', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['taken'] }));
    writeFileSync(join(dir, 'taken.json'), JSON.stringify({ source: 'taken', commit: 'c1', committedAt: 1, storedAt: 2 }));
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(
      /"formerNames" naming "taken"[\s\S]*is the current name of the source beside it/,
    );
  });

  test('a restart refuses a folder where two sources hold the same former name, naming both', async () => {
    const dir = scratchFolder();
    await plantedHistory(dir, 'aaa', 'aaa');
    await plantedHistory(dir, 'bbb', 'bbb');
    writeFileSync(join(dir, 'aaa.json'), JSON.stringify({ source: 'aaa', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['gone'] }));
    writeFileSync(join(dir, 'bbb.json'), JSON.stringify({ source: 'bbb', commit: 'c1', committedAt: 1, storedAt: 2, formerNames: ['gone'] }));
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/"aaa"[\s\S]*"bbb"[\s\S]*"gone"[\s\S]*"formerNames"/);
  });
  test('duplicate stale sidecar ids do not override distinct persisted registry ids', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('alpha', 'c1', DAY(1), [element('a')]));
    await first.store(storeInput('beta', 'c1', DAY(1), [element('b')]));
    const before = first.heads();
    await first.close();
    const alpha = JSON.parse(readFileSync(join(dir, 'alpha.json'), 'utf8')) as Record<string, unknown>;
    const beta = JSON.parse(readFileSync(join(dir, 'beta.json'), 'utf8')) as Record<string, unknown>;
    beta.id = alpha.id;
    writeFileSync(join(dir, 'beta.json'), JSON.stringify(beta));

    const second = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });

    expect(second.heads()).toEqual(before);
    expect(JSON.parse(readFileSync(join(dir, 'beta.json'), 'utf8')).id).toBe(before.find((head) => head.source === 'beta')?.id);
    await second.close();
  });
});

describe('a corrupt data folder refuses to open, naming the file', () => {
  test('a registry id with a non-string PGlite value refuses before rewriting the sidecar', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.close();
    const sidecar = readFileSync(join(dir, 'shop.json'));
    const database = new PGlite(join(dir, 'shop.pglite'));
    await database.waitReady;
    await database.query("UPDATE source_registry SET id = '' WHERE source = 'shop'");
    await database.close();

    let thrown: unknown;
    try {
      await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain(join(dir, 'shop.pglite'));
    expect(message).toContain('source_registry.id');
    expect(message).toContain('value');
    expect(readFileSync(join(dir, 'shop.json'))).toEqual(sidecar);
  });

  test('registry formerNames containing its current source refuses before rewriting the sidecar', async () => {
    const dir = scratchFolder();
    const first = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await first.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await first.close();
    const sidecar = readFileSync(join(dir, 'shop.json'));
    const database = new PGlite(join(dir, 'shop.pglite'));
    await database.waitReady;
    await database.query('UPDATE source_registry SET former_names = $1 WHERE source = $2', [JSON.stringify(['shop']), 'shop']);
    await database.close();

    let thrown: unknown;
    try {
      await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain(join(dir, 'shop.pglite'));
    expect(message).toContain('source_registry.former_names');
    expect(message).toContain('"shop"');
    expect(readFileSync(join(dir, 'shop.json'))).toEqual(sidecar);
  });
  test('a sidecar without its history file', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'aardvark.json'), JSON.stringify({ source: 'aardvark', commit: 'c1', committedAt: 1, storedAt: 2 }));
    writeFileSync(join(dir, 'lonely.json'), JSON.stringify({ source: 'lonely', commit: 'c1', committedAt: 1, storedAt: 2 }));
    let thrown: unknown;
    try {
      await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('"lonely.json" but no "lonely.pglite" beside it');
    expect(message).toContain('"aardvark.json" but no "aardvark.pglite" beside it');
    expect(message).toContain('; '); // collected, not stopped at the first
  });

  test('a history holding more than one source cannot be named by one file and is refused naming it', async () => {
    const dir = scratchFolder();
    const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-multi-'));
    const built = createPGliteHistory({ path: join(elsewhere, 'built.pglite'), clock: fakeClock(DAY(10)) });
    await built.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await built.store(storeInput('other', 'c1', DAY(1), [element('b')]));
    await built.close();
    renameSync(join(elsewhere, 'built.pglite'), join(dir, 'multi.pglite'));
    rmSync(elsewhere, { recursive: true, force: true });

    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/holds the sources (shop, other|other, shop): a history one sidecar is to name must hold exactly that one source/);
  });

  test('a sidecar naming a source its history does not hold is refused naming both files', async () => {
    const dir = scratchFolder();
    const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-foreign-'));
    const built = createPGliteHistory({ path: join(elsewhere, 'built.pglite'), clock: fakeClock(DAY(10)) });
    await built.store(storeInput('other', 'c1', DAY(1), [element('b')]));
    await built.close();
    renameSync(join(elsewhere, 'built.pglite'), join(dir, 'shop.pglite'));
    rmSync(elsewhere, { recursive: true, force: true });
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2 }));

    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/holds the sources other, but its sidecar ".*shop\.json" names "shop"/);
  });

  test('the refusal about an unreadable folder carries the file-system error as its cause', async () => {
    const dir = join(scratchFolder(), 'missing');
    let thrown: unknown;
    try {
      await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/ENOENT|no such file|not exist/i);
  });

  test('the refusal about a sidecar that is not JSON carries the parse error as its cause', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.pglite'), '');
    writeFileSync(join(dir, 'shop.json'), '{not json');
    let thrown: unknown;
    try {
      await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
  });

  test('a history directory PGlite cannot open is refused naming the file and carrying the cause', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.pglite'), 'this is not a PGlite database, only bytes with no header');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2 }));
    let thrown: unknown;
    try {
      await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain(join(dir, 'shop.pglite'));
    expect((thrown as Error).message).toContain('cannot be opened');
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  test('a history file without its sidecar', async () => {
    const dir = scratchFolder();
    await emptyHistory(dir, 'bare');
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/no source it could be named from/);
  });

  test('a sidecar that is not valid JSON', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.pglite'), '');
    writeFileSync(join(dir, 'shop.json'), '{not json');
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/shop\.json/);
  });

  test('a sidecar whose source does not match its file name', async () => {
    const dir = scratchFolder();
    await emptyHistory(dir, 'shop');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'other', commit: 'c1', committedAt: 1, storedAt: 2 }));
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/its file name decodes to "shop"/);
  });

  test('a sidecar missing a field', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.pglite'), '');
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', storedAt: 2 }));
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/shop\.json/);
  });

  test('a sidecar holding a field of the wrong shape is refused naming its file and the field', async () => {
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
        writeFileSync(join(dir, 'shop.pglite'), '');
        writeFileSync(join(dir, 'shop.json'), JSON.stringify(sidecar));
        await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), name).rejects.toThrow(problem);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a file name this server never writes is refused, even when the sidecar matches what it would decode to', async () => {
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
        writeFileSync(join(dir, `${stem}.pglite`), '');
        writeFileSync(join(dir, `${stem}.json`), JSON.stringify({ source, commit: 'c1', committedAt: 1, storedAt: 2 }));
        await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), stem).rejects.toThrow(/does not decode to a source name/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a sidecar naming a source its empty history does not hold is refused saying it holds no source', async () => {
    const dir = scratchFolder();
    await emptyHistory(dir, 'shop'); // a valid, empty history
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ source: 'shop', commit: 'c1', committedAt: 1, storedAt: 2 }));
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/holds no source, but its sidecar ".*shop\.json" names "shop"/);
  });

  test('a sidecar naming one source of a two-source history is refused naming both', async () => {
    // Either source can sit first in the history's own source order, so
    // the sidecar tries each under a stem that decodes to it; whichever
    // one the history names first must still be refused, naming both.
    for (const named of ['shop', 'other']) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-two-'));
      try {
        const elsewhere = mkdtempSync(join(tmpdir(), 'madarch-server-sources-two-built-'));
        const built = createPGliteHistory({ path: join(elsewhere, 'built.pglite'), clock: fakeClock(DAY(10)) });
        await built.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
        await built.store(storeInput('other', 'c1', DAY(1), [element('b')]));
        await built.close();
        renameSync(join(elsewhere, 'built.pglite'), join(dir, `${named}.pglite`));
        rmSync(elsewhere, { recursive: true, force: true });
        writeFileSync(join(dir, `${named}.json`), JSON.stringify({ source: named, commit: 'c1', committedAt: 1, storedAt: 2 }));

        await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), named).rejects.toThrow(/holds the sources (shop, other|other, shop), but its sidecar/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a bare history file whose name was not written by this server, or names another source, is refused', async () => {
    // A stem with a raw upper-case letter decodes to nothing; a stem that
    // decodes to another source than the history holds is just as alien.
    // Either way the folder was not written by this server.
    for (const stem of ['Shop.pglite', 'other.pglite']) {
      const dir = mkdtempSync(join(tmpdir(), 'madarch-server-sources-'));
      try {
        const built = createPGliteHistory({ path: join(dir, stem), clock: fakeClock(DAY(10)) });
        await built.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
        await built.close();
        await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) }), stem).rejects.toThrow(/does not decode to the history's source "shop"/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('the data folder itself', () => {
  test('a folder that does not exist is refused, naming the path', async () => {
    const dir = join(scratchFolder(), 'missing');
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/missing/);
  });

  test('a path that is a file, not a folder, is refused naming the path', async () => {
    const dir = scratchFolder();
    const filePath = join(dir, 'afile');
    writeFileSync(filePath, '');
    await expect(createSourceStores({ dataFolder: filePath, clock: fakeClock(DAY(1)) })).rejects.toThrow(/afile.*is not a folder|is not a folder.*afile/s);
  });

  test('a legacy SQLite history is refused instead of being silently ignored', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'shop.sqlite'), 'legacy history');
    await expect(createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(1)) })).rejects.toThrow(/SQLite histories are not migrated to PGlite.*sending its source models again/);
  });

  test('stray files that are not histories or sidecars are ignored', async () => {
    const dir = scratchFolder();
    writeFileSync(join(dir, 'README.md'), 'notes');
    writeFileSync(join(dir, 'shop.json.tmp'), 'leftover');
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(sources.heads()).toEqual([]);
    await sources.close();
  });
});

describe('the history behind a source', () => {
  test('one history per source, reused across calls', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    const first = sources.historyOf('shop');
    const second = sources.historyOf('shop');
    expect(first).toBe(second);
    const other = sources.historyOf('other');
    expect(other).not.toBe(first);
    await sources.close();
  });

  test('a source that was never sent is not in the heads', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    expect(sources.heads()).toEqual([]);
    await sources.close();
  });

  test('a refused store leaves the head alone', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await sources.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    const before = sources.heads();

    const refused = await sources.store(storeInput('shop', 'c1', DAY(9), [element('different')]));
    await sources.close();

    expect(refused.result.errors).toHaveLength(1);
    expect(refused.result.errors[0]!.id).toBe('c1');
    expect(sources.heads()).toEqual(before);
  });

  test('a store reached with a name that must be refused first throws as a caller defect', async () => {
    const dir = scratchFolder();
    const sources = await createSourceStores({ dataFolder: dir, clock: fakeClock(DAY(10)) });
    await expect(sources.store(storeInput('a\nb', 'c1', DAY(1), [element('a')]))).rejects.toThrow(/refused first/);
    await sources.close();
  });

  test('a model with no assertions at all still stores, and the restart reads its sidecar', async () => {
    const dir = scratchFolder();
    const clock = fakeClock(DAY(10));
    const sources = await createSourceStores({ dataFolder: dir, clock });

    const stored = await sources.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: { ...model([]), states: [] } });
    expect(stored.result.errors).toEqual([]);
    expect(stored.result.opened).toEqual([]);
    await sources.close();

    const second = await createSourceStores({ dataFolder: dir, clock });
    expect(second.heads()).toEqual([{ id: expect.any(String), source: 'shop', commit: 'c1', committedAt: DAY(1), storedAt: DAY(10) }]);
    await second.close();
  });
});

describe('renaming a source inside a history', () => {
  test('renameSource moves every row to the new name and leaves the times as they are', async () => {
    const history = createPGliteHistory({ clock: fakeClock(DAY(2)) });
    await history.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await history.store(storeInput('shop', 'c2', DAY(2), [element('b')]));
    const commitsBefore = await history.commits('shop');

    await history.renameSource('shop', 'renamed');

    expect(await history.sources()).toEqual(['renamed']);
    expect(await history.commits('renamed')).toEqual(commitsBefore);
    const early = await history.read({ source: 'renamed', valid: DAY(1), known: DAY(3) });
    expect(early.model && 'elements' in early.model ? early.model.elements.map((each) => each.id) : []).toEqual(['a']);
    const late = await history.read({ source: 'renamed', valid: DAY(2), known: DAY(3) });
    expect(late.model && 'elements' in late.model ? late.model.elements.map((each) => each.id) : []).toEqual(['b']);
    await history.close();
  });

  test('renameSource refuses a history that holds anything but the one source being renamed, and leaves it as it was', async () => {
    const history = createPGliteHistory({ clock: fakeClock(DAY(2)) });
    await history.store(storeInput('shop', 'c1', DAY(1), [element('a')]));
    await history.store(storeInput('other', 'c1', DAY(1), [element('b')]));

    await expect(history.renameSource('shop', 'renamed')).rejects.toThrow(/the sources other, shop[\s\S]*"shop"[\s\S]*"renamed"/);
    expect(await history.sources()).toEqual(['other', 'shop']);
    await history.close();
  });
});

describe('an in-memory history still works beside the file-backed ones', () => {
  test('createPGliteHistory without a path is unaffected', async () => {
    const history = createPGliteHistory({ clock: fakeClock(DAY(2)) });
    await history.store({ source: 'shop', commit: 'c1', committedAt: DAY(1), model: model([element('a')]) });
    expect(await history.sources()).toEqual(['shop']);
    await history.close();
  });
});


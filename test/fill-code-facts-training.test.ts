/**
 * The two per-file facts against the extract driver's own answers on the
 * generated training repository (madarch-8bdc.2.4, step 1 of the port's
 * prerequisites): for every file, the unit `serviceUnits(tree)` gives it; for
 * every source file, the ports the contracts extractor's `portsByService` map
 * is built from. The test compares the facts the fill's readers answer with
 * the driver's, and expects zero differences.
 *
 * The repository is the one `examples/training-repository/generate.mjs` makes —
 * four services with manifests at their folders, Go and TypeScript servers, and
 * one TypeScript test file that listens on port 0 — so the comparison is the
 * project's own fixture and no outside checkout. The rules the port fact and
 * the driver share stand in `src/extract/contracts/listening-ports.ts`; what
 * this test pins is that the per-file reading of the tree, and the unit a path
 * belongs to, answer what the driver answers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { listeningPortsOfTree } from '../src/fill/stages/listening-ports.js';
import { serviceMembershipOf, type ManifestEntry } from '../src/fill/stages/service-membership.js';
import { staticStageSourceOf, STATIC_FILE_BYTE_LIMIT, type StaticStageSource } from '../src/fill/stages/static-context.js';
import { readFileFindings, readSyntaxTree } from '../src/fill/stages/syntax-extract.js';
import { callablesOfFile } from '../src/fill/stages/file-facts.js';
import { collectFileFacts } from '../src/fill/stages/file-facts.js';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { readGoFile, type GoFileFacts } from '../src/extract/contracts/go-code.js';
import { goListeningPorts, portsByServiceOf, tsListeningPorts, type CodeFilePortFacts } from '../src/extract/contracts/listening-ports.js';
import { readTsFile, type TsFileFacts } from '../src/extract/contracts/ts-code.js';
import { serviceUnits, unitIndex, unitOfPath } from '../src/extract/service-units.js';
import { rolesFor } from '../src/fill/stages/inventory.js';

const GENERATOR = fileURLToPath(new URL('../examples/training-repository/generate.mjs', import.meta.url));

let root = '';
let repository = '';
let source: StaticStageSource | undefined;
let paths: readonly string[] = [];
let tree: { readonly paths: readonly string[]; readonly read: (path: string) => Uint8Array } | undefined;

/** The source paths of the repository, by the inventory's own role: what the code-facts stage reads. */
function isCodePath(path: string): boolean {
  return rolesFor(path).includes('source') && /\.(?:go|ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path);
}

/** One manifest above a file, read through the static source one path at a time. */
async function lookup(candidate: string): Promise<ManifestEntry | undefined> {
  if (source === undefined) throw new Error('the static source was not opened');
  const entry = await source.entry(candidate);
  if (entry === undefined || entry.form === 'commit') return undefined;
  if (entry.bytes !== undefined && entry.bytes > STATIC_FILE_BYTE_LIMIT) return { path: candidate, blob: entry.id };
  const file = await source.file(candidate);
  return { path: candidate, blob: entry.id, ...(file?.content === undefined ? {} : { bytes: file.content }) };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-facts-training-'));
  repository = join(root, 'training');
  execFileSync('node', [GENERATOR, repository], { stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  source = await staticStageSourceOf(createGitSnapshotSource([{ id: 'training', form: 'code', root: repository, commit }]), 'training');
  const walk = (folder: string, prefix = ''): string[] => readdirSync(join(folder, prefix)).flatMap((name) => {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(join(folder, relative)).isDirectory()) return name === '.git' ? [] : walk(folder, relative);
    return [relative];
  });
  paths = walk(repository).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const bytes = new Map<string, Uint8Array>(paths.map((path) => [path, new Uint8Array(readFileSync(join(repository, path)))]));
  tree = {
    paths,
    read(path: string): Uint8Array {
      const held = bytes.get(path);
      if (held === undefined) throw new Error(`${repository}/${path} is no file of the generated repository`);
      return held;
    },
  };
}, 300_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** One difference between a fact and the driver's answer, named with both. */
interface Difference {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

/** The fields of a membership as one text, so a difference names both answers whole. */
function membershipText(unit: { readonly name: string; readonly root: string; readonly manifestPath: string | null; readonly ecosystem: string; readonly declared: string } | undefined): string {
  return unit === undefined ? 'none' : `${unit.name}@${unit.root} (${unit.ecosystem}, ${unit.declared}, ${unit.manifestPath})`;
}

describe('the one port rule the driver and the fill share', () => {
  test('reads no port from a Go address that carries none, and keeps the ports of the addresses that do', () => {
    // The rule is the driver's own (`portsByService` calls it): an address without a port names none,
    // and a constant that holds one is read through the constant.
    const go = {
      serverAddrs: new Map([['grpc', ':7000'], ['socket', '/tmp/orders.sock'], ['http', 'listenAddr']]),
      consts: new Map([['listenAddr', 'localhost:6999']]),
    } as unknown as GoFileFacts;
    expect(goListeningPorts(go)).toStrictEqual(['6999', '7000']);
  }, 300_000);

  test('reads a started port only when it is decimal digits, and only for an http server', () => {
    const ts = {
      listenerPorts: ['9000'],
      started: [
        { kind: 'http-server', symbol: 'a', port: '8083abc' },
        { kind: 'http-server', symbol: 'b', port: '8084' },
        { kind: 'http-server', symbol: 'c', port: '8082' },
        { kind: 'http-server', symbol: 'e', port: 'abc8083' },
        { kind: 'grpc-server', symbol: 'd', port: '50051' },
      ],
    } as unknown as TsFileFacts;
    expect(tsListeningPorts(ts)).toStrictEqual(['8082', '8084', '9000']);
  }, 300_000);
});


describe('the callables a file declares against the extract driver (training repository)', () => {
  test('every callable the driver names is one callable fact, with the driver\'s own name, span and body', async () => {
    if (tree === undefined) throw new Error('the repository was not read');
    const code = await extractCodeWithFacts(tree);
    const driverSymbols = code.facts.symbols.filter((symbol) => symbol.callable);
    expect(driverSymbols.length).toBeGreaterThan(20);
    const differences: Difference[] = [];
    for (const path of paths.filter(isCodePath)) {
      const facts = await readSyntaxTree(path, tree.read(path), (file) => {
        const collected = collectFileFacts('training', path, file.text, file.root, file.language);
        return { bodies: collected.bodies, findings: readFileFindings(file) };
      });
      if (!facts.read) throw new Error(`${repository}/${path}:1: the generated repository's source could not be read: the comparison has no smaller answer to give`);
      const callables = await callablesOfFile(path, tree.read(path), facts.value.findings, facts.value.bodies);
      const held = new Map(callables.map((callable) => [callable.key, callable]));
      for (const symbol of driverSymbols.filter((entry) => entry.path === path)) {
        const actual = held.get(symbol.key);
        const span = (value: { readonly path: string; readonly byteStart: number; readonly byteEnd: number; readonly lineStart: number; readonly lineEnd: number } | undefined): string =>
          value === undefined ? 'none' : `${value.path}@${String(value.byteStart)}-${String(value.byteEnd)}:${String(value.lineStart)}-${String(value.lineEnd)}`;
        const expectedText = `${symbol.name}|${symbol.qualifiedName}|${symbol.symbolKind}|${span(symbol.span)}|${span(symbol.bodySpan)}|${symbol.bodySyntaxKind ?? ''}`;
        const actualText = actual === undefined ? 'none' : `${actual.name}|${actual.qualifiedName}|${actual.symbolKind}|${span(actual.span)}|${span(actual.bodySpan)}|${actual.bodySyntaxKind ?? ''}`;
        if (expectedText !== actualText) differences.push({ path, expected: `${symbol.key} ${expectedText}`, actual: `${actual?.key ?? 'none'} ${actualText}` });
        held.delete(symbol.key);
      }
      for (const [key, extra] of held) differences.push({ path, expected: '(no callable)', actual: `${key} ${extra.qualifiedName}` });
    }
    expect(differences).toEqual([]);
  }, 900_000);
});

describe('the per-file facts against the extract driver (training repository)', () => {
  test('every file belongs to the unit serviceUnits gives it, and every unit is a manifest declaration', async () => {
    if (tree === undefined) throw new Error('the repository was not read');
    const units = serviceUnits(tree);
    // The comparison is not vacuous: the training repository declares four manifest units, and no
    // file belongs to a unit a compose build context or a Dockerfile declares.
    expect(units.length).toBe(4);
    expect(units.every((unit) => unit.source === 'manifest')).toBe(true);
    const index = unitIndex(units);
    const differences: Difference[] = [];
    for (const path of paths) {
      const read = await serviceMembershipOf(path, lookup);
      const expected = unitOfPath(index, path);
      if (membershipText(expected) !== membershipText(read.unit)) {
        differences.push({ path, expected: membershipText(expected), actual: membershipText(read.unit) });
      }
    }
    expect(differences).toEqual([]);
  }, 300_000);

  test('every source file listens on the ports portsByService reads, by the service it belongs to', async () => {
    if (tree === undefined) throw new Error('the repository was not read');
    const index = unitIndex(serviceUnits(tree));
    const serviceOf = (path: string): string | undefined => unitOfPath(index, path)?.name;
    const driver: CodeFilePortFacts[] = [];
    const facts = new Map<string, readonly string[]>();
    const perFile: Difference[] = [];
    for (const path of paths.filter(isCodePath)) {
      const read = await readSyntaxTree(path, tree.read(path), (file) => ({
        ports: listeningPortsOfTree(path, file.root, file.language),
        driver: file.language === 'go' ? { path, go: readGoFile(path, file.root) } : { path, ts: readTsFile(path, file.root) },
      }));
      if (!read.read) throw new Error(`${repository}/${path}:1: the generated repository's source could not be read (${read.unread.map((gap) => gap.reason).join(', ')}): the comparison has no smaller answer to give`);
      facts.set(path, read.value.ports);
      driver.push(read.value.driver as CodeFilePortFacts);
    }
    for (const entry of driver) {
      const expectedPorts = 'go' in entry ? goListeningPorts(entry.go) : tsListeningPorts(entry.ts);
      const actual = facts.get(entry.path) ?? [];
      if (expectedPorts.join(',') !== [...actual].join(',')) perFile.push({ path: entry.path, expected: expectedPorts.join(',') || '(none)', actual: [...actual].join(',') || '(none)' });
    }
    expect(perFile).toEqual([]);
    // By service, which is what the contracts stage links an operation's servers through.
    const expectedByService = portsByServiceOf(driver, serviceOf);
    const actualByService = new Map<string, Set<string>>();
    for (const [path, ports] of facts) {
      const service = (await serviceMembershipOf(path, lookup)).unit?.name;
      if (service === undefined) continue;
      const held = actualByService.get(service) ?? new Set<string>();
      for (const port of ports) held.add(port);
      actualByService.set(service, held);
    }
    const listed = (map: ReadonlyMap<string, ReadonlySet<string>>): readonly string[] => [...map]
      .map(([service, ports]) => `${service}:${[...ports].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).join(',')}`)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(listed(expectedByService)).toEqual(listed(actualByService));
    // Four services listen, and the comparison above named them: it is not two empty answers.
    // The ports are the generated repository's own (its answer key names them): orders 8080,
    // payments 8081, promotions 8082, checkout 8083, and the checkout test's own port 0.
    expect(listed(expectedByService)).toEqual(['checkout:0,8083', 'orders:8080', 'payments:8081', 'promotions:8082']);
    expect(expectedByService.size).toBe(4);
  }, 300_000);
});

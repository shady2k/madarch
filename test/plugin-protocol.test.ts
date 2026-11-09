/**
 * The protocol, the result validation and the closure (decision 0035, items
 * 4 and 7): the published schema is the module's own render, a kind or field
 * a plugin did not declare is refused with its place, a partial unit's
 * removals are dropped, and the closure's one hash is over its files in code
 * point order — a copy whose bytes moved is refused before it runs.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { PluginProtocolMessage, type PluginContractDeclaration } from '../src/plugin/protocol.js';
import { canonicalKey, validateUnitResult } from '../src/plugin/results.js';
import { closureHashOf, closureOf, interpreterPinProblem, readPluginManifest, sdkClosureFiles, ClosureRefusal } from '../src/plugin/closure.js';
import { closureTrustProblem, isReleaseClosure, snapshotClosure } from '../src/plugin/snapshot.js';
import { RELEASE_CLOSURE_HASHES } from '../src/plugin/release-closures.js';
import { seccompFilter, refusedCallNames } from '../src/plugin/seccomp.js';
import { checkCgroupDelegation, checkUserNamespaces } from '../src/plugin/cgroup.js';
import { probeUnit } from '../src/plugin/conformance.js';
import { errorReportOf, heartbeatOf, lineReader, progressOf } from '../src/plugin/wire.js';
import { byCodePoint } from '../src/model/order.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** One scratch folder the case made, removed when it ends. */
const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-protocol-'));
  roots.push(root);
  return root;
}
process.on('beforeExit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** The contract the probe fixture declares: one vertex kind, one edge kind. */
const CONTRACT: PluginContractDeclaration = {
  vertices: [
    { kind: 'probe', key: ['id'], fields: [{ name: 'size', claim: 'authoritative' }, { name: 'language', claim: 'claimed' }] },
    { kind: 'other', key: ['name'] },
  ],
  edges: [{ kind: 'probe-link', from: 'probe', to: 'probe' }],
};

/** One complete answer with the fields the contract declares. */
function answer(overrides: Record<string, unknown> = {}): Parameters<typeof validateUnitResult>[1] {
  return {
    unitId: 'u1',
    vertices: [{ kind: 'probe', key: { id: 'one' }, attributes: { size: 1 }, claims: [{ field: 'language', value: 'ts' }] }],
    edges: [{ kind: 'probe-link', from: { kind: 'probe', key: { id: 'one' } }, to: { kind: 'probe', key: { id: 'two' } }, discriminator: '' }],
    removals: [{ kind: 'probe', key: { id: 'gone' } }],
    end: { state: 'complete' },
    ...overrides,
  } as Parameters<typeof validateUnitResult>[1];
}

describe('the published schema is the module render', () => {
  test('schema/plugin-protocol.schema.json holds exactly what protocol.ts renders', () => {
    const file = readFileSync(fileURLToPath(new URL('../schema/plugin-protocol.schema.json', import.meta.url)), 'utf8');
    expect(JSON.parse(file)).toEqual(JSON.parse(JSON.stringify(PluginProtocolMessage)));
  });

  test('an introduction and a unit result validate against the committed file', () => {
    const file = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/plugin-protocol.schema.json', import.meta.url)), 'utf8')) as unknown;
    const introduce = {
      jsonrpc: '2.0',
      id: 'introduce',
      method: 'introduce',
      params: {
        protocol: 'madarch.plugins/1',
        name: 'plugin-probe',
        version: '1.0.0',
        rights: { network: 'none' },
        limits: { maxParallelUnits: 2 },
        outputs: CONTRACT,
      },
    };
    expect(Value.Check(file as never, introduce)).toBe(true);
    expect(Value.Check(file as never, { jsonrpc: '2.0', method: 'heartbeat' })).toBe(true);
  });

  test('a message that names another protocol version does not validate', () => {
    const file = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/plugin-protocol.schema.json', import.meta.url)), 'utf8')) as never;
    const wrong = { jsonrpc: '2.0', id: 1, method: 'introduce', params: { protocol: 'madarch.plugins/2', name: 'x', version: '1', rights: { network: 'none' }, outputs: { vertices: [], edges: [] } } };
    expect(Value.Check(file, wrong)).toBe(false);
  });
});

describe('results are held to the plugin declaration', () => {
  test('a declared answer is accepted, and its lists are ordered by code point of kind and key', () => {
    const checked = validateUnitResult(CONTRACT, answer({
      vertices: [
        { kind: 'probe', key: { id: 'b' } },
        { kind: 'other', key: { name: 'a' } },
        { kind: 'probe', key: { id: 'a' } },
      ],
    }));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.unit.vertices.map((vertex) => `${vertex.kind}:${String(vertex.key['id'] ?? vertex.key['name'])}`)).toEqual(['other:a', 'probe:a', 'probe:b']);
    expect(checked.unit.removalsDropped).toBe(0);
    expect(checked.unit.removals.length).toBe(1);
  });

  test('an undeclared vertex kind is refused with its place', () => {
    const checked = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'stranger', key: { id: 'x' } }] }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.refusal.code).toBe('undeclared-kind');
    expect(checked.refusal.where).toBe('vertices[0].kind');
    expect(checked.refusal.message).toContain('vertices[0].kind');
    expect(checked.refusal.message).toContain('probe');
  });

  test('an undeclared field is refused, and a claimed field written as an attribute is one', () => {
    const attributes = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'probe', key: { id: 'x' }, attributes: { language: 'ts' } }] }));
    expect(attributes.ok).toBe(false);
    if (!attributes.ok) {
      expect(attributes.refusal.code).toBe('undeclared-field');
      expect(attributes.refusal.where).toBe('vertices[0].attributes.language');
    }
    const claims = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'probe', key: { id: 'x' }, claims: [{ field: 'size', value: 1 }] }] }));
    expect(claims.ok).toBe(false);
    if (!claims.ok) expect(claims.refusal.where).toBe('vertices[0].claims[0].field');
  });

  test('an undeclared edge kind, and an end the edge kind does not name, are refused', () => {
    const kind = validateUnitResult(CONTRACT, answer({ edges: [{ kind: 'stranger-link', from: { kind: 'probe', key: { id: 'a' } }, to: { kind: 'probe', key: { id: 'b' } }, discriminator: '' }] }));
    expect(kind.ok).toBe(false);
    if (!kind.ok) expect(kind.refusal.code).toBe('undeclared-edge-kind');
    const end = validateUnitResult(CONTRACT, answer({ edges: [{ kind: 'probe-link', from: { kind: 'other', key: { name: 'a' } }, to: { kind: 'probe', key: { id: 'b' } }, discriminator: '' }] }));
    expect(end.ok).toBe(false);
    if (!end.ok) {
      expect(end.refusal.code).toBe('undeclared-edge-end');
      expect(end.refusal.where).toBe('edges[0].from.kind');
    }
  });

  test('a key with a field the kind does not declare is refused, and one written twice is a duplicate', () => {
    const key = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'probe', key: { id: 'x', extra: 'y' } }] }));
    expect(key.ok).toBe(false);
    if (!key.ok) expect(key.refusal.code).toBe('undeclared-key-field');
    const twice = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'probe', key: { id: 'x' } }, { kind: 'probe', key: { id: 'x' } }] }));
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.refusal.code).toBe('duplicate-vertex');
  });

  test('a partial unit carries no removals: they are dropped, and counted', () => {
    const checked = validateUnitResult(CONTRACT, answer({ end: { state: 'partial', cause: 'read half' }, removals: [{ kind: 'probe', key: { id: 'gone' } }, { kind: 'probe', key: { id: 'also-gone' } }] }));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.unit.removals).toEqual([]);
    expect(checked.unit.removalsDropped).toBe(2);
    expect(checked.unit.end).toEqual({ state: 'partial', cause: 'read half' });
  });

  test('a key renders the same bytes whatever order its fields came in', () => {
    expect(canonicalKey({ b: '2', a: '1' })).toBe(canonicalKey({ a: '1', b: '2' }));
    expect(canonicalKey({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
  });
});

describe("a plugin's closure and its one hash", () => {
  test('the hash covers every file path and digest in code point order', () => {
    const files = [
      { path: 'b.ts', sha256: 'b'.repeat(64) },
      { path: 'a.ts', sha256: 'a'.repeat(64) },
    ];
    const expected = createHash('sha256').update(`a.ts\u0000${'a'.repeat(64)}\u0000b.ts\u0000${'b'.repeat(64)}\u0000`).digest('hex');
    expect(closureHashOf(files)).toBe(expected);
    expect(closureHashOf([...files].reverse())).toBe(expected);
  });

  test('the probe fixture hashes with the SDK madarch hands it, and the SDK is two files', () => {
    const closure = closureOf(join(FIXTURES, 'plugin-probe'));
    const paths = closure.files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort(byCodePoint));
    expect(paths).toContain('node_modules/madarch-plugin-sdk/index.ts');
    expect(paths).toEqual(['main.ts', 'node_modules/madarch-plugin-sdk/index.ts', 'node_modules/madarch-plugin-sdk/package.json', 'plugin.json']);
    expect(sdkClosureFiles().length).toBe(2);
    expect(closure.files.find((file) => file.path === 'node_modules/madarch-plugin-sdk/index.ts')?.content?.length).toBeGreaterThan(1_000);
  });

  test('a plugin folder that carries its own SDK copy is refused', () => {
    const folder = scratch();
    writeFileSync(join(folder, 'plugin.json'), `${JSON.stringify({ name: 'own-sdk', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version } })}\n`);
    writeFileSync(join(folder, 'main.ts'), 'export const x = 1;\n');
    mkdirSync(join(folder, 'node_modules', 'madarch-plugin-sdk'), { recursive: true });
    writeFileSync(join(folder, 'node_modules', 'madarch-plugin-sdk', 'index.ts'), 'export const y = 1;\n');
    expect(() => closureOf(folder)).toThrow(/stands in the plugin's folder/);
  });

  test('a copy whose bytes moved after hashing is refused with the file named', async () => {
    const folder = scratch();
    writeFileSync(join(folder, 'plugin.json'), `${JSON.stringify({ name: 'changing', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version } })}\n`);
    writeFileSync(join(folder, 'main.ts'), 'export const x = 1;\n');
    const closure = closureOf(folder);
    writeFileSync(join(folder, 'main.ts'), 'export const x = 2;\n');
    let refusal: unknown;
    try {
      await snapshotClosure(closure, scratch());
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ClosureRefusal);
    expect((refusal as ClosureRefusal).code).toBe('closure-changed');
    expect((refusal as ClosureRefusal).message).toContain('main.ts');
    expect((refusal as ClosureRefusal).message).toContain(folder);
  });

  test('a snapshot of an unchanged closure hashes to its own hash, and copies the SDK too', async () => {
    const closure = closureOf(join(FIXTURES, 'plugin-probe'));
    const copy = await snapshotClosure(closure, scratch());
    expect(copy.hash).toBe(closure.hash);
    expect(readFileSync(join(copy.folder, 'node_modules', 'madarch-plugin-sdk', 'index.ts'), 'utf8').length).toBeGreaterThan(1_000);
  });

  test('a closure no release carries needs approval as production, and runs as validation', () => {
    const closure = closureOf(join(FIXTURES, 'plugin-probe'));
    expect(isReleaseClosure(closure.hash)).toBe(false);
    expect(RELEASE_CLOSURE_HASHES).toEqual([]);
    const refused = closureTrustProblem(closure, 'production', join(closure.folder, 'plugin.json'));
    expect(refused?.code).toBe('needs-approval');
    expect(refused?.message).toContain('needs approval');
    expect(refused?.message).toContain(closure.hash);
    expect(closureTrustProblem(closure, 'validation', join(closure.folder, 'plugin.json'))).toBeUndefined();
    expect(closureTrustProblem(closure, 'production', join(closure.folder, 'plugin.json'), [closure.hash])).toBeUndefined();
  });

  test('a manifest for another interpreter, a missing one and a symlinked file are refused', () => {
    const folder = scratch();
    writeFileSync(join(folder, 'plugin.json'), `${JSON.stringify({ name: 'pinned', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: '9.9.9' } })}\n`);
    writeFileSync(join(folder, 'main.ts'), 'export const x = 1;\n');
    const pin = interpreterPinProblem(closureOf(folder));
    expect(pin?.code).toBe('interpreter-pin');
    expect(pin?.message).toContain('9.9.9');
    expect(pin?.message).toContain(Bun.version);

    const empty = scratch();
    expect(() => readPluginManifest(empty)).toThrow(/plugin.json/);

    const linked = scratch();
    writeFileSync(join(linked, 'plugin.json'), `${JSON.stringify({ name: 'linked', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version } })}\n`);
    writeFileSync(join(linked, 'main.ts'), 'export const x = 1;\n');
    symlinkSync(join(linked, 'main.ts'), join(linked, 'linked.ts'));
    expect(() => closureOf(linked)).toThrow(/symbolic link/);
  });
});

describe('the sandbox primitives', () => {
  test('the seccomp filter checks the ABI, refuses this platform\'s socket call and allows the rest', () => {
    const filter = seccompFilter('linux-arm64');
    // Four instructions before the table (load arch, compare, foreign-ABI answer, load nr), two per refused call
    // (compare, answer), and one allow at the end.
    expect(filter.length).toBe(8 * (4 + refusedCallNames('linux-arm64').length * 2 + 1));
    expect(filter.readUInt16LE(0)).toBe(0x20);
    expect(refusedCallNames('linux-arm64')).toEqual(['connect', 'io_uring_enter', 'io_uring_register', 'io_uring_setup', 'process_vm_readv', 'process_vm_writev', 'ptrace', 'socket', 'socketpair']);
    expect(refusedCallNames('linux-x64')).toContain('socket');
    const numbers: number[] = [];
    for (let at = 0; at < filter.length; at += 8) if (filter.readUInt16LE(at) === 0x15) numbers.push(filter.readUInt32LE(at + 4));
    expect(numbers).toContain(198);
    expect(filter.readUInt16LE(filter.length - 8)).toBe(0x06);
    expect(filter.readUInt32LE(filter.length - 4)).toBe(0x7fff0000);
    expect(() => seccompFilter('plan9-x64')).toThrow(/no seccomp filter is built/);
  });

  test('a cgroup folder that is not one names what to enable, and a missing controller does too', () => {
    const folder = scratch();
    const notACgroup = checkCgroupDelegation(folder);
    expect(notACgroup?.code).toBe('cgroup-delegation');
    expect(notACgroup?.message).toContain(folder);
    expect(notACgroup?.message).toContain('MADARCH_PLUGIN_CGROUP');
    expect(notACgroup?.message).toContain('docs/system/plugin-sandbox.md');
  });

  test('off user namespaces are an operations problem naming the setting', () => {
    const off = checkUserNamespaces({ uid: 1000, read: (path) => (path === '/proc/sys/user/max_user_namespaces' ? '0\n' : '1\n') });
    expect(off?.code).toBe('user-namespaces');
    expect(off?.message).toContain('user.max_user_namespaces');
    const restricted = checkUserNamespaces({ uid: 1000, read: (path) => (path === '/proc/sys/kernel/apparmor_restrict_unprivileged_userns' ? '1\n' : '1000\n') });
    expect(restricted?.code).toBe('user-namespaces');
    expect(restricted?.message).toContain('apparmor_restrict_unprivileged_userns');
    expect(checkUserNamespaces({ uid: 0, read: () => '1\n' })).toBeUndefined();
  });

  test('the conformance kit builds its probe from the first declared kind, in code point order', () => {
    const unit = probeUnit(CONTRACT);
    expect(unit).toEqual({ unitId: 'conformance-1', kind: 'other', key: { name: 'conformance' } });
    expect(probeUnit({ vertices: [], edges: [] })).toBeUndefined();
  });
});

describe('the wire', () => {
  test('a long line is a message too large, and is never buffered whole', () => {
    const reader = lineReader(32);
    const overflow: number[] = [];
    const lines: unknown[] = [];
    reader.push(new TextEncoder().encode('x'.repeat(64)), (message) => lines.push(message.value), (bytes) => overflow.push(bytes));
    expect(lines).toEqual([]);
    expect(overflow).toEqual([64]);
  });

  test('heartbeats, progress and errors are read off notifications, and a request is told from an answer', () => {
    expect(heartbeatOf({ jsonrpc: '2.0', method: 'heartbeat' })).toEqual({});
    expect(heartbeatOf({ jsonrpc: '2.0', method: 'heartbeat', params: { unitId: 'u1' } })).toEqual({ unitId: 'u1' });
    expect(progressOf({ jsonrpc: '2.0', method: 'progress', params: { unitId: 'u1', done: 2, total: 4, note: 'half' } })).toEqual({ unitId: 'u1', done: 2, total: 4, note: 'half' });
    expect(errorReportOf({ jsonrpc: '2.0', method: 'error', params: { code: 'boom', message: 'it broke', unitId: 'u1', file: 'main.ts', line: 3 } })).toEqual({ code: 'boom', message: 'it broke', unitId: 'u1', file: 'main.ts', line: 3 });
    expect(heartbeatOf({ jsonrpc: '2.0', id: 1, method: 'unit' })).toBeUndefined();
  });
});

void REPO;

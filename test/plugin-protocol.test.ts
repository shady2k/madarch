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
import { graphReadsOf, PluginContractFile, PluginProtocolMessage, type PluginContractDeclaration } from '../src/plugin/protocol.js';
import { canonicalKey, validateUnitResult } from '../src/plugin/results.js';
import { closureHashOf, closureOf, interpreterPinProblem, readPluginManifest, sdkClosureFiles, ClosureRefusal } from '../src/plugin/closure.js';
import { closureTrustProblem, isReleaseClosure, snapshotClosure } from '../src/plugin/snapshot.js';
import { RELEASE_CLOSURE_HASHES } from '../src/plugin/release-closures.js';
import { bundledClosureHashes } from '../src/plugin/bundled.js';
import { seccompFilter, refusedCallNames } from '../src/plugin/seccomp.js';
import { checkCgroupDelegation, checkUserNamespaces } from '../src/plugin/cgroup.js';
import { probeUnit } from '../src/plugin/conformance.js';
import { errorReportOf, failureText, heartbeatOf, isNotification, isRequest, isResponse, lineReader, progressOf, requestText, successText } from '../src/plugin/wire.js';
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
    { kind: 'probe', key: ['id'], fields: [{ name: 'size', type: 'integer', meaning: 'the size', example: 1, required: false }, { name: 'language', type: 'text', meaning: 'the language', example: 'ts', required: false }] },
    { kind: 'other', key: ['name'] },
  ],
  edges: [{ kind: 'probe-link', from: 'probe', to: 'probe' }],
};

/** One complete answer with the fields the contract declares. */
function answer(overrides: Record<string, unknown> = {}): Parameters<typeof validateUnitResult>[1] {
  return {
    unitId: 'u1',
    vertices: [{ kind: 'probe', key: { id: 'one' }, values: { size: 1, language: 'ts' } }],
    edges: [{ kind: 'probe-link', from: { kind: 'probe', key: { id: 'one' } }, to: { kind: 'probe', key: { id: 'two' } }, discriminator: '' }],
    removals: [{ kind: 'probe', key: { id: 'gone' } }],
    end: { state: 'complete' },
    ...overrides,
  } as Parameters<typeof validateUnitResult>[1];
}

describe('the graph reads a contract declares', () => {
  test('a graph right with no named reads is files and value, and a named read is what the contract grants', () => {
    expect(graphReadsOf({ network: 'none', graph: true })).toEqual(['files', 'value']);
    expect(graphReadsOf({ network: 'none', graph: true, graphReads: ['unresolved', 'removedEnds', 'unevidenced'] })).toEqual(['unresolved', 'removedEnds', 'unevidenced']);
    expect(graphReadsOf({ network: 'none' })).toEqual([]);
    expect(graphReadsOf(undefined)).toEqual([]);
  });

  test('a contract declares its reads, and an unknown read is refused', () => {
    const contract = { id: 'g', version: '1.0.0', reads: 'whole-graph', outputs: CONTRACT, rights: { network: 'none', graph: true, graphReads: ['unresolved', 'removedEnds', 'unevidenced'] } };
    expect(Value.Check(PluginContractFile, contract)).toBe(true);
    expect(Value.Check(PluginContractFile, { ...contract, reads: 'everything' })).toBe(false);
    expect(Value.Check(PluginContractFile, { ...contract, rights: { ...contract.rights, graphReads: ['unresolved', 'everything'] } })).toBe(false);
  });
});

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
        protocol: 'madarch.plugins/2',
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
    const wrong = { jsonrpc: '2.0', id: 1, method: 'introduce', params: { protocol: 'madarch.plugins/1', name: 'x', version: '1', rights: { network: 'none' }, outputs: { vertices: [], edges: [] } } };
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

  test('an undeclared field is refused, and every declared field is a value alike', () => {
    const undeclared = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'probe', key: { id: 'x' }, values: { weight: 2 } }] }));
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.refusal.code).toBe('undeclared-field');
      expect(undeclared.refusal.where).toBe('vertices[0].values.weight');
    }
    // No field is authoritative: both declared fields are stated the same way, in one list of values.
    const declared = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'probe', key: { id: 'x' }, values: { size: 1, language: 'ts' } }] }));
    expect(declared.ok).toBe(true);
  });

  test('an edge value its kind does not declare is refused', () => {
    const checked = validateUnitResult(CONTRACT, answer({ edges: [{ kind: 'probe-link', from: { kind: 'probe', key: { id: 'a' } }, to: { kind: 'probe', key: { id: 'b' } }, discriminator: '', values: { weight: 2 } }] }));
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.refusal.code).toBe('undeclared-field');
      expect(checked.refusal.where).toBe('edges[0].values.weight');
    }
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
    // The same number of fields under other names is just as wrong: a count is not a key.
    const renamed = validateUnitResult(CONTRACT, answer({ vertices: [{ kind: 'probe', key: { name: 'x' } }] }));
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.refusal.where).toBe('vertices[0].key');
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
    expect(paths).toEqual(['contract.json', 'main.ts', 'node_modules/madarch-plugin-sdk/index.ts', 'node_modules/madarch-plugin-sdk/package.json', 'plugin.json']);
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
    // The release carries its own plugins and nothing else (decision 0035, item 4): the fixture is not one of them.
    expect(RELEASE_CLOSURE_HASHES).toEqual([...bundledClosureHashes()]);
    expect(RELEASE_CLOSURE_HASHES.length).toBeGreaterThan(0);
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
  test('the seccomp filter checks the ABI, refuses this platform\'s calls, the x32 ABI and a namespace fork', () => {
    /** One instruction of the program, as the kernel reads it. */
    const decode = (filter: Buffer): { code: number; jumpTrue: number; jumpFalse: number; k: number }[] => {
      const held: { code: number; jumpTrue: number; jumpFalse: number; k: number }[] = [];
      for (let at = 0; at < filter.length; at += 8) {
        held.push({ code: filter.readUInt16LE(at), jumpTrue: filter.readUInt8(at + 2), jumpFalse: filter.readUInt8(at + 3), k: filter.readUInt32LE(at + 4) });
      }
      return held;
    };
    const arm = decode(seccompFilter('linux-arm64'));
    const x64 = decode(seccompFilter('linux-x64'));
    const refused = refusedCallNames('linux-arm64');
    expect(refused).toEqual([
      'add_key', 'bpf', 'clone', 'clone3', 'connect', 'io_uring_enter', 'io_uring_register', 'io_uring_setup', 'keyctl',
      'mount', 'open_by_handle_at', 'perf_event_open', 'pivot_root', 'process_vm_readv', 'process_vm_writev', 'ptrace',
      'request_key', 'setns', 'socket', 'umount2', 'unshare', 'userfaultfd',
    ].sort());
    // Four instructions before the table (load arch, compare, foreign-ABI answer, load nr), two per refused call in the
    // table, two for clone3, four for the clone block and one allow.
    const table = refused.filter((name) => name !== 'clone' && name !== 'clone3').length;
    expect(arm.length).toBe(4 + table * 2 + 2 + 4 + 1);
    expect(x64.length).toBe(arm.length + 2);
    // The ABI check answers ENOSYS for anything but this filter's ABI, and this platform's own numbers are refused.
    expect(arm[0]!.code).toBe(0x20);
    expect(arm[0]!.k).toBe(4);
    expect(arm[1]!.code).toBe(0x15);
    expect(arm[1]!.k).toBe(0xc00000b7);
    expect(arm[2]!.k).toBe(0x00050000 | 38);
    expect(arm[3]!.k).toBe(0);
    // x86_64 refuses the x32 ABI whole: a greater-or-equal compare on nr right after it is loaded.
    expect(arm.some((instruction) => instruction.code === 0x35)).toBe(false);
    const x32At = x64.findIndex((instruction) => instruction.code === 0x35);
    expect(x32At).toBe(4);
    expect(x64[x32At]!.k).toBe(0x4000_0000);
    expect(x64[x32At]!.jumpTrue).toBe(0);
    expect(x64[x32At]!.jumpFalse).toBe(1);
    expect(x64[x32At + 1]!.k).toBe(0x00050000 | 38);
    // Every refused number answers EPERM: a compare then an errno return.
    const pairs = x64.filter((instruction) => instruction.code === 0x15 && instruction.jumpTrue === 0 && instruction.jumpFalse === 1);
    expect(pairs.map((instruction) => instruction.k)).toEqual(expect.arrayContaining([41, 42, 272, 308, 165, 321, 323, 250, 248, 249, 304, 435]));
    // clone3 answers ENOSYS so the clone fallback runs; clone is refused only when its flags carry a namespace.
    const clone3At = x64.findIndex((instruction) => instruction.code === 0x15 && instruction.k === 435);
    expect(x64[clone3At + 1]!.k).toBe(0x00050000 | 38);
    const cloneAt = x64.findIndex((instruction) => instruction.code === 0x15 && instruction.k === 56);
    expect(x64[cloneAt]!.jumpFalse).toBe(3);
    expect(x64[cloneAt + 1]).toEqual({ code: 0x20, jumpTrue: 0, jumpFalse: 0, k: 16 });
    expect(x64[cloneAt + 2]!.code).toBe(0x45);
    expect(x64[cloneAt + 2]!.k & 0x1000_0000).toBe(0x1000_0000);
    expect(x64[cloneAt + 2]!.k & 0x4000_0000).toBe(0x4000_0000);
    expect(x64[cloneAt + 3]!.k).toBe(0x00050000 | 1);
    // The fallthrough at the end is the allow.
    expect(x64[x64.length - 1]!.code).toBe(0x06);
    expect(x64[x64.length - 1]!.k).toBe(0x7fff0000);
    expect(refusedCallNames('linux-x64')).toContain('socket');
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

  test('a message cut across two chunks is read once its newline arrives', () => {
    const reader = lineReader(1_024);
    const seen: unknown[] = [];
    const overflow: number[] = [];
    const bytes = new TextEncoder().encode('{"jsonrpc":"2.0","method":"heartbeat"}\n{"jsonrpc":"2.0","method":"progress","params":{"unitId":"u1"}}\n');
    reader.push(bytes.subarray(0, 10), (message) => seen.push(message.value), (n) => overflow.push(n));
    expect(seen).toEqual([]);
    expect(reader.held()).toBe(10);
    reader.push(bytes.subarray(10, 40), (message) => seen.push(message.value), (n) => overflow.push(n));
    reader.push(bytes.subarray(40), (message) => seen.push(message.value), (n) => overflow.push(n));
    expect(seen).toEqual([{ jsonrpc: '2.0', method: 'heartbeat' }, { jsonrpc: '2.0', method: 'progress', params: { unitId: 'u1' } }]);
    expect(overflow).toEqual([]);
    expect(reader.held()).toBe(0);
  });

  test('a line that is not JSON is handed on as a parse failure, and blank lines are no message', () => {
    const reader = lineReader(1_024);
    const seen: unknown[] = [];
    reader.push(new TextEncoder().encode('not json\n\n{"jsonrpc":"2.0","method":"heartbeat"}\n'), (message) => seen.push(message.value), () => undefined);
    expect((seen[0] as { parseFailure?: string }).parseFailure).toBeDefined();
    expect(seen[1]).toEqual({ jsonrpc: '2.0', method: 'heartbeat' });
    expect(seen.length).toBe(2);
  });

  test('the three written messages are JSON-RPC, and an answer is told from a request', () => {
    expect(JSON.parse(requestText(7, 'unit', { unit: { unitId: 'u' } }))).toEqual({ jsonrpc: '2.0', id: 7, method: 'unit', params: { unit: { unitId: 'u' } } });
    expect(JSON.parse(requestText('x', 'stop'))).toEqual({ jsonrpc: '2.0', id: 'x', method: 'stop' });
    expect(JSON.parse(successText('x', { ok: true }))).toEqual({ jsonrpc: '2.0', id: 'x', result: { ok: true } });
    expect(JSON.parse(failureText(null, -32700, 'bad'))).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad' } });
    expect(JSON.parse(failureText(3, -32000, 'no', { cause: 'c', unitId: 'u' }))).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'no', data: { cause: 'c', unitId: 'u' } } });
    expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'unit' })).toBe(true);
    expect(isRequest({ jsonrpc: '2.0', method: 'unit' })).toBe(false);
    expect(isNotification({ jsonrpc: '2.0', method: 'heartbeat' })).toBe(true);
    expect(isNotification({ jsonrpc: '2.0', id: 1, method: 'heartbeat' })).toBe(false);
    expect(isResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    expect(isResponse({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'x' } })).toBe(true);
    expect(isResponse({ jsonrpc: '2.0', method: 'unit' })).toBe(false);
  });

  test('a notification whose params are not the shape is no report of that kind', () => {
    expect(progressOf({ jsonrpc: '2.0', method: 'progress', params: { done: 1 } })).toBeUndefined();
    expect(progressOf({ jsonrpc: '2.0', method: 'progress', params: 'text' })).toBeUndefined();
    expect(errorReportOf({ jsonrpc: '2.0', method: 'error', params: { code: 'x' } })).toBeUndefined();
    expect(heartbeatOf({ jsonrpc: '2.0', method: 'heartbeat', params: { unitId: 7 } })).toEqual({});
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

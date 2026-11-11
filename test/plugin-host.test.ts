/**
 * The plugin host and the sandbox (decision 0035, items 5, 7, 9 and 13):
 * every bound the host holds a plugin to is exercised here against a fixture
 * plugin in the real sandbox — a missing introduction, a flood of output, a
 * silence where a heartbeat belongs, a pause that must not time out, a stop
 * that escalates, a fork past the pids bound, memory past the cgroup's, a
 * socket, a write outside the temporary folder, a read outside the snapshot,
 * a setsid child the cgroup kills, the closure's hash, the trust a release
 * gives and the validation that publishes nothing, an undeclared kind and a
 * partial unit's removals — and each failing case stands beside a run of the
 * same fixture that succeeds.
 *
 * These need bubblewrap and a cgroup delegated to madarch. Where the machine
 * lacks either, every case is skipped with the reason printed, never passed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureOf } from '../src/plugin/closure.js';
import { checkConformance } from '../src/plugin/conformance.js';
import { PluginHost, RequestLog, runUnits, type PluginSession, type UnitOutcome } from '../src/plugin/host.js';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { bwrapForUse } from '../src/plugin/bwrap-install.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

/** The cgroup the case's sandbox runs under: the run's own, or one this file makes on a root machine. */
let parent = '';

/** The folders a case made, removed when the file is done. */
const roots: string[] = [];

/** One scratch folder the case made. */
function scratch(name = 'madarch-plugin-host-'): string {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
}

/** The limits every case runs under: short deadlines, calm enough for a loaded machine. */
const LIMITS = { handshakeMs: 3_000, unitMs: 8_000, heartbeatMs: 600, maxMessageBytes: 32_768, memoryBytes: 128 * 1_048_576, pids: 12, stopGraceMs: 600 };

/** The probe fixture's closure, read once. */
const probeFolder = join(FIXTURES, 'plugin-probe');
const probeClosure = closureOf(probeFolder);

/** One open session on a fixture, with the probe's closure trusted as a release would be. */
async function open(folder: string, options: { readonly work?: string; readonly releaseHashes?: readonly string[]; readonly trust?: 'production' | 'validation'; readonly limits?: Partial<typeof LIMITS>; readonly cgroupParent?: string; readonly closure?: ReturnType<typeof closureOf>; readonly graph?: { files(pattern: string): Promise<readonly { kind: string; key: Record<string, string | number> }[]>; value(kind: string, key: Record<string, string | number>, field: string): Promise<unknown>; unresolved?(query: import('../src/plugin/protocol.js').PluginGraphPageRequest): Promise<{ references: readonly import('../src/plugin/protocol.js').PluginGraphUnresolvedReference[]; next?: string }>; removedEnds?(query: import('../src/plugin/protocol.js').PluginGraphPageRequest): Promise<{ edges: readonly import('../src/plugin/protocol.js').PluginGraphRemovedEnd[]; next?: string }>; unevidenced?(query: import('../src/plugin/protocol.js').PluginGraphPageRequest): Promise<{ opinions: readonly import('../src/plugin/protocol.js').PluginGraphUnevidencedOpinion[]; next?: string }> }; readonly requests?: RequestLog } = {}): Promise<PluginSession> {
  const work = options.work ?? scratch();
  const host = new PluginHost({
    pluginFolder: folder,
    ...(options.closure === undefined ? {} : { closure: options.closure }),
    repository: probeFolder,
    workRoot: work,
    trust: options.trust ?? 'production',
    releaseHashes: options.releaseHashes ?? [closureOf(folder).hash],
    limits: { ...LIMITS, ...(options.limits ?? {}) },
    cgroupParent: options.cgroupParent ?? parent,
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    ...(options.requests === undefined ? {} : { requests: options.requests }),
  });
  return await host.open();
}

/** One unit of the probe fixture, asking for one behaviour. */
function unit(behavior: string): { unitId: string; kind: string; key: Record<string, string> } {
  return { unitId: behavior, kind: 'probe', key: { id: behavior, behavior } };
}

/** Runs one behaviour and closes the session: the outcome, and the session's numbers read before it closed. */
async function behaviour(behavior: string, limits: Partial<typeof LIMITS> = {}): Promise<{ outcome: UnitOutcome; counters: UnitOutcome extends never ? never : ReturnType<PluginSession['counters']> }> {
  const session = await open(probeFolder, { limits });
  try {
    const outcome = await session.runUnit(unit(behavior));
    return { outcome, counters: session.counters() };
  } finally {
    await session.close();
  }
}

/** The partial cause a behaviour answers with, or a failure naming what came instead. */
function partialCause(outcome: UnitOutcome): string {
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error('unreachable');
  expect(outcome.result.end.state).toBe('partial');
  return outcome.result.end.state === 'partial' ? outcome.result.end.cause : '';
}

/**
 * Whether this machine can confine a plugin at all, decided before any case is
 * registered: a case that has nothing to confine against is skipped with the
 * reason printed, never run and never passed.
 */
const skipReason: string | undefined = await (async (): Promise<string | undefined> => {
  // The delegation the sandbox needs. A machine that already delegates one to madarch names it in
  // MADARCH_PLUGIN_CGROUP; on a root machine this file makes the slice a systemd Delegate=yes gives.
  const named = process.env['MADARCH_PLUGIN_CGROUP']?.trim();
  if (named !== undefined && named !== '') parent = named;
  else {
    const made = '/sys/fs/cgroup/system.slice/madarch.slice';
    try {
      mkdirSync(made, { recursive: true });
      writeFileSync(join(made, 'cgroup.subtree_control'), '+cpu +memory +pids');
      parent = made;
    } catch (error) {
      parent = cgroupParent();
      return `no cgroup is delegated to madarch (${(error as Error).message}) and MADARCH_PLUGIN_CGROUP names none: the sandbox runs no plugin without one — see docs/system/plugin-sandbox.md`;
    }
  }
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  if (problem !== undefined) return problem.message;
  try {
    await bwrapForUse();
  } catch (error) {
    return `bubblewrap could not be installed: ${(error as Error).message}`;
  }
  return undefined;
})();

if (skipReason !== undefined) {
  // A machine that was told the sandbox cases must run here fails on the spot: a suite that skipped them would report
  // a green it never earned. CI sets the flag in the step that delegates the cgroup (docs/system/plugin-sandbox.md).
  if (process.env['MADARCH_SANDBOX_REQUIRED'] === '1') {
    throw new Error(`the plugin sandbox cases are required here (MADARCH_SANDBOX_REQUIRED=1), and this machine cannot run them: ${skipReason}`);
  }
  console.log(`plugin host cases skipped: ${skipReason}`);
}

/** One case, skipped with the machine's reason when the sandbox cannot run here. */
const hostTest = test.skipIf(skipReason !== undefined);
/**
 * The one case only an x86_64 machine can hold: the x32 ABI. It is skipped elsewhere whatever
 * MADARCH_SANDBOX_REQUIRED says, because no other kernel has that ABI to refuse.
 */
const x64HostTest = test.skipIf(skipReason !== undefined || process.arch !== 'x64');
if (process.arch !== 'x64') console.log(`the x32 case is skipped: ${process.arch} has no x32 ABI to refuse`);

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the handshake', () => {
  hostTest('a plugin that never introduces itself fails the handshake deadline', async () => {
    let refusal: unknown;
    try {
      await open(join(FIXTURES, 'plugin-silent'), { limits: { handshakeMs: 700 } });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeDefined();
    const cause = refusal as { code?: string; message?: string };
    expect(cause.code).toBe('handshake-timeout');
    expect(cause.message).toContain('700 ms');
    expect(cause.message).toContain('src/plugin/host.ts');
  }, 30_000);

  hostTest('a plugin that introduces itself within the deadline is taken', async () => {
    const session = await open(probeFolder);
    try {
      expect(session.declared.name).toBe('plugin-probe');
      expect(session.declared.protocol).toBe('madarch.plugins/2');
      expect(session.declared.outputs.vertices.map((kind) => kind.kind)).toEqual(['probe']);
      expect(session.closureHash).toBe(probeClosure.hash);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe('the bounds of one message and one unit', () => {
  hostTest('a plugin that floods its output fails the unit on one message', async () => {
    const { outcome } = await behaviour('flood');
    expect(outcome.state).toBe('not-extracted');
    if (outcome.state !== 'not-extracted') return;
    expect(outcome.cause.code).toBe('message-too-large');
    expect(outcome.cause.message).toContain(String(LIMITS.maxMessageBytes));
  }, 60_000);

  hostTest('the same fixture answers a normal unit, held to its declaration', async () => {
    const { outcome } = await behaviour('normal');
    expect(outcome.state).toBe('extracted');
    if (outcome.state !== 'extracted') return;
    expect(outcome.result.vertices.map((vertex) => vertex.kind)).toEqual(['probe']);
    expect(outcome.result.vertices[0]?.values).toEqual({ size: 12, language: 'typescript' });
    expect(outcome.result.vertices[0]?.evidence?.path).toBe('probe/normal.ts');
    expect(outcome.result.edges.map((edge) => edge.kind)).toEqual(['probe-link']);
    expect(outcome.result.removals.map((removal) => removal.key['id'])).toEqual(['gone']);
    expect(outcome.result.end).toEqual({ state: 'complete' });
  }, 60_000);
});

describe('the heartbeat', () => {
  hostTest('a plugin that stops sending heartbeats fails the unit', async () => {
    const { outcome } = await behaviour('no-heartbeat');
    expect(outcome.state).toBe('not-extracted');
    if (outcome.state !== 'not-extracted') return;
    expect(outcome.cause.code).toBe('heartbeat-missed');
    expect(outcome.cause.message).toContain(String(LIMITS.heartbeatMs));
  }, 60_000);

  hostTest('a plugin paused longer than the heartbeat deadline does not time out', async () => {
    const session = await open(probeFolder);
    try {
      const running = session.runUnit(unit('no-heartbeat'));
      await Bun.sleep(100);
      await session.pause();
      await Bun.sleep(LIMITS.heartbeatMs * 3);
      await session.resume();
      const outcome = await running;
      expect(outcome.state).toBe('extracted');
      if (outcome.state !== 'extracted') return;
      expect(outcome.result.end).toEqual({ state: 'complete' });
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe('stop and cancel', () => {
  hostTest('a plugin that ignores stop is cancelled after the grace period', async () => {
    const session = await open(join(FIXTURES, 'plugin-deaf'), { limits: { stopGraceMs: 400 } });
    try {
      const stopping = await session.stop();
      expect(stopping.state).toBe('cancelled');
    } finally {
      await session.close();
    }
  }, 30_000);

  hostTest('a plugin that answers stop exits within the grace period', async () => {
    const session = await open(probeFolder);
    try {
      const stopping = await session.stop();
      expect(stopping.state).toBe('exited');
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe('the cgroup bounds the whole tree', () => {
  hostTest('a plugin that forks past the pids bound is recorded with the hits the kernel counted', async () => {
    const { outcome, counters } = await behaviour('pid-limit');
    expect(outcome.state).toBe('not-extracted');
    expect(counters.pidsMaxHits).toBeGreaterThan(0);
  }, 60_000);

  hostTest('a normal unit forks nothing past the pids bound', async () => {
    const { outcome, counters } = await behaviour('normal');
    expect(outcome.state).toBe('extracted');
    expect(counters.pidsMaxHits).toBe(0);
  }, 60_000);

  hostTest('a plugin that exceeds its memory is killed by the kernel, and the kill is recorded', async () => {
    const { outcome, counters } = await behaviour('memory');
    expect(outcome.state).toBe('not-extracted');
    expect(counters.oomKills).toBeGreaterThan(0);
    expect(counters.memoryPeakBytes).toBeGreaterThan(0);
  }, 60_000);

  hostTest('a normal unit stays inside its memory bound', async () => {
    const { outcome, counters } = await behaviour('normal');
    expect(outcome.state).toBe('extracted');
    expect(counters.oomKills).toBe(0);
    expect(counters.memoryPeakBytes).toBeLessThan(LIMITS.memoryBytes);
  }, 60_000);

  hostTest('a detached child that leaves the session is killed with the cgroup', async () => {
    const session = await open(probeFolder);
    try {
      const outcome = await session.runUnit(unit('setsid'));
      expect(partialCause(outcome)).toContain('setsid: child');
      expect(session.counters().pidsCurrent).toBeGreaterThan(1);
      await session.cancel();
      await Bun.sleep(300);
      expect(session.counters().pidsCurrent).toBe(0);
    } finally {
      await session.close();
    }
  }, 60_000);

  hostTest('a normal unit leaves no process behind it', async () => {
    const { outcome, counters } = await behaviour('normal');
    expect(outcome.state).toBe('extracted');
    expect(counters.pidsCurrent).toBeLessThan(12);
  }, 60_000);
});

describe('the sandbox refuses a way out', () => {
  hostTest('a plugin that opens a socket is refused by the seccomp filter', async () => {
    expect(partialCause((await behaviour('socket')).outcome)).toContain('refused (EPERM)');
  }, 60_000);

  hostTest('a plugin that writes outside its temporary folder is refused', async () => {
    expect(partialCause((await behaviour('write-outside')).outcome)).toContain('refused (EROFS)');
  }, 60_000);

  hostTest('a plugin that unshares a namespace is refused by the seccomp filter', async () => {
    expect(partialCause((await behaviour('unshare')).outcome)).toContain('unshare: returned -1, errno 1');
  }, 60_000);

  hostTest('a plugin that spawns a child process still works', async () => {
    // Bun hands a child its standard output through a socket pair: the filter allows that pair and refuses addresses.
    expect(partialCause((await behaviour('spawn')).outcome)).toContain('spawn: child-ok');
  }, 60_000);

  x64HostTest('a plugin that calls socket through the x32 ABI is refused on x86_64', async () => {
    expect(partialCause((await behaviour('x32-socket')).outcome)).toContain('x32-socket: returned -1, errno 38');
  }, 60_000);

  hostTest('a plugin that reads outside its snapshot sees nothing', async () => {
    expect(partialCause((await behaviour('read-outside')).outcome)).toContain('refused (ENOENT)');
  }, 60_000);

  hostTest('a normal unit reads its repository and writes its temporary folder', async () => {
    const { outcome } = await behaviour('normal');
    expect(outcome.state).toBe('extracted');
  }, 60_000);

  hostTest('a plugin that declared the filesystem right reads its repository', async () => {
    expect(partialCause((await behaviour('read-repo')).outcome)).toContain('read-repo: allowed');
  }, 60_000);

  hostTest('every request a plugin makes is recorded where the host dispatches it: answered, refused and its cause', async () => {
    const folder = join(FIXTURES, 'plugin-graph');
    // Answered: the host was given a graph, so the read the plugin declared is answered and its size is recorded.
    const answered = new RequestLog();
    const session = await open(folder, { requests: answered, graph: { files: async () => [{ kind: 'probe', key: { id: 'one' } }, { kind: 'probe', key: { id: 'two' } }], value: async () => null } });
    try {
      const outcome = await session.runUnit({ unitId: 'read-graph', kind: 'probe', key: { id: 'x', behavior: 'read-graph' } });
      expect(partialCause(outcome)).toContain('read-graph: 2 files');
    } finally {
      await session.close();
    }
    const kept = answered.finish();
    expect(kept.map((one) => [one.method, one.outcome])).toEqual([['introduce', 'answered'], ['graph.files', 'answered']]);
    expect(kept[1]?.size).toBe(2);
    // Refused: a host with no graph answers the same request with a refusal, and the record states its class.
    const refused = new RequestLog();
    const bare = await open(folder, { requests: refused });
    try {
      const outcome = await bare.runUnit({ unitId: 'read-graph', kind: 'probe', key: { id: 'x', behavior: 'read-graph' } });
      expect(partialCause(outcome)).toContain('read-graph: refused');
    } finally {
      await bare.close();
    }
    expect(refused.finish().map((one) => [one.method, one.outcome, one.cause])).toEqual([['introduce', 'answered', undefined], ['graph.files', 'refused', 'graph-denied']]);
  }, 60_000);

  hostTest('the consistency reads are answered when the contract declares them', async () => {
    const folder = join(FIXTURES, 'plugin-graph');
    const address = (kind: string, key: Record<string, string>, label: string) => ({ kind, key, label });
    const reference = { id: 'row-1', referrer: address('code.file', { path: 'a.ts' }, 'a.ts'), field: 'repository', target: address('code.repository', { name: 'missing' }, 'missing'), producer: 'git-tree@1' };
    const end = { edge: { kind: 'code.contains' }, from: address('code.directory', { path: 'src' }, 'src'), to: address('code.file', { path: 'a.ts' }, 'a.ts'), removed: ['to' as const] };
    const opinion = { entity: address('code.file', { path: 'a.ts' }, 'a.ts'), field: 'language', producer: 'linguist@9.5.0', opinion: '7' };
    const session = await open(folder, {
      graph: {
        files: async () => [], value: async () => null,
        unresolved: async () => ({ references: [reference] }), removedEnds: async () => ({ edges: [end] }), unevidenced: async () => ({ opinions: [opinion] }),
      },
    });
    try {
      const outcome = await session.runUnit({ unitId: 'read-consistency', kind: 'probe', key: { id: 'x', behavior: 'read-consistency' } });
      expect(partialCause(outcome)).toContain('read-consistency: 1 refs, 1 ends, 1 opinions');
    } finally {
      await session.close();
    }
  }, 60_000);

  hostTest('a plugin that declared no filesystem right sees no repository at all', async () => {
    // The same read the probe makes, by a plugin whose introduction declares graph reads and no filesystem right: the
    // host binds no /repo, so the file is not there (decision 0035, item 9).
    const folder = join(FIXTURES, 'plugin-graph');
    const session = await open(folder);
    try {
      const outcome = await session.runUnit({ unitId: 'read-repo', kind: 'probe', key: { id: 'x', behavior: 'read-repo' } });
      expect(partialCause(outcome)).toContain('read-repo: refused (ENOENT)');
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe('the debug journal\'s bound', () => {
  test('a request still waiting is abandoned, and a bound stops the record with one marker', () => {
    const log = new RequestLog(2, 1_000);
    const first = log.begin('graph.files');
    log.settle(first, 'answered', 4);
    log.begin('graph.value');
    // The third request passes the count's bound: nothing more is kept, and the entry says where it stopped.
    expect(log.begin('graph.files')).toBeUndefined();
    const kept = log.finish();
    expect(kept.map((one) => [one.method, one.outcome])).toEqual([['graph.files', 'answered'], ['graph.value', 'abandoned'], ['truncated', 'truncated']]);
    expect(kept[2]?.size).toBe(2);
    // A log that is emitted answers the same records on every read, and a slot settled afterwards changes nothing.
    log.settle(first, 'failed', 9);
    expect(log.finish()).toEqual(kept);
  });
});

describe('the closure and its trust', () => {
  hostTest('a closure changed after it was hashed is refused', async () => {
    const folder = scratch('madarch-plugin-changed-');
    cpSync(probeFolder, folder, { recursive: true });
    const closure = closureOf(folder);
    writeFileSync(join(folder, 'main.ts'), `${readFileSync(join(folder, 'main.ts'), 'utf8')}\n// changed after the hash\n`);
    let refusal: unknown;
    try {
      await open(folder, { releaseHashes: [closure.hash], work: scratch(), closure });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { code?: string }).code).toBe('closure-changed');
    expect((refusal as { message?: string }).message).toContain(folder);
    expect((refusal as { message?: string }).message).toContain('main.ts');
  }, 60_000);

  hostTest('an unchanged copy of the same closure runs', async () => {
    const folder = scratch('madarch-plugin-unchanged-');
    cpSync(probeFolder, folder, { recursive: true });
    const closure = closureOf(folder);
    const session = await open(folder, { releaseHashes: [closure.hash], work: scratch() });
    try {
      const outcome = await session.runUnit(unit('normal'));
      expect(outcome.state).toBe('extracted');
    } finally {
      await session.close();
    }
  }, 60_000);

  hostTest('a closure no release carries is refused as production, and runs as validation', async () => {
    let refusal: unknown;
    try {
      await open(probeFolder, { releaseHashes: [] });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { code?: string }).code).toBe('needs-approval');
    expect((refusal as { message?: string }).message).toContain(probeClosure.hash);
    const report = await checkConformance({ pluginFolder: probeFolder, workRoot: scratch(), cgroupParent: parent });
    expect(report.ok).toBe(true);
    expect(report.lines.map((line) => line.text.split(':')[0])).toEqual(['introduction', 'contract', 'unit conformance-1', 'pause', 'stop']);
  }, 90_000);
});

describe('the answer against the declaration', () => {
  hostTest('a result of an undeclared kind is refused with the place named', async () => {
    const { outcome } = await behaviour('undeclared');
    expect(outcome.state).toBe('not-extracted');
    if (outcome.state !== 'not-extracted') return;
    expect(outcome.cause.code).toBe('undeclared-kind');
    expect(outcome.cause.message).toContain('vertices[0].kind');
    expect(outcome.cause.message).toContain('stranger');
  }, 60_000);

  hostTest('a partial unit carrying removals has them dropped', async () => {
    const { outcome } = await behaviour('partial-removal');
    expect(outcome.state).toBe('extracted');
    if (outcome.state !== 'extracted') return;
    expect(outcome.result.end.state).toBe('partial');
    expect(outcome.result.removals).toEqual([]);
    expect(outcome.result.removalsDropped).toBe(1);
    const complete = await behaviour('normal');
    expect(complete.outcome.state).toBe('extracted');
    if (complete.outcome.state !== 'extracted') return;
    expect(complete.outcome.result.removals.length).toBe(1);
    expect(complete.outcome.result.removalsDropped).toBe(0);
  }, 90_000);
});

describe('the commands', () => {
  /** Runs one `madarch plugin` command in the checkout, as a person does. */
  async function command(args: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, 'scripts/madarch.ts', 'plugin', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, MADARCH_PLUGIN_CGROUP: parent, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }

  test('MADARCH_PLUGIN_SANDBOX=off checks the fixture without sandbox tools or cgroup delegation', async () => {
    const work = scratch();
    const done = await command(['check', probeFolder, '--unit', JSON.stringify(unit('normal')), '--work', work], {
      MADARCH_PLUGIN_SANDBOX: 'off', MADARCH_PLUGIN_CGROUP: join(work, 'no-cgroup'), MADARCH_TOOLS: join(work, 'no-tools'),
    });
    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toContain('check: conforms');
    expect(done.stdout).toContain('unit normal: extracted 1 vertices and 1 edges, complete');
    expect(done.stderr).toContain('MADARCH_PLUGIN_SANDBOX');
    expect(existsSync(join(work, 'no-tools'))).toBe(false);
    expect(existsSync(join(work, 'no-cgroup'))).toBe(false);
  }, 30_000);

  test.each(['', 'on', 'OFF', ' off '])('MADARCH_PLUGIN_SANDBOX=%j is refused with its value and source location', async (value) => {
    const done = await command(['check', probeFolder, '--work', scratch()], { MADARCH_PLUGIN_SANDBOX: value });
    expect(done.code).toBe(1);
    const message = `${done.stdout}\n${done.stderr}`;
    expect(message).toContain('MADARCH_PLUGIN_SANDBOX');
    expect(message).toContain(JSON.stringify(value));
    expect(message).toContain('unset');
    expect(message).toContain('off');
    expect(message).toMatch(new RegExp(`${fileURLToPath(new URL('../src/plugin/sandbox.ts', import.meta.url))}:\\d+:`));
  }, 30_000);

  test('disabling confinement does not approve a production closure', async () => {
    const done = await command(['run', probeFolder, '--repo', probeFolder, '--unit', JSON.stringify(unit('normal')), '--work', scratch()], { MADARCH_PLUGIN_SANDBOX: 'off' });
    expect(done.code).toBe(1);
    expect(done.stderr).toContain('needs-approval');
    expect(done.stderr).toContain(probeClosure.hash);
  }, 30_000);

  test('two plugin starts in a fresh host process emit one unconfined warning', async () => {
    const work = scratch();
    const source = `
      import { PluginHost } from ${JSON.stringify(fileURLToPath(new URL('../src/plugin/host.ts', import.meta.url)))};
      for (const n of [1, 2]) {
        const session = await new PluginHost({
          pluginFolder: ${JSON.stringify(probeFolder)}, repository: ${JSON.stringify(probeFolder)},
          workRoot: ${JSON.stringify(work)} + '/' + n, trust: 'validation',
          cgroupParent: ${JSON.stringify(join(work, 'no-cgroup'))},
        }).open();
        try {
          const outcome = await session.runUnit(${JSON.stringify(unit('normal'))});
          if (outcome.state !== 'extracted') throw new Error(JSON.stringify(outcome));
        } finally { await session.close(); }
        console.log('completed ' + n);
      }
    `;
    const child = Bun.spawn([process.execPath, '--eval', source], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off', MADARCH_TOOLS: join(work, 'no-tools') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim().split('\n')).toEqual(['completed 1', 'completed 2']);
    expect(stderr.split('\n').filter((line) => line.includes('MADARCH_PLUGIN_SANDBOX'))).toEqual([
      'Plugins run unconfined because MADARCH_PLUGIN_SANDBOX=off; they can read and write everything the user can.',
    ]);
    expect(existsSync(join(work, 'no-tools'))).toBe(false);
    expect(existsSync(join(work, 'no-cgroup'))).toBe(false);
  }, 30_000);

  hostTest('madarch plugin check holds the fixture to the protocol and publishes nothing', async () => {
    const done = await command(['check', join(FIXTURES, 'plugin-probe'), '--unit', JSON.stringify(unit('normal')), '--work', scratch()]);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('check: conforms');
    expect(done.stdout).toContain('unit normal: extracted 1 vertices and 1 edges, complete');
  }, 120_000);

  hostTest('madarch plugin run refuses a closure no release carries, naming the approval it needs', async () => {
    const done = await command(['run', join(FIXTURES, 'plugin-probe'), '--repo', probeFolder, '--unit', JSON.stringify(unit('normal')), '--work', scratch()]);
    expect(done.code).toBe(1);
    expect(done.stderr).toContain('needs-approval');
    expect(done.stderr).toContain(probeClosure.hash);
  }, 120_000);
});

describe('the concurrency setting', () => {
  hostTest('a plugin gets the smaller of the setting and what it declared, and never less than one', async () => {
    const many = await open(probeFolder, { limits: {} });
    const one = await open(probeFolder, { limits: {} });
    try {
      expect(many.unitsAtOnce).toBe(1);
      expect(one.unitsAtOnce).toBe(1);
    } finally {
      await many.close();
      await one.close();
    }
    const wide = new PluginHost({ pluginFolder: probeFolder, repository: probeFolder, workRoot: scratch(), trust: 'production', releaseHashes: [probeClosure.hash], limits: LIMITS, settings: { pluginsAtOnce: 1, unitsPerPlugin: 8 }, cgroupParent: parent });
    const session = await wide.open();
    try {
      expect(session.unitsAtOnce).toBe(2);
    } finally {
      await session.close();
    }
  }, 60_000);

  hostTest('units handed to one plugin keep their answers, and every answer comes back validated', async () => {
    const deafFolder = join(FIXTURES, 'plugin-deaf');
    const results = await runUnits({ repository: probeFolder, workRoot: scratch(), trust: 'production', releaseHashes: [probeClosure.hash, closureOf(deafFolder).hash], limits: LIMITS, settings: { pluginsAtOnce: 1, unitsPerPlugin: 2 }, cgroupParent: parent }, [
      { pluginFolder: probeFolder, unit: unit('normal') },
      { pluginFolder: probeFolder, unit: { ...unit('normal'), unitId: 'second', key: { id: 'second', behavior: 'partial-removal' } } },
      { pluginFolder: deafFolder, unit: unit('normal') },
    ]);
    expect(results.map((result) => result.pluginFolder)).toEqual([deafFolder, probeFolder]);
    const probe = results.find((result) => result.pluginFolder === probeFolder)!;
    expect(probe.units.map((outcome) => outcome.unitId).sort()).toEqual(['normal', 'second']);
    expect(probe.units.every((outcome) => outcome.state === 'extracted')).toBe(true);
  }, 90_000);
});

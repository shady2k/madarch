/**
 * The fixture plugin the plugin host's tests drive: one kind, one edge and a
 * behaviour per unit, chosen by the unit's `behavior` key. `normal` is the
 * run that must succeed beside every failing one.
 */
import { definePlugin, type Unit, type UnitResult, type VertexResult } from 'madarch-plugin-sdk';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi';

/** The C library the sandbox binds read-only: the fixture's one way to a call Bun has no wrapper for. */
const libc = dlopen('libc.so.6', {
  unshare: { args: [FFIType.i32], returns: FFIType.i32 },
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
  __errno_location: { args: [], returns: FFIType.ptr },
});

/** The errno the last C call left, as C left it. */
function errnoNow(): number {
  const pointer = libc.symbols.__errno_location();
  if (pointer === null) return -1;
  return new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true);
}

/** CLONE_NEWUSER, as `linux/sched.h` writes it. */
const CLONE_NEWUSER = 0x1000_0000;

/** x86_64's x32 ABI marks its calls with this bit in the number; socket is 41 there. */
const X32_SYSCALL_BIT = 0x4000_0000;
const X32_SOCKET = X32_SYSCALL_BIT + 41;

/** The behaviour a unit asks for, `normal` when it asks for none. */
function behaviorOf(unit: Unit): string {
  const held = unit.key['behavior'];
  return typeof held === 'string' ? held : 'normal';
}

/** A vertex of the probe kind, with two field values and the evidence they were read at. */
function probeVertex(id: string): VertexResult {
  return {
    kind: 'probe',
    key: { id },
    values: { size: 12, language: 'typescript' },
    evidence: { path: `probe/${id}.ts`, lineStart: 1, lineEnd: 2 },
  };
}

/** The answer `normal` returns: a vertex, an edge to it and a removal of a vertex that is gone. */
function normalAnswer(unit: Unit): UnitResult {
  return {
    vertices: [probeVertex(String(unit.key['id'] ?? 'one'))],
    edges: [{ kind: 'probe-link', from: { kind: 'probe', key: { id: String(unit.key['id'] ?? 'one') } }, to: { kind: 'probe', key: { id: 'two' } }, discriminator: '' }],
    removals: [{ kind: 'probe', key: { id: 'gone' } }],
    end: { state: 'complete' },
  };
}

/** Writes a flood of bytes no message may hold, and never answers. */
function flood(): void {
  const chunk = 'x'.repeat(64 * 1024);
  for (let at = 0; at < 64; at += 1) process.stdout.write(chunk);
}

/** Spawns detached children until the pids bound refuses, and says how many started. */
function forkPastTheLimit(): UnitResult {
  let started = 0;
  let refused = 0;
  for (let at = 0; at < 32; at += 1) {
    try {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      started += 1;
    } catch (error) {
      refused += 1;
    }
  }
  return { end: { state: 'partial', cause: `pids: ${String(started)} children started, ${String(refused)} refused` } };
}

/** Allocates more than the cgroup allows, so the kernel kills the tree. */
async function exhaustMemory(): Promise<UnitResult> {
  const held: Buffer[] = [];
  for (let at = 0; at < 64; at += 1) {
    const buffer = Buffer.alloc(16 * 1024 * 1024, 1);
    held.push(buffer);
  }
  return { end: { state: 'partial', cause: `memory: held ${String(held.length)} buffers` } };
}

/** One syscall the sandbox refuses, said as the unit's partial cause. */
function refused(name: string, work: () => void): UnitResult {
  try {
    work();
    return { end: { state: 'partial', cause: `${name}: allowed` } };
  } catch (error) {
    const held = error as NodeJS.ErrnoException;
    return { end: { state: 'partial', cause: `${name}: refused (${held.code ?? held.message})` } };
  }
}

await definePlugin({
  name: 'plugin-probe',
  version: '1.0.0',
  // The fixture reads its repository snapshot, so it declares that right: a plugin that declares none sees no /repo.
  filesystem: true,
  // The SDK's own heartbeat is off for the fixture (`no-heartbeat` needs a silent unit, and the pause test needs the
  // silence to outlast the host's deadline); a plugin that sends none is what the host's heartbeat deadline is for.
  heartbeatMs: 600_000,
  contract: {
    vertices: [
      { kind: 'probe', key: ['id'], fields: [{ name: 'size', type: 'integer', meaning: 'the size', example: 12, required: true }, { name: 'language', type: 'text', meaning: 'the language', example: 'typescript', required: false }] },
    ],
    edges: [{ kind: 'probe-link', from: 'probe', to: 'probe' }],
  },
  maxParallelUnits: 2,
  async extract(unit) {
    const behavior = behaviorOf(unit);
    if (behavior === 'normal') return normalAnswer(unit);
    if (behavior === 'partial-removal') {
      return { ...normalAnswer(unit), removals: [{ kind: 'probe', key: { id: 'gone' } }], end: { state: 'partial', cause: 'read half the unit' } };
    }
    if (behavior === 'undeclared') {
      return { vertices: [{ kind: 'stranger', key: { id: 'x' } }], end: { state: 'complete' } };
    }
    if (behavior === 'undeclared-field') {
      return { vertices: [{ kind: 'probe', key: { id: 'x' }, attributes: { colour: 'red' } }], end: { state: 'complete' } };
    }
    if (behavior === 'flood') {
      flood();
      await new Promise(() => undefined);
    }
    if (behavior === 'no-heartbeat') {
      await Bun.sleep(1_500);
      return normalAnswer(unit);
    }
    if (behavior === 'pid-limit') return forkPastTheLimit();
    if (behavior === 'memory') return await exhaustMemory();
    if (behavior === 'socket') {
      return refused('socket', () => {
        const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no') });
        void server.stop(true);
      });
    }
    if (behavior === 'write-outside') {
      return refused('write-outside', () => writeFileSync('/repo/written-by-the-plugin', 'x'));
    }
    if (behavior === 'read-outside') {
      return refused('read-outside', () => readFileSync('/etc/hostname', 'utf8'));
    }
    if (behavior === 'read-repo') {
      return refused('read-repo', () => readFileSync('/repo/plugin.json', 'utf8'));
    }
    if (behavior === 'unshare') {
      const result = libc.symbols.unshare(CLONE_NEWUSER);
      return { end: { state: 'partial', cause: `unshare: returned ${String(result)}, errno ${String(errnoNow())}` } };
    }
    if (behavior === 'x32-socket') {
      if (process.arch !== 'x64') return { end: { state: 'partial', cause: 'x32: not an x86_64 machine' } };
      const result = libc.symbols.syscall(BigInt(X32_SOCKET), 2n, 1n, 0n);
      return { end: { state: 'partial', cause: `x32-socket: returned ${String(result)}, errno ${String(errnoNow())}` } };
    }
    if (behavior === 'spawn') {
      const child = Bun.spawn([process.execPath, '-e', 'process.stdout.write("child-ok")'], { stdout: 'pipe', stderr: 'pipe' });
      const text = await new Response(child.stdout).text();
      await child.exited;
      return { end: { state: 'partial', cause: `spawn: ${text}` } };
    }
    if (behavior === 'setsid') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      return { end: { state: 'partial', cause: `setsid: child ${String(child.pid)} detached` } };
    }
    return { end: { state: 'partial', cause: `unknown behaviour ${behavior}` } };
  },
});

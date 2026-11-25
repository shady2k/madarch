/** Entry-owned private file context. Only intended Madarch children receive its path. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
export type StartupContext = { status: 'absent' | 'invalid' | 'unavailable' } | { status: 'ready'; collection: string; keyId: string; key: Buffer };
let captured: string | undefined;
let context: StartupContext = { status: 'absent' };
let entered = false;
export function startupEnabled(): boolean { return process.env.MADARCH_STARTUP_TIMING === '1' && process.env.MADARCH_TRACE !== 'off'; }
export function consumeStartupContext(): void {
 if (entered) return;
 entered = true;
 captured = process.env.MADARCH_STARTUP_CONTEXT;
 delete process.env.MADARCH_STARTUP_CONTEXT;
 if (!startupEnabled() || captured === undefined) return;
 context = { status: process.platform === 'win32' ? 'unavailable' : 'invalid' };
 if (process.platform === 'win32' || !isAbsolute(captured)) return;
 let fd: number | undefined;
 try {
  fd = openSync(captured, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) return;
  const buffer = Buffer.alloc(4097);
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  if (length > 4096) return;
  const value = JSON.parse(buffer.subarray(0, length).toString('utf8')) as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'collection,key,version' || value.version !== 1 || typeof value.collection !== 'string' || !validStartupOperation(value.collection) || typeof value.key !== 'string' || !hexOfLength(value.key, 64)) return;
  const key = Buffer.from(value.key, 'hex');
  context = { status: 'ready', collection: value.collection, key, keyId: createHmac('sha256', key).update('madarch.startup.key.v1').digest('hex').slice(0, 32) };
 } catch { /* invalid context never changes the command */ }
 finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* observation never changes the command */ } } }
}
export function startupIdentifiers(): { collection: string; keyId: string } | undefined {
 return context.status === 'ready' ? { collection: context.collection, keyId: context.keyId } : undefined;
}
export function startupContextFields(): { context: StartupContext['status']; collection?: string; keyId?: string } {
 return { context: context.status, ...startupIdentifiers() };
}
export function startupChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
 const result = { ...env }; delete result.MADARCH_STARTUP_CONTEXT;
 if (captured !== undefined) result.MADARCH_STARTUP_CONTEXT = captured;
 return result;
}
export function sanitizedStartupEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
 const result = { ...env }; delete result.MADARCH_STARTUP_CONTEXT; return result;
}
export function clusterDigest(path: string): string | undefined {
 if (context.status !== 'ready') return undefined;
 let ancestor = resolve(path); const suffix: string[] = [];
 try {
  for (;;) {
   try { ancestor = realpathSync(ancestor); break; }
   catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    const parent = dirname(ancestor); if (parent === ancestor) return undefined;
    suffix.unshift(basename(ancestor)); ancestor = parent;
   }
  }
  return createHmac('sha256', context.key).update('madarch.startup.cluster.v1\0').update(join(ancestor, ...suffix)).digest('hex');
 } catch { return undefined; }
}

function hexOfLength(value: string, length: number): boolean {
 return value.length === length && [...value.toLowerCase()].every(c => '0123456789abcdef'.includes(c));
}
export function validStartupOperation(value: unknown): value is string {
 if (typeof value !== 'string') return false;
 const groups = value.split('-');
 return groups.length === 5 && groups.every((group, i) => hexOfLength(group, [8,4,4,4,12][i]!));
}

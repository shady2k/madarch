/**
 * A child that will not leave must not keep a command alive: the api role a serve supervises, and the foreground serve a
 * walk watches, are both waited for through this bound — a pipe a descendant holds open is not a wait to keep.
 */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { stopChildWithin } from '../src/product/child-stop.js';

/* A child that ignores SIGTERM, so only the kill ends it. */
function stubborn(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('a child that ends on SIGTERM is answered at once', async () => {
  // A program that ends itself on SIGTERM and leaves nothing of its own behind.
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  await Bun.sleep(300);
  const started = performance.now();
  expect(await stopChildWithin({ pid: child.pid, kill: (signal) => child.kill(signal as NodeJS.Signals), exited: new Promise((answer) => child.once('close', answer)) }, { what: 'a plain child', graceMs: 10_000, killWaitMs: 1_000 })).toBe('ended');
  expect(performance.now() - started).toBeLessThan(10_000);
});

test('a child that ignores SIGTERM is killed, and the wait ends with it', async () => {
  const child = stubborn();
  // The handler is in place once the child has started; a signal sent before it is the default one.
  await Bun.sleep(300);
  const lines: string[] = [];
  const started = performance.now();
  const outcome = await stopChildWithin(
    { pid: child.pid, kill: (signal) => child.kill(signal as NodeJS.Signals), exited: new Promise((answer) => child.once('close', answer)) },
    { what: 'a child ignoring SIGTERM', graceMs: 300, killWaitMs: 5_000, log: (line) => lines.push(line) },
  );
  expect(outcome).toBe('killed');
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(lines.join('\n')).toContain('did not end within 300 ms of SIGTERM');
});

test('a child whose output a descendant holds open is named instead of waited for', async () => {
  // What `close` waits for: not the process, but its output — a descendant of a killed role can keep a pipe open.
  const child = spawn('sh', ['-c', 'sleep 60'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const started = performance.now();
  const outcome = await stopChildWithin(
    { pid: child.pid, kill: (signal) => child.kill(signal as NodeJS.Signals), exited: new Promise(() => { /* the pipe is held by a descendant */ }) },
    { what: 'a child whose output is held', graceMs: 200, killWaitMs: 200, log: (line) => lines.push(line) },
  );
  expect(outcome).toBe('stuck');
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(lines.join('\n')).toContain('still holds this process\'s output open');
  child.kill('SIGKILL');
});

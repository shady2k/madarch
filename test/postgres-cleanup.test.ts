import { expect, test } from 'bun:test';
import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterPaths, stopDatabasesUnder } from '../src/adapters/postgres-cluster.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

interface Notice {
  event: string;
  oldAlive?: boolean;
  newPid?: number;
  answering?: boolean;
  error?: string;
}

function peer(source: string) {
  const waiting = new Map<string, (notice: Notice) => void>();
  const received = new Map<string, Notice>();
  const child = Bun.spawn([process.execPath, '-e', source], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
    ipc(notice: Notice) {
      received.set(notice.event, notice);
      waiting.get(notice.event)?.(notice);
    },
  });
  const stderr = new Response(child.stderr).text();
  return {
    child, stderr,
    async notice(event: string): Promise<Notice> {
      const found = received.get(event);
      if (found !== undefined) return found;
      return await Promise.race([
        new Promise<Notice>((resolve) => waiting.set(event, resolve)),
        child.exited.then(async (code) => {
          throw new Error(`${import.meta.path}:43: child exited ${code} before ${event}: ${await stderr}`);
        }),
      ]);
    },
  };
}

test.skipIf(process.platform === 'win32')('an open in another process waits for the store cleanup', async () => {
  const knowledge = mkdtempSync(join(tmpdir(), 'postgres-cleanup-'));
  const store = join(knowledge, 'one', 'graph');
  const module = new URL('../src/adapters/postgres-cluster.ts', import.meta.url).href;
  const cleaner = peer(`
    import { clusterPaths, openCluster, stopDatabasesUnder } from ${JSON.stringify(module)};
    await openCluster(clusterPaths(${JSON.stringify(store)}));
    process.on('message', async () => {
      const cleanup = stopDatabasesUnder(${JSON.stringify(knowledge)}, { force: true });
      process.send({ event: 'cleanup-begun' });
      try { await cleanup; process.send({ event: 'cleaned' }); }
      catch (error) { process.send({ event: 'cleaned', error: String(error) }); }
    });
    process.send({ event: 'ready' });
  `);
  let opener: ReturnType<typeof peer> | undefined;
  let firstPid: number | undefined;
  let resumed = false;
  try {
    await cleaner.notice('ready');
    const paths = clusterPaths(store);
    const oldPid = Number(readFileSync(join(paths.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    firstPid = oldPid;
    expect(alive(oldPid)).toBe(true);
    opener = peer(`
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { clusterPaths, clusterQuery, openCluster, CLUSTER_ADMIN_DATABASE } from ${JSON.stringify(module)};
      function alive(pid) {
        try { process.kill(pid, 0); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
      }
      let opened;
      process.on('message', async (message) => {
        if (message === 'stop') { await opened?.stop(); process.send({ event: 'stopped' }); return; }
        try {
          const opening = openCluster(clusterPaths(${JSON.stringify(store)}));
          process.send({ event: 'opening' });
          opened = await opening;
          const oldAlive = alive(${oldPid});
          const newPid = Number(readFileSync(join(opened.dataDir, 'postmaster.pid'), 'utf8').split('\\n')[0]);
          const rows = await clusterQuery(opened, CLUSTER_ADMIN_DATABASE, 'SELECT 1 AS value');
          process.send({ event: 'opened', oldAlive, newPid, answering: rows[0]?.value === 1 });
        } catch (error) { process.send({ event: 'opened', error: String(error) }); }
      });
      process.send({ event: 'ready' });
    `);
    await opener.notice('ready');
    // The stopped postmaster holds shutdown open after cleanup takes the exclusive users lock.
    process.kill(firstPid, 'SIGSTOP');
    cleaner.child.send('cleanup');
    await cleaner.notice('cleanup-begun');
    const library = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const users = openSync(join(store, 'pgdata.users'), 'a+');
    try {
      // LOCK_SH | LOCK_NB cannot be granted while cleanup holds LOCK_EX.
      const deadline = Date.now() + 5_000;
      while (library.symbols.flock(users, 1 | 4) === 0) {
        library.symbols.flock(users, 8);
        if (Date.now() >= deadline) throw new Error(`${import.meta.path}:111: cleanup did not take ${join(store, 'pgdata.users')}`);
        await Bun.sleep(10);
      }
    } finally { closeSync(users); library.close(); }
    opener.child.send('open');
    await opener.notice('opening');
    process.kill(firstPid, 'SIGCONT');
    resumed = true;
    const opened = await opener.notice('opened');
    expect(opened.error).toBeUndefined();
    expect(opened.oldAlive).toBe(false);
    expect(opened.newPid).not.toBe(oldPid);
    expect(alive(opened.newPid!)).toBe(true);
    expect(opened.answering).toBe(true);
    expect((await cleaner.notice('cleaned')).error).toBeUndefined();
    opener.child.send('stop');
    await opener.notice('stopped');
    opener.child.kill('SIGKILL');
    await opener.child.exited;
    expect((await opener.stderr).toLowerCase()).not.toContain('shutting down');
  } finally {
    if (firstPid !== undefined && !resumed) {
      try { process.kill(firstPid, 'SIGCONT'); } catch { /* already stopped */ }
    }
    for (const child of [opener?.child, cleaner.child]) {
      child?.kill('SIGKILL');
      await child?.exited;
    }
    await stopDatabasesUnder(knowledge, { force: true });
  }
}, 30_000);

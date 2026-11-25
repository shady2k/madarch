import { startupChildEnv } from '../../src/obs/startup-context.js';
import * as logging from '../../src/obs/log.js';
const { startupEntry } = logging;
const withStartupPreparation = (logging as Partial<typeof logging>).withStartupPreparation ?? (<T>(_dataDir: string, work: () => T): T => work());
import { openCluster, clusterPaths, stopStoreForExit, stopDatabasesUnderSync } from '../../src/adapters/postgres-cluster.js';
import { Client } from 'pg';
import { createDatabaseOwner } from '../../src/adapters/database-owner.js';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { postgresInstallFolder } from '../../src/adapters/postgres-builds.js';
import { join, dirname } from 'node:path';
startupEntry('fixture');
const store = process.argv[2]!;
const mode = process.argv[3]!;
const paths = clusterPaths(store);
const external = () => {
 const pid = Number(readFileSync(join(paths.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
 const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
 return { pid, ticks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
};
const { openTrace, closeTrace } = await import('../../src/obs/trace.js');
const runTrace = mode === 'schema' ? openTrace({ store: join(store, 'evidence'), runId: 'startup-fixture' }) : undefined;
const cluster = await openCluster(paths);
console.log(JSON.stringify({ external: external() }));
if (mode === 'schema' || mode === 'lost-ack') {
 const owner = await createDatabaseOwner({ cluster: { socketDir: paths.socketDir }, database: 'trace_fixture' });
 try {
  await owner.run(async tx => await tx.query('CREATE TABLE trace_rows (id integer PRIMARY KEY, parent integer REFERENCES trace_rows(id) DEFERRABLE INITIALLY DEFERRED)'));
  if (mode === 'lost-ack') {
   const original = Client.prototype.query;
   let cut = false;
   const observer = new Client({ host: paths.socketDir, port: cluster.port, user: cluster.user, database: 'trace_fixture' });
   await observer.connect();
   const sentinel = new Error('fixture transport cut after COMMIT dispatch');
   Client.prototype.query = function (this: Client, ...args: unknown[]) {
    if (args[0] !== 'COMMIT' || cut) return original.apply(this, args as Parameters<typeof original>);
    cut = true;
    const connection = (this as unknown as { connection: { stream: { pause(): void; destroy(error: Error): void } } }).connection;
    connection.stream.pause();
    const result = original.apply(this, args as Parameters<typeof original>);
    console.log(JSON.stringify({ commitDispatched: true, ackPaused: true }));
    void (async () => {
     try {
      for (let attempt = 0; attempt < 200; attempt++) {
       const answer = await observer.query('SELECT id FROM trace_rows WHERE id = 8');
       if (answer.rows.length === 1) { console.log(JSON.stringify({ independentlyPersisted: true })); break; }
       await Bun.sleep(5);
      }
     } finally { connection.stream.destroy(sentinel); }
    })();
    return result;
   } as typeof original;
   try {
    await withStartupPreparation(paths.dataDir, async () => await owner.transaction('write', async tx => { await tx.query('INSERT INTO trace_rows VALUES (8, NULL)'); }));
   } catch (error) { console.log(JSON.stringify({ connectionException: error instanceof Error, sameException: error === sentinel })); }
   finally { Client.prototype.query = original; await observer.end(); }
  } else {
  const observer = new Client({ host: paths.socketDir, port: cluster.port, user: cluster.user, database: 'trace_fixture' });
  await observer.connect();
  try {
  await withStartupPreparation(paths.dataDir, async () => {
   await owner.transaction('write', async tx => { await tx.query('INSERT INTO trace_rows VALUES (1, NULL)'); });
   console.log(JSON.stringify({ committed: (await observer.query('SELECT id FROM trace_rows')).rows.length === 1 }));
   const sentinel = new Error('fixture callback');
   try { await owner.transaction('write', async tx => { await tx.query('INSERT INTO trace_rows VALUES (2, NULL)'); throw sentinel; }); }
   catch (error) { console.log(JSON.stringify({ original: error === sentinel })); }
   try { await owner.transaction('write', async tx => { await tx.query('INSERT INTO trace_rows VALUES (3, 999)'); }); }
   catch (error) { const pg = error as { severity: string; code: string }; console.log(JSON.stringify({ severity: pg.severity, code: pg.code })); }
   await owner.transaction('snapshot', async tx => { await tx.query('SELECT id FROM trace_rows'); });
   console.log(JSON.stringify({ rollbackAbsent: (await observer.query('SELECT id FROM trace_rows WHERE id IN (2,3)')).rows.length === 0 }));
  });
  } finally { await observer.end(); }
  }
 } finally { await owner.close(); await cluster.stop(); if (runTrace) { closeTrace(runTrace); console.log(JSON.stringify({ spans: readFileSync(runTrace.file, 'utf8') })); } }
} else if (['held-zero', 'held-one', 'released', 'sync-sigstop', 'sync-positive', 'gone-nonzero'].includes(mode)) {
 const originalTools = process.env['MADARCH_TOOLS'];
 const realCtl = join(cluster.bin, 'pg_ctl');
 const tools = join(store, 'fixture-tools');
 process.env['MADARCH_TOOLS'] = tools;
 const bin = join(postgresInstallFolder(process.env), 'bin'); mkdirSync(bin, { recursive: true });
 const command = mode === 'gone-nonzero' ? `"${realCtl}" "$@"; exit 7` : mode === 'released' ? 'mv "$2/postmaster.pid" "$2/saved.pid"; exit 0' : `exit ${mode === 'held-zero' ? 0 : 1}`;
 writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
 try {
  await stopStoreForExit(store, { force: true });
  if (mode.startsWith('sync-')) {
   if (originalTools === undefined) delete process.env['MADARCH_TOOLS']; else process.env['MADARCH_TOOLS'] = originalTools;
   const subject = external();
   try {
    if (mode === 'sync-sigstop') process.kill(subject.pid, 'SIGSTOP');
    stopDatabasesUnderSync(dirname(dirname(store)));
   } finally { if (mode === 'sync-sigstop') { process.kill(subject.pid, 'SIGCONT'); console.log(JSON.stringify({ resumed: true })); } }
  }
 } finally {
  const saved = join(paths.dataDir, 'saved.pid'); if (existsSync(saved)) renameSync(saved, join(paths.dataDir, 'postmaster.pid'));
  if (originalTools === undefined) delete process.env['MADARCH_TOOLS']; else process.env['MADARCH_TOOLS'] = originalTools;
  await stopStoreForExit(store, { force: true });
 }
} else if (mode === 'reuse') {
 const peer = Bun.spawn([process.execPath, join(import.meta.dir, 'startup-slices.ts'), store, 'peer'], { env: startupChildEnv({ ...process.env }), stdout: 'inherit', stderr: 'inherit' });
 await peer.exited;
 await cluster.stop();
} else if (mode === 'peer') {
 await cluster.stop();
} else {
 await stopStoreForExit(store, { force: true });
 await cluster.stop();
}

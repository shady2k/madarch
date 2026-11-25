import { startupEntry, withStartupContext, withStartupPreparation } from '../../src/obs/log.js';
import { openCluster, clusterPaths } from '../../src/adapters/postgres-cluster.js';
import { createDatabaseOwner } from '../../src/adapters/database-owner.js';
import { Client } from 'pg';
startupEntry('fixture');
const paths = clusterPaths(process.argv[2]!);
const cluster = await openCluster(paths);
const owner = await createDatabaseOwner({ cluster: { socketDir: paths.socketDir }, database: 'response_fixture' });
const original = Client.prototype.query;
const cases = [
 { id: 'error-rejection', severity: 'ERROR', code: '23503' },
 { id: 'statement-unknown', severity: 'ERROR', code: '40003' },
 { id: 'connection-failure', severity: 'ERROR', code: '08006' },
 { id: 'protocol-failure', severity: 'ERROR', code: '08P01' },
 { id: 'fatal', severity: 'FATAL', code: '23503' },
 { id: 'panic', severity: 'PANIC', code: '23503' },
 { id: 'missing-severity', code: '23503' },
 { id: 'missing-code', severity: 'ERROR' },
 { id: 'disconnect' },
 { id: 'rollback-tag', tag: 'ROLLBACK' },
 { id: 'other-tag', tag: 'SELECT' },
 { id: 'missing-tag', tag: '' },
 { id: 'rollback-failure', rollback: 'throw' },
 { id: 'rollback-other-tag', rollback: 'tag' },
] as const;
try {
 for (const input of cases) {
  // One callback rejects with an arbitrary object, not just an Error instance.
  const sentinel = input.id === 'rollback-other-tag' ? { callback: 'controlled refusal' } : Object.assign(new Error('controlled command response'), input);
  const rollbackError = new Error('controlled rollback failure');
  let commitCalls = 0;
  let rollbackCalls = 0;
  let releases = 0;
  let releasePreserved = false;
  let sameException = false;
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
   if (typeof args[0] === 'string' && args[0].startsWith('BEGIN')) {
    const client = this as Client & { release(error?: Error): void };
    const release = client.release;
    client.release = (error?: Error) => { releases++; releasePreserved = error === ('rollback' in input && input.rollback === 'throw' ? rollbackError : undefined); client.release = release; release.call(client, error); };
   }
   if (args[0] === 'COMMIT') {
    commitCalls++;
    if ('tag' in input) {
     // End the real transaction, but control only the result delivered to the owner.
     return (original.apply(this, ['ROLLBACK'] as unknown as Parameters<typeof original>) as unknown as Promise<{ rows: unknown[]; command: string }>).then(result => ({ ...result, command: input.tag || undefined }));
    }
    return Promise.reject(sentinel);
   }
   if (args[0] === 'ROLLBACK') {
    rollbackCalls++;
    const result = original.apply(this, args as Parameters<typeof original>) as unknown as Promise<{ rows: unknown[]; command: string }>;
    if ('rollback' in input) return result.then(answer => { if (input.rollback === 'throw') throw rollbackError; return { ...answer, command: 'SELECT' }; });
    return result;
   }
   return original.apply(this, args as Parameters<typeof original>);
  } as typeof original;
  try {
   await withStartupContext(input.id, async () => await withStartupPreparation(paths.dataDir, async () => await owner.transaction('write', async tx => {
    await tx.query('SELECT 1');
    if ('rollback' in input) throw sentinel;
   })));
  } catch (error) { sameException = error === sentinel; }
  finally { Client.prototype.query = original; }
  console.log(JSON.stringify({ responseCase: input.id, controlledResponse: true, commitCalls, rollbackCalls, releases, releasePreserved, sameException }));
 }
} finally { Client.prototype.query = original; await owner.close(); await cluster.stop(); }

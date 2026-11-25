/** A real API role owns one scratch cluster through its normal HTTP lifecycle. */
import { mock } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
import { openCluster, clusterPaths } from '../../src/adapters/postgres-cluster.js';
const configuration = process.env.STARTUP_HANDOVER_CONFIG;
if (configuration !== undefined && process.argv.includes('--role') && process.argv.includes('fill')) {
 const config = JSON.parse(readFileSync(configuration, 'utf8')) as { fillRoot: string; receipts: string };
 // The API-owned bare PostgreSQL fixture is not a prepared fill store. Keep the
 // real fill role alive, but do not let its catalogue repeatedly open that store.
 process.env.MADARCH_KNOWLEDGE_ROOT = config.fillRoot;
 appendFileSync(config.receipts, JSON.stringify({ event: 'fill-catalogue-isolated', pid: process.pid }) + '\n');
}
if (configuration !== undefined && process.argv.includes('--role') && process.argv.includes('api')) {
 const config = JSON.parse(readFileSync(configuration, 'utf8')) as { store: string; receipts: string };
 const http = await import('../../src/server/http.js');
 const startServer = http.startServer;
 mock.module('../../src/server/http.js', () => ({ ...http, startServer: async (...args: Parameters<typeof http.startServer>) => {
  const server = await startServer(...args);
  const cluster = await openCluster(clusterPaths(config.store));
  appendFileSync(config.receipts, JSON.stringify({ event: 'api-cluster-open', pid: process.pid }) + '\n');
  const stop = async () => {
   await server.stop();
   await cluster.stop();
   appendFileSync(config.receipts, JSON.stringify({ event: 'api-cluster-close', pid: process.pid }) + '\n');
  };
  // Standalone API serve intentionally leaves signal ownership to its parent.
  // Keep the fixture resource on the same HTTP close path when that parent signals it.
  if (process.argv.includes('serve')) process.once('SIGTERM', () => { void stop().then(() => process.exit(143)); });
  return { ...server, stop };
 } }));
}

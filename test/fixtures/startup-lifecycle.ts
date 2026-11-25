/** Real daemon control with a held port between pick and bind. */
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { startupEntry } from '../../src/obs/log.js';
import { ensureDaemon, answersAsDaemon } from '../../src/product/daemon.js';
startupEntry('fixture');
const home = process.argv[2]!;
const mode = process.argv[3]!;
if (mode.startsWith('lock-')) {
 const { openCluster, clusterPaths } = await import('../../src/adapters/postgres-cluster.js');
 const { join } = await import('node:path');
 try {
  const cluster = await openCluster(clusterPaths(join(home, 'store')));
  console.log(JSON.stringify({ opened: true })); await cluster.stop();
 } catch (error) {
  console.log(JSON.stringify({ originalFilesystemError: error instanceof Error && error.message === 'fixture lock filesystem failure', code: (error as NodeJS.ErrnoException).code }));
 }
} else if (mode === 'proof') {
 let foreign = true; let requests = 0;
 const token = 'fixture-proof-token';
 const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
  requests++;
  const nonce = new URL(request.url).searchParams.get('nonce')!;
  return Response.json({ proof: foreign ? 'foreign' : createHmac('sha256', token).update(nonce).digest('hex') });
 } });
 try {
  const invalid = await answersAsDaemon(server.port!, token); foreign = false;
  const valid = await answersAsDaemon(server.port!, token);
  console.log(JSON.stringify({ invalid, valid, requests }));
 } finally { server.stop(true); }
} else {
 const holder = createServer(socket => socket.destroy());
 await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
 const address = holder.address(); if (!address || typeof address === 'string') throw new Error('missing held port');
 const taken = address.port;
 let first = true; const picks: number[] = [];
 try {
  const result = await ensureDaemon({ home, port: 0, print: () => {},
   pickPort: async () => {
    if (picks.length === 0) { picks.push(taken); return taken; }
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address(); if (!address || typeof address === 'string') throw new Error('missing free port');
    await new Promise<void>(resolve => probe.close(() => resolve())); picks.push(address.port); return address.port;
   },
   addressHeld: async port => { if (port === taken && first) { first = false; return false; } return port === taken; },
  });
  console.log(JSON.stringify({ result, picks }));
 } finally { await new Promise<void>(resolve => holder.close(() => resolve())); }
}

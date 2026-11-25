import { startupEntry, startupBegin } from '../../src/obs/log.js';
startupEntry('fixture');
const end = startupBegin('privacy');
const { openCluster, clusterPaths, stopStoreForExit } = await import('../../src/adapters/postgres-cluster.js');
const store = process.argv[2]!;
const running = await openCluster(clusterPaths(store));
await stopStoreForExit(store, { force: true }); // real Bun.spawn pg_ctl
await running.stop();
const second = await openCluster(clusterPaths(store));
const { stopDatabasesUnderSync } = await import('../../src/adapters/postgres-cluster.js');
stopDatabasesUnderSync(process.argv[3]!); // real synchronous pg_ctl with verified positive probe
await second.stop();
end('ok');

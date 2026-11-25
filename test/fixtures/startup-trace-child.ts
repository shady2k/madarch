import * as logging from '../../src/obs/log.js';
const api = logging as unknown as {
 startupEntry: (role: string) => void;
 startupBegin: (phase: string, dataDir?: string) => (outcome: string) => void;
};
if (typeof api.startupEntry !== 'function' || typeof api.startupBegin !== 'function') {
 console.error('ASSERTION: typed startup entry and pairs are missing'); process.exit(1);
}
if (process.argv[3] === 'windows') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
api.startupEntry('fixture');
if (process.argv[3] === 'failure') {
 const { openCluster, clusterPaths } = await import('../../src/adapters/postgres-cluster.js');
 try { await openCluster({ ...clusterPaths(process.argv[2]!), bin: process.argv[4]! }); process.exitCode = 9; }
 catch { console.log('EXPECTED-COMMAND-FAILURE'); }
} else if (process.argv[3] === 'hold') {
 const { openCluster, clusterPaths } = await import('../../src/adapters/postgres-cluster.js');
 const cluster = await openCluster(clusterPaths(process.argv[2]!)); console.log('held');
 const reader = Bun.stdin.stream().getReader(); await reader.read(); await reader.cancel(); await cluster.stop();
} else if (process.argv[3] === 'reuse') {
 const { openCluster, clusterPaths } = await import('../../src/adapters/postgres-cluster.js');
 const cluster = await openCluster(clusterPaths(process.argv[2]!)); await cluster.stop();
} else if (process.argv[3] === 'cluster') {
 const { openCluster } = await import('../../src/adapters/postgres-cluster.js');
 const { clusterPaths } = await import('../../src/adapters/postgres-cluster.js');
 const store = process.argv[2]!;
 const [first, second] = await Promise.all([openCluster(clusterPaths(store)), openCluster(clusterPaths(store))]);
 const third = await openCluster(clusterPaths(store));
 await third.stop(); await second.stop(); await first.stop();
} else {
 const end = api.startupBegin('fixture', process.argv[2]);
 console.log(JSON.stringify({ ticks: (await import('node:fs')).readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19] }));
 end('ok');
}

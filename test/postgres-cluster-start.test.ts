import { expect, test } from 'bun:test';
import { clusterStartInvocation } from '../src/adapters/postgres-cluster.js';

test('Windows startup does not pipe inherited server handles or wait through pg_ctl', () => {
  const start = clusterStartInvocation('C:\\store with spaces\\pgdata', 'C:\\store with spaces\\postgres.log', '-h 127.0.0.1 -p 49152', 'win32');
  expect(start.stdio).toBe('ignore');
  expect(start.args).toEqual(['-D', 'C:\\store with spaces\\pgdata', '-W', '-l', 'C:\\store with spaces\\postgres.log', '-t', '60', '-o', '-h 127.0.0.1 -p 49152', 'start']);
});

test.each(['linux', 'darwin'] as const)('%s retains piped pg_ctl output and its readiness wait', (platform) => {
  const start = clusterStartInvocation('/store/pgdata', '/store/postgres.log', '-k /socket', platform);
  expect(start.stdio).toBe('pipe');
  expect(start.args).toEqual(['-D', '/store/pgdata', '-w', '-l', '/store/postgres.log', '-t', '60', '-o', '-k /socket', 'start']);
});

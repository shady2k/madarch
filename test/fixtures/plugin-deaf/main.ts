/**
 * A fixture plugin that introduces itself and then ignores everything: stop
 * does not end it, so the host's grace period must become a cancel of the
 * whole tree. It reads its input and answers nothing.
 */
const introduce = {
  jsonrpc: '2.0',
  id: 'introduce',
  method: 'introduce',
  params: {
    protocol: 'madarch.plugins/2',
    name: 'plugin-deaf',
    version: '1.0.0',
    rights: { network: 'none' },
    limits: { maxParallelUnits: 1 },
    outputs: { vertices: [{ kind: 'probe', key: ['id'] }], edges: [] },
  },
};
process.stdout.write(`${JSON.stringify(introduce)}\n`);
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => undefined);
setInterval(() => undefined, 1_000);

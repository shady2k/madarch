/**
 * A fixture plugin that introduces itself and then ignores everything: stop
 * does not end it, so the host's grace period must become a cancel of the
 * whole tree. It reads its input and answers nothing.
 *
 * The protocol it speaks is the SDK's own constant, never a copy: a message the
 * host does not hold fails the handshake, and a fixture frozen on an older
 * version tests the refusal instead of the grace period.
 */
import { PROTOCOL_VERSION } from 'madarch-plugin-sdk';

const introduce = {
  jsonrpc: '2.0',
  id: 'introduce',
  method: 'introduce',
  params: {
    protocol: PROTOCOL_VERSION,
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

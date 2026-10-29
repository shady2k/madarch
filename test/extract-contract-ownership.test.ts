/**
 * The service a contract's operation belongs to (madarch-m38l.19, the review's sixth finding): when
 * the operation's servers resolve to one local service, the operation node carries that service, so
 * the Problems page judges every route of the service against the contract even when no route of it
 * matched an operation. Ownership is read from the contract and the code's listeners, never from a
 * route that happens to match.
 */
import { describe, expect, test } from 'bun:test';
import { extractContracts } from '../src/extract/contracts/index.js';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import type { TreeReader } from '../src/extract/records.js';

const tree = (files: Readonly<Record<string, string>>): TreeReader => ({
  paths: Object.keys(files).sort(),
  read(path) {
    const value = files[path];
    if (value === undefined) throw new Error(`${import.meta.path}: the fixture holds no ${path}`);
    return new TextEncoder().encode(value);
  },
});

const handler = 'function status(req: unknown, res: {send(s: string): void}) {res.send("ok");}';
const extract = async (files: Readonly<Record<string, string>>) => {
  const shared = await extractCodeWithFacts(tree(files));
  return extractContracts(tree(files), shared.extraction, shared.facts);
};

describe('a contract operation\'s service', () => {
  test('the server authority that resolves to one local service is written on the operation, with no matching route', async () => {
    const result = await extract({
      'orders/package.json': '{"name":"orders"}',
      'orders/src/routes.ts': `import express from "express";${handler}const app = express();app.get("/new", status);app.listen(8080);`,
      'contracts/openapi/orders.yaml': 'openapi: 3.0.0\ninfo: {title: Orders, version: 1.0.0}\nservers: [{url: "http://orders:8080"}]\npaths:\n  /orders:\n    get: {operationId: listOrders}\n',
    });
    const operation = result.nodes.find((node) => node.kind === 'code.operation');
    expect(operation?.properties['service']).toBe('orders');
    // The route `/new` matches no operation: there is no serves edge to derive coverage from.
    expect(result.edges.filter((edge) => edge.type === 'code.serves')).toEqual([]);
  });

  test('an authority that names no local service or more than one owns nothing, and an operation without servers owns nothing', async () => {
    const one = await extract({
      'orders/package.json': '{"name":"orders"}',
      'orders/src/routes.ts': `import express from "express";${handler}const app = express();app.get("/new", status);app.listen(8080);`,
      'contracts/openapi/orders.yaml': 'openapi: 3.0.0\ninfo: {title: Orders, version: 1.0.0}\nservers: [{url: "http://elsewhere.example:9999"}]\npaths:\n  /orders:\n    get: {operationId: listOrders}\n',
    });
    expect(one.nodes.find((node) => node.kind === 'code.operation')?.properties['service']).toBeUndefined();

    const none = await extract({
      'orders/package.json': '{"name":"orders"}',
      'orders/src/routes.ts': `import express from "express";${handler}const app = express();app.get("/new", status);app.listen(8080);`,
      'contracts/openapi/orders.yaml': 'openapi: 3.0.0\ninfo: {title: Orders, version: 1.0.0}\npaths:\n  /orders:\n    get: {operationId: listOrders}\n',
    });
    expect(none.nodes.find((node) => node.kind === 'code.operation')?.properties['service']).toBeUndefined();
  });
});

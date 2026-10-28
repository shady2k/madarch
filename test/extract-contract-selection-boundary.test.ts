import {describe, expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import type {Extraction, TreeReader} from '../src/extract/records.js';

const client = 'src/client.ts';
const alpha = 'contracts/openapi/alpha.yaml';
const beta = 'contracts/openapi/beta.yaml';
const operation = (path: string) => `code.operation:${path}#GET:/status`;
const contract = (server?: string) => `openapi: 3.0.0
info: {title: Status, version: 1.0.0}
${server === undefined ? '' : `servers: [{url: "${server}"}]
`}paths:
  /status:
    get: {operationId: status}
`;
const cancelOperation = (path: string) => `code.operation:${path}#POST:/orders/{id}/cancel`;
const cancelContract = (route = '/orders/{id}/cancel', server?: string) => `openapi: 3.0.0
info: {title: Orders, version: 1.0.0}
${server === undefined ? '' : `servers: [{url: "${server}"}]
`}paths:
  ${route}:
    post: {operationId: cancelOrder}
`;
const tree = (files: Readonly<Record<string, string>>): TreeReader => ({
  paths: Object.keys(files).sort(),
  read(path) { const value = files[path]; if (value === undefined) throw new Error(`missing fixture ${path}`); return new TextEncoder().encode(value); },
});
const remote = (result: Extraction) => result.edges.filter(edge => edge.type === 'code.calls-remote');
const claimed = (result: Extraction) => remote(result).filter(edge => !edge.properties.summary);
const extract = async (files: Readonly<Record<string, string>>) => {
  const input = tree(files); const shared = await extractCodeWithFacts(input);
  return extractContracts(input, shared.extraction, shared.facts);
};
const expectAmbiguity = (result: Extraction, path: string, line: number) => {
  expect(remote(result), `${import.meta.path}: unexpected remote target (${path}:${line})`).toEqual([]);
  expect(result.gaps.some(gap => gap.path === path && gap.reason.includes(`line ${line}:`) && gap.reason.includes('ambiguous contract selection') && gap.reason.includes(operation(alpha)) && gap.reason.includes(operation(beta))), `${import.meta.path}: missing located ambiguity (${path}:${line})
${JSON.stringify(result.gaps)}`).toBe(true);
};

describe('HTTP contract selection uses parsed call evidence', () => {
  test('a relative URL preserves the unique contract operation', async () => {
    const result = await extract({[alpha]: contract(), [client]: 'export function status() { return fetch("/status"); }'});
    expect(claimed(result).map(edge => edge.to)).toEqual([operation(alpha)]);
    expect(claimed(result)[0]?.span).toMatchObject({path: client, lineStart: 1});
  });

  test('an absolute URL selects its own server among contracts with the same route', async () => {
    const result = await extract({
      [alpha]: contract('https://alpha.example.test'), [beta]: contract('https://beta.example.test'),
      [client]: `// ${beta}
export function status() { return fetch("https://alpha.example.test/status"); }`,
    });
    expect(claimed(result).map(edge => edge.to)).toEqual([operation(alpha)]);
    expect(claimed(result)[0]?.span).toMatchObject({path: client, lineStart: 2});
  });

  for (const [label, prefix] of [
    ['a comment', `// generated from ${alpha}`],
    ['an ordinary string', `const documentation = "${alpha}";`],
    ['a path-shaped unused import', `import document from "../${alpha}";`],
    ['no provenance', ''],
  ] as const) {
    test(`${label} cannot select one of two contracts or fall back to a route`, async () => {
      const result = await extract({
        [alpha]: contract(), [beta]: contract(),
        [client]: `${prefix}
export function status() { return fetch("/status"); }`,
        'src/server.ts': 'import express from "express"; export function start() { const app = express(); app.get("/status", (req: any, res: any) => res.send("ok")); app.listen(8080); }',
      });
      expect(result.nodes.filter(node => node.kind === 'code.route')).toHaveLength(1);
      expectAmbiguity(result, client, prefix === '' ? 1 : 2);
    });
  }

  test('a real imported generated client keeps an ambiguous internal fetch as a gap', async () => {
    const generated = 'src/generated/status.ts';
    const input = tree({
      [alpha]: contract(), [beta]: contract(),
      [client]: 'import {status} from "./generated/status"; export function read() { return status(); }',
      [generated]: `// generated from ${alpha}
export function status() { return fetch("/status"); }`,
    });
    const shared = await extractCodeWithFacts(input);
    expect(shared.facts.imports.some(imported => imported.path === client && imported.targetPath === generated)).toBe(true);
    expectAmbiguity(await extractContracts(input, shared.extraction, shared.facts), generated, 2);
  });

  test('a real imported client with an exact parsed origin retains the remote operation', async () => {
    const generated = 'src/generated/status.ts';
    const input = tree({
      [alpha]: contract('https://alpha.example.test'), [beta]: contract('https://beta.example.test'),
      [client]: 'import {status} from "./generated/status"; export function read() { return status(); }',
      [generated]: 'export function status() { const origin = "https://alpha.example.test"; return fetch(`${origin}/status`); }',
    });
    const shared = await extractCodeWithFacts(input);
    expect(shared.facts.imports.some(imported => imported.path === client && imported.targetPath === generated)).toBe(true);
    const result = await extractContracts(input, shared.extraction, shared.facts);
    expect(claimed(result).map(edge => ({from: edge.from, to: edge.to}))).toEqual([{from: `code.symbol:${generated}#status`, to: operation(alpha)}]);
    const missing = freezeCodeFacts({...shared.facts, calls: shared.facts.calls.filter(call => call.path !== generated)});
    const incomplete = await extractContracts(input, shared.extraction, missing);
    expect(remote(incomplete)).toEqual([]);
    expect(incomplete.gaps.some(gap => gap.path === generated && gap.reason.includes('line 1: HTTP URL is unresolved'))).toBe(true);
  });

  test('a dynamic leading base preserves the known relative path and unique operation', async () => {
    const result = await extract({[alpha]: contract(), [client]: 'export function status(origin: string) { return fetch(`${origin}/status`); }'});
    expect(claimed(result).map(edge => edge.to)).toEqual([operation(alpha)]);
  });

  test('a dynamic leading base cannot select among contracts sharing the parsed suffix', async () => {
    const result = await extract({[alpha]: contract(), [beta]: contract(), [client]: 'export function status(origin: string) { return fetch(`${origin}/status`); }'});
    expectAmbiguity(result, client, 1);
  });

  test('a dynamic substitution inside the URL path is a located gap', async () => {
    const result = await extract({[alpha]: contract(), [client]: 'export function status(segment: string) { return fetch(`/status/${segment}`); }'});
    expect(remote(result)).toEqual([]);
    expect(result.gaps.some(gap => gap.path === client && gap.reason.includes('line 1: HTTP URL is unresolved'))).toBe(true);
  });

  test('a dynamic client base and renamed lexical path parameter retain the unique explicit operation', async () => {
    const result = await extract({
      [alpha]: cancelContract(),
      [client]: 'export class OrdersClient { constructor(private readonly baseUrl: string) {} async cancelOrder(record: string) { return fetch(`${this.baseUrl}/orders/${record}/cancel`, {method: "POST"}); } }',
    });
    expect(claimed(result).map(edge => ({from: edge.from, to: edge.to}))).toEqual([{from: `code.symbol:${client}#OrdersClient.cancelOrder`, to: cancelOperation(alpha)}]);
    expect(claimed(result)[0]?.span).toMatchObject({path: client, lineStart: 1});
    expect(remote(result).filter(edge => edge.properties.summary).map(edge => edge.to)).toEqual([cancelOperation(alpha)]);
  });

  test('a parsed origin scopes a path parameter without using the contract named in a comment', async () => {
    const result = await extract({
      [alpha]: cancelContract(undefined, 'https://alpha.example.test'), [beta]: cancelContract(undefined, 'https://beta.example.test'),
      [client]: `// ${beta}
export function cancelOrder(record: string) { return fetch(\`https://alpha.example.test/orders/\${record}/cancel\`, {method: "POST"}); }`,
    });
    expect(claimed(result).map(edge => edge.to)).toEqual([cancelOperation(alpha)]);
    expect(claimed(result)[0]?.span).toMatchObject({path: client, lineStart: 2});
  });

  test('multiple AST parameter boundaries match only explicit whole contract parameters', async () => {
    const result = await extract({
      [alpha]: cancelContract('/accounts/{owner}/orders/{id}/cancel'),
      [client]: 'export function cancelOrder(owner: string, record: string) { return fetch(`/accounts/${owner}/orders/${record}/cancel`, {method: "POST"}); }',
    });
    expect(claimed(result).map(edge => edge.to)).toEqual([`code.operation:${alpha}#POST:/accounts/{owner}/orders/{id}/cancel`]);
  });

  for (const [label, route, source] of [
    ['no explicit parameter', '/orders/fixed/cancel', 'export function cancelOrder(record: string) { return fetch(`/orders/${record}/cancel`, {method: "POST"}); }'],
    ['no matching path', '/other/{id}/cancel', 'export function cancelOrder(record: string) { return fetch(`/orders/${record}/cancel`, {method: "POST"}); }'],
    ['partial segment', '/orders/{id}/cancel', 'export function cancelOrder(record: string) { return fetch(`/orders/prefix-${record}/cancel`, {method: "POST"}); }'],
    ['arbitrary unresolved call', '/orders/{id}/cancel', 'declare function lookup(): string; export function cancelOrder() { return fetch(`/orders/${lookup()}/cancel`, {method: "POST"}); }'],
    ['unbound spelling', '/orders/{id}/cancel', 'export function cancelOrder() { return fetch(`/orders/${id}/cancel`, {method: "POST"}); }'],
    ['unresolved local initializer', '/orders/{id}/cancel', 'export function cancelOrder(record: string) { const segment = lookup(record); return fetch(`/orders/${segment}/cancel`, {method: "POST"}); }'],
    ['reassigned parameter', '/orders/{id}/cancel', 'export function cancelOrder(record: string) { record = lookup(); return fetch(`/orders/${record}/cancel`, {method: "POST"}); }'],
    ['query substitution', '/orders/{id}/cancel', 'export function cancelOrder(record: string) { return fetch(`/orders/${record}/cancel?kind=${record}`, {method: "POST"}); }'],
    ['wrong method', '/orders/{id}/cancel', 'export function cancelOrder(record: string) { return fetch(`/orders/${record}/cancel`); }'],
  ] as const) {
    test(`${label} cannot turn an unknown internal substitution into a resolved URL or local route`, async () => {
      const result = await extract({
        [alpha]: cancelContract(route), [client]: source,
        'src/server.ts': 'import express from "express"; export function start() { const app = express(); app.post("/orders/:id/cancel", (req: any, res: any) => res.send("ok")); app.listen(8080); }',
      });
      expect(result.nodes.filter(node => node.kind === 'code.route')).toHaveLength(1);
      expect(remote(result), `${import.meta.path}: ${label} must not claim a target`).toEqual([]);
      expect(result.gaps.some(gap => gap.path === client && gap.reason.includes('line 1:') && gap.reason.includes('HTTP URL is unresolved')), `${import.meta.path}: ${label} needs a located gap: ${JSON.stringify(result.gaps)}`).toBe(true);
    });
  }

  for (const competing of ['/orders/{other}/cancel', '/orders/fixed/cancel']) {
    test(`an internal parameter cannot choose its template over the compatible ${competing} operation`, async () => {
      const result = await extract({
        [alpha]: cancelContract(), [beta]: cancelContract(competing),
        [client]: `// ${alpha}
export function cancelOrder(record: string) { return fetch(\`/orders/\${record}/cancel\`, {method: "POST"}); }`,
      });
      expect(remote(result)).toEqual([]);
      expect(result.gaps.some(gap => gap.path === client && gap.reason.includes('line 2:') && gap.reason.includes('ambiguous contract selection') && gap.reason.includes(cancelOperation(alpha)) && gap.reason.includes(`code.operation:${beta}#POST:${competing}`))).toBe(true);
    });
  }

  test('missing lexical parameter proof withholds an otherwise matching explicit template', async () => {
    const input = tree({[alpha]: cancelContract(), [client]: 'export function cancelOrder(record: string) { return fetch(`/orders/${record}/cancel`, {method: "POST"}); }'});
    const shared = await extractCodeWithFacts(input);
    const parameter = shared.facts.bindings.find(binding => binding.path === client && binding.name === 'record' && binding.kind === 'parameter');
    expect(parameter).toBeDefined();
    expect(claimed(await extractContracts(input, shared.extraction, shared.facts)).map(edge => edge.to)).toEqual([cancelOperation(alpha)]);
    const incomplete = freezeCodeFacts({...shared.facts, bindings: shared.facts.bindings.filter(binding => binding.id !== parameter!.id)});
    const result = await extractContracts(input, shared.extraction, incomplete);
    expect(remote(result)).toEqual([]);
    expect(result.gaps.some(gap => gap.path === client && gap.reason.includes('line 1: HTTP URL is unresolved'))).toBe(true);
  });

  test('a mismatched explicit origin cannot fall back to a local route', async () => {
    const result = await extract({
      [alpha]: contract('https://alpha.example.test'),
      [client]: 'export function status() { return fetch("https://other.example.test/status"); }',
      'src/server.ts': 'import express from "express"; export function start() { const app = express(); app.get("/status", (req: any, res: any) => res.send("ok")); app.listen(8080); }',
    });
    expect(remote(result)).toEqual([]);
    expect(result.gaps.some(gap => gap.path === client && gap.reason.includes('line 1:') && gap.reason.includes('no contract server matches the resolved URL origin'))).toBe(true);
  });
});

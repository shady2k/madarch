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
      expectAmbiguity(result, client, 2);
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

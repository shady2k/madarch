import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {structuralGrpcDeadline} from '../src/extract/contracts/ts-code.js';
import {TreeText} from '../src/extract/operations/source.js';
import type {TreeReader} from '../src/extract/records.js';
import {grpcDeadlineModel, validateGrpcDeadlineModel} from '../src/extract/library-models/grpc-deadline-models.js';

const clientPath = 'services/relay/client.ts';
const bootstrapPath = 'services/relay/start.ts';
const configPath = 'services/relay/settings.ts';
const invocation = 'this.stub.estimate({units: 1}, {deadline}, () => {})';

async function proof(overrides: Readonly<Record<string, string>> = {}) {
  const files: Readonly<Record<string, string>> = {
    [clientPath]: [
      'interface Stub { estimate(request: unknown, options: unknown, callback: () => void): void; }',
      'export class RateClient {',
      '  private readonly stub: Stub;',
      // Duration deliberately occupies ordinal zero, not the legacy second argument.
      '  constructor(private readonly waitMs: number, address: string) {}',
      '  estimate() {',
      '    const deadline = new Date(Date.now() + this.waitMs);',
      `    ${invocation};`,
      '  }',
      '}',
    ].join('\n'),
    [bootstrapPath]: [
      'import {RateClient} from "./client";',
      'import {readSettings} from "./settings";',
      'const settings = readSettings();',
      'const remote = new RateClient(settings.delay, "localhost:50051");',
    ].join('\n'),
    [configPath]: [
      'export function readSettings(env: Record<string, string> = {}) {',
      '  return {delay: Number(env.RATE_WAIT ?? 7300)};',
      '}',
    ].join('\n'),
    ...overrides,
  };
  const tree: TreeReader = {paths: Object.keys(files).sort(), read(path) {
    const text = files[path];
    if (text === undefined) throw new Error(`${import.meta.path}:43: missing fixture path ${path}`);
    return new TextEncoder().encode(text);
  }};
  const shared = await extractCodeWithFacts(tree);
  const site = shared.facts.calls.find(call => call.path === clientPath && new TextDecoder().decode(tree.read(call.path).subarray(call.span.byteStart, call.span.byteEnd)) === invocation);
  if (site === undefined) throw new Error(`${import.meta.path}:49: missing parsed invocation in ${clientPath}`);
  const result = structuralGrpcDeadline(new TreeText(tree, shared.extraction, shared.facts), site.span);
  return {result, shared, files, site};
}

test('gRPC deadline follows the exact constructor ordinal and config return binding', async () => {
  const answer = await proof();
  try {
    expect(answer.result?.deadlineMs).toBe(7300);
    expect(answer.result?.evidence.some(span => span.path === bootstrapPath)).toBe(true);
    expect(answer.result?.evidence.some(span => span.path === configPath)).toBe(true);
  } catch (error) {
    throw new Error(`${import.meta.path}:55: deadline proof failed; fixture paths ${clientPath}, ${bootstrapPath}, ${configPath}\n${JSON.stringify({error: String(error), ...answer}, null, 2)}`);
  }
});

test('a constructor property write preserves the receiver used by a Promise deadline', async () => {
  const answer = await proof({
    [clientPath]: [
      'interface Stub { estimate(request: unknown, options: unknown, callback: () => void): void; }',
      'declare function connect(address: string): Stub;',
      'export class RateClient {',
      '  private readonly stub: Stub;',
      '  constructor(address: string, private readonly waitMs: number) { this.stub = connect(address); }',
      '  estimate() {',
      '    const deadline = new Date(Date.now() + this.waitMs);',
      `    return new Promise<void>((resolve) => { ${invocation}; resolve(); });`,
      '  }',
      '}',
    ].join('\n'),
    [bootstrapPath]: [
      'import {RateClient} from "./client";',
      'import {readSettings} from "./settings";',
      'const settings = readSettings();',
      'const remote = new RateClient("localhost:50051", settings.delay);',
    ].join('\n'),
  });
  expect(answer.result?.deadlineMs).toBe(7300);
  expect(answer.result?.evidence.some(span => span.path === bootstrapPath)).toBe(true);
  expect(answer.result?.evidence.some(span => span.path === configPath)).toBe(true);
});

test('writing the duration property still invalidates the deadline proof', async () => {
  for (const write of ['this.waitMs = 1', 'this.waitMs += 1', 'this.waitMs++']) {
    const answer = await proof({[clientPath]: [
      'export class RateClient {',
      '  private readonly stub: any;',
      '  constructor(private waitMs: number, address: string) {}',
      `  estimate() { ${write}; const deadline = new Date(Date.now() + this.waitMs); ${invocation}; }`,
      '}',
    ].join('\n')});
    expect(answer.result).toBeUndefined();
  }
});

test('reassigning the config binding still invalidates the deadline proof', async () => {
  const answer = await proof({[bootstrapPath]: [
    'import {RateClient} from "./client";',
    'import {readSettings} from "./settings";',
    'let settings = readSettings();',
    'settings = {delay: 1};',
    'const remote = new RateClient(settings.delay, "localhost:50051");',
  ].join('\n')});
  expect(answer.result).toBeUndefined();
});

test('comments and prose cannot supply a config fallback', async () => {
  for (const value of ['"Number(env.RATE_WAIT ?? 7300)"', 'unknown /* ?? 7300 */']) {
    const answer = await proof({[configPath]: `export function readSettings() { return {delay: ${value}}; }`});
    expect(answer.result).toBeUndefined();
  }
});

test('identifier lookalikes and unrelated property defaults do not prove a deadline', async () => {
  const answer = await proof({
    [bootstrapPath]: 'import {RateClient} from "./client"; const settingsLookalike = {delay: 7300}; const remote = new RateClient(settingsLookalike.delay, "localhost:50051");',
    'services/elsewhere/settings.ts': 'export const settings = {delay: Number(env.WAIT ?? 7300)};',
  });
  expect(answer.result).toBeUndefined();
});

test('multiple canonical constructions do not select an arbitrary config', async () => {
  const answer = await proof({[bootstrapPath]: [
    'import {RateClient} from "./client";',
    'import {readSettings} from "./settings";',
    'const settings = readSettings();',
    'const first = new RateClient(settings.delay, "localhost:50051");',
    'const second = new RateClient(settings.delay, "localhost:50052");',
  ].join('\n')});
  expect(answer.result).toBeUndefined();
});

test('same-name classes in another module cannot supply the construction', async () => {
  const answer = await proof({
    [bootstrapPath]: 'import {RateClient} from "./unrelated"; const settings = {delay: Number(env.WAIT ?? 7300)}; const remote = new RateClient(settings.delay, "localhost:50051");',
    'services/relay/unrelated.ts': 'export class RateClient { constructor(private readonly waitMs: number, address: string) {} }',
  });
  expect(answer.result).toBeUndefined();
});

test('shadowed Number is not the builtin numeric conversion', async () => {
  for (const shadow of ['const Number = (value: unknown) => 1;', 'function Number(value: unknown) { return 1; }']) {
    const answer = await proof({[configPath]: `${shadow} export function readSettings(env = {}) { return {delay: Number(env.WAIT ?? 7300)}; }`});
    expect(answer.result).toBeUndefined();
  }
});

test('shadowed Date is not the builtin clock constructor', async () => {
  const answer = await proof({[clientPath]: [
    'class Date { static now() { return 1; } constructor(value: number) {} }',
    'export class RateClient {',
    '  constructor(private readonly waitMs: number, address: string) {}',
    `  estimate() { const deadline = new Date(Date.now() + this.waitMs); ${invocation}; }`,
    '}',
  ].join('\n')});
  expect(answer.result).toBeUndefined();
});

test('an arbitrary function cannot pass a numeric fallback through its arguments', async () => {
  const answer = await proof({[configPath]: 'function wrap(value: unknown) { return value; } export function readSettings(env = {}) { return {delay: wrap(Number(env.WAIT ?? 7300))}; }'});
  expect(answer.result).toBeUndefined();
});

test('deadline selector data is closed and frozen', () => {
  expect(Object.isFrozen(grpcDeadlineModel)).toBe(true);
  expect(() => validateGrpcDeadlineModel({...grpcDeadlineModel, optionsArgument: 2})).toThrow();
  expect(() => validateGrpcDeadlineModel({...grpcDeadlineModel, passthrough: true})).toThrow();
});

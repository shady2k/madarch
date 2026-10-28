import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {extractDataModel} from '../src/extract/data-model/extract.js';
import {environmentModelDigest, environmentModels, validateEnvironmentModels} from '../src/extract/library-models/environment-models.js';
import type {Extraction, SourceSpan, TreeReader} from '../src/extract/records.js';

const path = 'services/api/main.ts';
/** The unit a fixture declares: every `services/<name>/` path it names gets that name's manifest (madarch-mwhd.3). */
function withUnits(files: Readonly<Record<string, string>>): Record<string, string> {
  const declared: Record<string, string> = {...files};
  for (const name of Object.keys(files)) {
    const parts = name.split('/');
    if (parts[0] !== 'services' || parts.length < 3) continue;
    const manifest = `services/${parts[1]}/package.json`;
    if (declared[manifest] === undefined) declared[manifest] = JSON.stringify({name: parts[1]});
  }
  return declared;
}
function tree(given: Readonly<Record<string, string>>): TreeReader {
  const files = withUnits(given);
  return {paths: Object.keys(files).sort(), read(name) {
    const text = files[name];
    if (text === undefined) throw new Error(`${import.meta.path}: fixture has no path ${name}`);
    return new TextEncoder().encode(text);
  }};
}
function raw(input: TreeReader, span: SourceSpan): string {
  return new TextDecoder().decode(input.read(span.path).subarray(span.byteStart, span.byteEnd));
}
function storage(extraction: Extraction) {
  return {databases: extraction.nodes.filter(node => node.kind === 'code.database'), uses: extraction.edges.filter(edge => edge.type === 'code.uses-database')};
}
async function extract(source: string) {
  const input = tree({[path]: source});
  const shared = await extractCodeWithFacts(input);
  const before = JSON.stringify(shared.facts);
  const result = await extractDataModel(input, shared.extraction, shared.facts);
  expect(JSON.stringify(shared.facts)).toBe(before);
  expect(Object.isFrozen(shared.facts)).toBe(true);
  return {input, shared, result, ...storage(result)};
}

describe('environment storage evidence uses binding identity, not process spelling', () => {
  for (const [name, source] of [
    ['parameter', 'export function read(process: {env: {DATABASE_URL: string}}) { return process.env.DATABASE_URL; }'],
    ['local', 'export function read() { const process = {env: {DATABASE_URL: "local"}}; return process.env.DATABASE_URL; }'],
    ['block local', 'export function read() { { const process = {env: {DATABASE_URL: "local"}}; return process.env.DATABASE_URL; } }'],
    ['outer closure', 'export function outer(process: {env: {DATABASE_URL: string}}) { return () => process.env.DATABASE_URL; }'],
    ['file local', 'const process = {env: {DATABASE_URL: "local"}}; export function read() { return process.env.DATABASE_URL; }'],
    ['temporal dead zone', 'export function read() { const value = process.env.DATABASE_URL; const process = {env: {DATABASE_URL: "local"}}; return value; }'],
    ['hoisted var', 'export function read() { const value = process.env.DATABASE_URL; if (true) { var process = {env: {DATABASE_URL: "local"}}; } return value; }'],
    ['bracket parameter', 'export function read(process: any) { return process["env"]["DATABASE_URL"]; }'],
    ['write only', 'export function write() { process.env.DATABASE_URL = "local"; }'],
    ['comment and string', '// process.env.DATABASE_URL\nexport const note = "process.env.DATABASE_URL";'],
  ] as const) {
    test(`${name} is not a JS global environment read`, async () => {
      const {databases, uses} = await extract(source);
      expect(databases, `${import.meta.path}: ${path}: fictitious database for ${name}`).toEqual([]);
      expect(uses).toEqual([]);
    });
  }

  for (const site of ['process.env.DATABASE_URL', 'process.env["DATABASE_URL"]', 'process["env"]["DATABASE_URL"]']) {
    test(`the unbound global ${site} retains its raw bytes and canonical owner`, async () => {
      const source = `// Unicode prefix: café\nexport function read() { return ${site}; }`;
      const {input, shared, databases, uses} = await extract(source);
      expect(databases).toHaveLength(1); expect(uses).toHaveLength(1);
      expect(databases[0]!.key).toBe('code.database:api');
      expect(raw(input, databases[0]!.span!)).toBe(site);
      expect(raw(input, uses[0]!.span!)).toBe(site);
      expect(uses[0]!.from).toBe('code.service:api');
      expect(uses[0]!.to).toBe('code.database:api');
      const expression = shared.facts.expressions.find(candidate => candidate.span.byteStart === uses[0]!.span!.byteStart && candidate.span.byteEnd === uses[0]!.span!.byteEnd);
      expect(expression).toBeDefined();
      expect(uses[0]!.properties.origins).toEqual([{
        sourceProducer: 'code.extract.data-model', originalDiscriminator: '', sourceSpan: {...uses[0]!.span!},
        properties: {via: 'connection-setting', environmentModel: 'database-url', expression: expression!.id, holder: `code.symbol:${path}#read`},
      }]);
    });
  }

  test('an inner shadow does not erase a real read outside that block', async () => {
    const source = 'export function read() { { const process = {env: {DATABASE_URL: "local"}}; consume(process.env.DATABASE_URL); } return process.env.DATABASE_URL; }';
    const {input, uses} = await extract(source);
    expect(uses).toHaveLength(1);
    const expectedStart = new TextEncoder().encode(source.slice(0, source.lastIndexOf('process.env.DATABASE_URL'))).length;
    expect(uses[0]!.span!.byteStart).toBe(expectedStart);
    expect(raw(input, uses[0]!.span!)).toBe('process.env.DATABASE_URL');
  });

  test('all established connection variables come from the validated data', async () => {
    expect(environmentModels.map(model => model.variable).sort()).toEqual(['DATABASE_URL', 'DB_DSN', 'DB_URL', 'MYSQL_URL', 'POSTGRES_URL']);
    for (const model of environmentModels) {
      const {uses} = await extract(`export function read() { return process.env.${model.variable}; }`);
      expect(uses, `${import.meta.path}: ${path}: missing ${model.variable}`).toHaveLength(1);
    }
    const {databases} = await extract('export function read() { return process.env.APPLICATION_LABEL; }');
    expect(databases).toEqual([]);
  });

  test('a dynamic global key stays unresolved with a located gap', async () => {
    const {result, databases} = await extract('export function read(key: string) { return process.env[key]; }');
    expect(databases).toEqual([]);
    expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('line 1: environment variable name is unresolved') && gap.reason.includes(path) && gap.reason.includes('bytes'))).toBe(true);
  });

  test('missing shared facts do not trigger another semantic parse or invent evidence', async () => {
    const input = tree({[path]: 'export function read() { return process.env.DATABASE_URL; }'});
    const shared = await extractCodeWithFacts(input);
    // A copied extraction has no retained-facts ownership; do not parse to replace it.
    const result = await extractDataModel(input, {...shared.extraction});
    expect(storage(result).databases).toEqual([]);
    expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('line 1: shared CodeFacts are absent') && gap.reason.includes(path))).toBe(true);
  });

  test('the standalone public entry point obtains the same canonical evidence', async () => {
    const input = tree({[path]: 'export function read() { return process.env.DATABASE_URL; }'});
    const shared = await extractCodeWithFacts(input);
    expect(await extractDataModel(input)).toEqual(await extractDataModel(input, shared.extraction, shared.facts));
  });
});

test('Go environment evidence uses the imported os binding, including an alias', async () => {
  const goPath = 'services/api/main.go';
  for (const [source, positive] of [
    ['package api\nimport system "os"\nfunc Read() string { return system.Getenv("DATABASE_URL") }', true],
    ['package api\nfunc Read(os interface{ Getenv(string) string }) string { return os.Getenv("DATABASE_URL") }', false],
  ] as const) {
    const input = tree({[goPath]: source});
    const shared = await extractCodeWithFacts(input);
    const result = await extractDataModel(input, shared.extraction, shared.facts);
    expect(storage(result).uses).toHaveLength(positive ? 1 : 0);
    if (positive) expect(raw(input, storage(result).uses[0]!.span!)).toBe('system.Getenv("DATABASE_URL")');
  }
});

test('parsed dotenv and Compose names reuse the same closed environment data', async () => {
  for (const [configPath, config, expected] of [
    ['services/api/.env', '# quoted connection\nexport DATABASE_URL="postgres://database/app"\n', '# quoted connection\nexport DATABASE_URL="postgres://database/app"\n'],
    ['compose.yaml', 'services:\n  api:\n    environment:\n      DATABASE_URL: "postgres://database/app"\n', '"postgres://database/app"'],
  ] as const) {
    const input = tree({[path]: 'export const label = "api";', [configPath]: config});
    const shared = await extractCodeWithFacts(input);
    const result = await extractDataModel(input, shared.extraction, shared.facts);
    expect(storage(result).uses).toHaveLength(1);
    expect(raw(input, storage(result).uses[0]!.span!)).toBe(expected);
  }
});

test('environment data rejects open vocabulary and has a canonical immutable identity', () => {
  const registry = {schemaVersion: 1, models: environmentModels};
  const reversed = {models: [...environmentModels].reverse().map(model => ({reference: model.reference, effect: model.effect, variable: model.variable, id: model.id})), schemaVersion: 1};
  expect(validateEnvironmentModels(reversed)).toEqual(environmentModels);
  expect(createHash('sha256').update(JSON.stringify({schemaVersion: 1, models: validateEnvironmentModels(reversed)})).digest('hex')).toBe(environmentModelDigest);
  expect(Object.isFrozen(environmentModels)).toBe(true);
  expect(environmentModels.every(model => Object.isFrozen(model))).toBe(true);
  expect(() => validateEnvironmentModels({...registry, extra: true})).toThrow('unknown field');
  expect(() => validateEnvironmentModels({...registry, schemaVersion: 2})).toThrow('unsupported version');
  expect(() => validateEnvironmentModels({...registry, models: [{...environmentModels[0]!, effect: 'execute'}]})).toThrow('unknown effect');
  expect(() => validateEnvironmentModels({...registry, models: [{...environmentModels[0]!, sourceRegex: '.*'}]})).toThrow('unknown field');
  expect(() => validateEnvironmentModels({...registry, models: [environmentModels[0]!, {...environmentModels[0]!, id: 'duplicate-variable'}]})).toThrow('conflicting variable selector');
});

test('dotenv absent, empty and malformed assignments never invent storage evidence', async () => {
  for (const config of [
    '# DATABASE_URL=postgres://database/app\nAPPLICATION_LABEL=api\n',
    'DATABASE_URL=\n',
    'DATABASE_URL\n',
    '=postgres://database/app\n',
  ]) {
    const configPath = 'services/api/.env';
    const input = tree({[path]: 'export const label = "api";', [configPath]: config});
    const shared = await extractCodeWithFacts(input);
    const result = await extractDataModel(input, shared.extraction, shared.facts);
    expect(storage(result).databases, `${import.meta.path}: ${configPath}: ${JSON.stringify(config)}`).toEqual([]);
    expect(storage(result).uses).toEqual([]);
    if (config === 'DATABASE_URL\n' || config === '=postgres://database/app\n') {
      expect(result.gaps.some(gap => gap.path === configPath && gap.reason.includes('line 1: environment parser returned no assignments') && gap.reason.includes(configPath))).toBe(true);
    }
  }
});

test('an unread source keeps its path and reason rather than a partial storage claim', async () => {
  const manifest = 'services/api/package.json';
  // The unit the fixture declares, so the unread file is still a file of a service (madarch-mwhd.3).
  const input: TreeReader = {paths: [manifest, path], read(name) {
    if (name !== manifest) throw new Error('fixture source unavailable');
    return new TextEncoder().encode('{"name":"api"}');
  }};
  const shared = await extractCodeWithFacts(input);
  const result = await extractDataModel(input, shared.extraction, shared.facts);
  expect(storage(result).databases).toEqual([]);
  expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('fixture source unavailable'))).toBe(true);
});

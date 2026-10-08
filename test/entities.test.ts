import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { compileModel, CompiledModelSchema, loadAndCompileModel, parseModel, serializeCompiledModel } from '../src/index.js';

/**
 * intended-model/entities, intended-model/transfers, intended-model/ids,
 * intended-model/references and intended-model/evidence as they name a data
 * entity, and compiled-model/shape as it holds entities and each transfer's
 * entities with their combined categories (docs/changes/
 * use-cases-data-entities/capabilities/…). Expected values come from those
 * requirements' scenarios, never from the implementation.
 */

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** The 1-based line of the first line in `relativeYamlPath` matching `predicate`. */
function lineOf(fixtureRoot: string, relativeYamlPath: string, predicate: (line: string) => boolean): number {
  const lines = readFileSync(`${fixtureRoot}/${relativeYamlPath}`, 'utf8').split('\n');
  const index = lines.findIndex(predicate);
  expect(index).toBeGreaterThan(-1);
  return index + 1;
}

/** The 1-based line of `needle` in one in-memory model file, as a reader counts it. */
function lineIn(file: { text: string }, needle: string): number {
  const at = file.text.split('\n').findIndex((line) => line.includes(needle));
  if (at < 0) throw new Error(`"${needle}" is not in the model`);
  return at + 1;
}

const ELEMENTS = `elements:
  - id: auth-api
    kind: service
  - id: event-bus
    kind: broker
`;

const CATEGORIES = `categories:
  - id: personal
  - id: communications-secrecy
`;

/** One model file: the shared parts, then what each case adds. */
function model(text: string): { path: string; text: string } {
  return { path: 'madarch/model.yaml', text: `version: 1\n${text}` };
}

describe('intended-model/entities: data entities name what crosses, with its classification', () => {
  test('entity-classified: the compiled model holds the entity with its name and category, and no warning names it', () => {
    const { model: compiled, errors, warnings } = loadAndCompileModel(fixture('entities-example'));

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    const entity = compiled?.entities!.find((e) => e.id === 'session-id');
    expect(entity).toEqual({
      id: 'session-id',
      name: 'Session id',
      categories: ['communications-secrecy'],
      evidence: [{ file: 'services/auth/session.ts', line: 3 }],
    });
  });

  test('entity-of-no-category: `categories: []` loads with no warning and compiles to an empty list', () => {
    const { model: compiled, errors, warnings } = loadAndCompileModel(fixture('entities-example'));

    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.message.includes('"order-number"'))).toEqual([]);
    expect(compiled?.entities!.find((e) => e.id === 'order-number')).toEqual({
      id: 'order-number',
      name: 'Order number',
      categories: [],
    });
  });

  test('classification-not-stated: an entity with no `categories` loads, with one warning naming it, and compiles with no list of categories', () => {
    const file = model(`${ELEMENTS}entities:
  - id: user-name
    name: User name
`);
    const { model: loaded, errors, warnings } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(loaded).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ file: 'madarch/model.yaml', line: lineIn(file, '- id: user-name'), path: 'entities[0]' });
    expect(warnings[0]!.message).toContain('"user-name"');
    expect(warnings[0]!.message).toContain('classification is not stated');

    const compiled = compileModel(loaded!);
    const entity = compiled.entities!.find((e) => e.id === 'user-name');
    expect(entity?.categories).toEqual([]);
    expect(Object.hasOwn(entity!, 'categories')).toBe(true);
  });

  test('a description and evidence are kept, and an entity with neither name nor description still compiles', () => {
    const { model: compiled, errors, warnings } = loadAndCompileModel(fixture('entities-example'));

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(compiled?.entities!.find((e) => e.id === 'login-attempt')).toEqual({
      id: 'login-attempt',
      description: 'One attempt to sign in, successful or not',
      categories: [],
    });
  });

  test('the warning of an entity in a file the loader also refuses is still reported, in file and line order', () => {
    const first = {
      path: 'madarch/a-entities.yaml',
      text: `version: 1
elements: []
entities:
  - id: later
  - id: earlier
`,
    };
    const second = {
      path: 'madarch/b-broken.yaml',
      text: `version: 1
elements:
  - id: a
    kind: service
    parent: nowhere
`,
    };
    const { model: loaded, errors, warnings } = parseModel([first, second]);

    expect(loaded).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(warnings.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: 'madarch/a-entities.yaml', line: 4 },
      { file: 'madarch/a-entities.yaml', line: 5 },
    ]);
    expect(warnings.every((w) => w.message.includes('classification is not stated'))).toBe(true);
  });

  test('entity and relation warnings come in file order, then line order, however the kinds mix', () => {
    const first = {
      path: 'madarch/a-shop.yaml',
      text: `version: 1
elements:
  - id: auth-api
    kind: service
  - id: event-bus
    kind: broker
relations:
  - id: auth-publishes-login
    name: publishes login events
    from: auth-api
    to: event-bus
entities:
  - id: session-id
`,
    };
    const second = {
      path: 'madarch/b-more.yaml',
      text: `version: 1
elements: []
entities:
  - id: earlier
relations:
  - id: unnamed
    from: auth-api
    to: auth-api
`,
    };
    const { errors, warnings } = parseModel([first, second]);

    expect(errors).toEqual([]);
    expect(warnings.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: 'madarch/a-shop.yaml', line: lineIn(first, '- id: session-id') },
      { file: 'madarch/b-more.yaml', line: lineIn(second, '- id: earlier') },
      { file: 'madarch/b-more.yaml', line: lineIn(second, '- id: unnamed') },
    ]);
    expect(warnings[2]!.message).toContain('no name');
  });

  test('entities are ordered by id in the compiled model, whatever order the files write them in', () => {
    const { model: compiled, errors } = loadAndCompileModel(fixture('entities-example-split'));

    expect(errors).toEqual([]);
    expect(compiled?.entities!.map((e) => e.id)).toEqual(['login-attempt', 'order-number', 'session-id', 'user-name']);
  });

  test('a model split across files compiles to the same bytes as the same model in one file', () => {
    const oneFile = loadAndCompileModel(fixture('entities-example'));
    const threeFiles = loadAndCompileModel(fixture('entities-example-split'));

    expect(oneFile.errors).toEqual([]);
    expect(threeFiles.errors).toEqual([]);
    expect(serializeCompiledModel(threeFiles.model!)).toBe(serializeCompiledModel(oneFile.model!));
  });

  test('the compiled model with entities validates against the published compiled-model schema', () => {
    const { model, errors } = loadAndCompileModel(fixture('entities-example'));

    expect(errors).toEqual([]);
    expect(Value.Check(CompiledModelSchema, model)).toBe(true);
  });

  test('the published compiled-model schema refuses an unknown field on a compiled entity and on a compiled transfer', () => {
    const { model } = loadAndCompileModel(fixture('entities-example'));

    const withRogueEntity = structuredClone(model!) as { entities: Record<string, unknown>[] };
    withRogueEntity.entities[0]!.rogue = true;
    expect(Value.Check(CompiledModelSchema, withRogueEntity)).toBe(false);

    const withRogueTransfer = structuredClone(model!) as { relations: { transfers: Record<string, unknown>[] }[] };
    withRogueTransfer.relations[0]!.transfers[0]!.rogue = true;
    expect(Value.Check(CompiledModelSchema, withRogueTransfer)).toBe(false);
  });
});

describe('intended-model/ids and references, for entities', () => {
  test('refuses an unknown field on an entity or a transfer, naming the full path', () => {
    const file = model(`${ELEMENTS}entities:
  - id: session-id
    categories: []
    owner: someone
relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        categories: []
        bogus: yes
`);
    const { errors } = parseModel([file]);

    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, 'owner: someone'), path: 'entities[0].owner' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, 'bogus: yes'), path: 'relations[0].transfers[0].bogus' }),
    );
  });

  test('refuses an entity id of invalid syntax, naming its file, line and path', () => {
    const file = model(`${ELEMENTS}entities:
  - id: "bad id"
    categories: []
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, '- id: "bad id"'), path: 'entities[0].id' }),
    );
  });

  test('refuses two entities with the same id, naming both places', () => {
    const first = model(`${ELEMENTS}entities:
  - id: session-id
    categories: []
`);
    const second = { path: 'madarch/b.yaml', text: `version: 1\nelements: []\nentities:\n  - id: session-id\n    categories: []\n` };
    const { model: loaded, errors } = parseModel([first, second]);

    expect(loaded).toBeUndefined();
    const inFirst = errors.find((e) => e.file === 'madarch/model.yaml' && e.path === 'entities[0].id')!;
    const inSecond = errors.find((e) => e.file === 'madarch/b.yaml' && e.path === 'entities[0].id')!;
    expect(inFirst).toBeDefined();
    expect(inSecond).toBeDefined();
    expect(inFirst.message).toContain('madarch/b.yaml');
    expect(inSecond.message).toContain('madarch/model.yaml');
    expect(inFirst.message).toContain('entity id "session-id"');
    expect(inFirst.message).toContain(`madarch/b.yaml:${lineIn(second, '- id: session-id')}`);
  });

  test('refuses an entity naming a category that does not exist, at the category own line', () => {
    const file = model(`${CATEGORIES}${ELEMENTS}entities:
  - id: session-id
    categories: [communications-secrecy, nowhere]
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, 'categories: [communications-secrecy, nowhere]'),
        path: 'entities[0].categories[1]',
        message: expect.stringContaining('nowhere'),
      }),
    );
  });

  test('refuses an unknown category of an entity listed one to a line, at that entry own line', () => {
    const file = model(`${CATEGORIES}${ELEMENTS}entities:
  - id: session-id
    name: Session id
    categories:
      - personal
      - nowhere
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, '- nowhere'),
        path: 'entities[0].categories[1]',
      }),
    );
  });

  test('refuses a transfer naming an entity that is not declared, at that entity own line', () => {
    const file = model(`${ELEMENTS}entities:
  - id: session-id
    categories: []
relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        entities: [session-id, user-name]
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, 'entities: [session-id, user-name]'),
        path: 'relations[0].transfers[0].entities[1]',
        message: expect.stringContaining('"user-name"'),
      }),
    );
    expect(errors[0]!.message).toContain('"auth-publishes-login"');
  });

  test('refuses an unknown category of a transfer listed one to a line, at that entry own line', () => {
    const file = model(`${ELEMENTS}categories:
  - id: personal
relations:
  - id: auth-publishes-login
    name: publishes login events
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        categories:
          - personal
          - nowhere
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, '- nowhere'),
        path: 'relations[0].transfers[0].categories[1]',
      }),
    );
  });

  test('refuses an unknown entity of a transfer listed one to a line, at that entry own line', () => {
    const file = model(`${ELEMENTS}relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        entities:
          - nowhere
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, '- nowhere'),
        path: 'relations[0].transfers[0].entities[0]',
      }),
    );
  });

  test('an entity declared by a file that failed its own schema check still resolves from another file', () => {
    const broken = {
      path: 'madarch/a.yaml',
      text: `version: 1
entities:
  - id: session-id
    name: Session id
    categories: []
    owner: someone
`,
    };
    const referring = model(`${ELEMENTS}relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        entities: [session-id]
`);
    const { errors } = parseModel([broken, referring]);

    const unknownField = errors.find((e) => e.path === 'entities[0].owner')!;
    expect(unknownField).toBeDefined();
    expect(errors.filter((e) => e.message.includes('does not exist'))).toEqual([]);
  });
});

describe('intended-model/evidence, for entities', () => {
  test('the compiled entity keeps its evidence as given', () => {
    const { model: compiled, errors } = loadAndCompileModel(fixture('entities-example'));

    expect(errors).toEqual([]);
    expect(compiled?.entities!.find((e) => e.id === 'session-id')?.evidence).toEqual([{ file: 'services/auth/session.ts', line: 3 }]);
  });

  test('refuses an entity evidence item with a commit but no blob, naming the entity, the item and its place', () => {
    const file = model(`${ELEMENTS}entities:
  - id: session-id
    categories: []
    evidence:
      - file: services/auth/session.ts
        commit: 3f9c2ab6e1d40977c88b9a2f5e0c11d78b8a6f21
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, '- file: services/auth/session.ts'),
        path: 'entities[0].evidence[0]',
        message: expect.stringContaining('session-id'),
      }),
    );
    expect(errors[0]!.message).toContain('commit and a blob are given together');
  });

  test('refuses an entity evidence item whose endLine comes before its line', () => {
    const file = model(`${ELEMENTS}entities:
  - id: session-id
    categories: []
    evidence:
      - file: services/auth/session.ts
        line: 20
        endLine: 12
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        path: 'entities[0].evidence[0].endLine',
        message: expect.stringContaining('endLine'),
      }),
    );
  });
});

describe('intended-model/transfers: the entities a transfer carries', () => {
  test('categories-from-entities: the compiled transfer names the entities and the union of the categories, each once, sorted by code point', () => {
    const { model: compiled, errors } = loadAndCompileModel(fixture('entities-example'));

    expect(errors).toEqual([]);
    const relation = compiled?.relations.find((r) => r.id === 'auth-publishes-login');
    expect(relation?.transfers).toEqual([
      {
        direction: 'forward',
        confidentiality: 'confidential',
        categories: ['communications-secrecy', 'personal'],
        entities: ['session-id', 'user-name'],
      },
    ]);
  });

  test('a transfer may carry an entity whose classification is not stated: no categories come from it, and the warning still fires', () => {
    const file = model(`${ELEMENTS}entities:
  - id: session-id
    name: Session id
relations:
  - id: auth-publishes-login
    name: publishes login events
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        categories: []
        entities: [session-id]
`);
    const { model: loaded, errors, warnings } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.path)).toEqual(['entities[0]']);
    expect(compileModel(loaded!).relations[0]?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: [], entities: ['session-id'] },
    ]);
  });

  test('a transfer naming only entities takes its categories from them alone', () => {
    const file = model(`${CATEGORIES}${ELEMENTS}entities:
  - id: session-id
    categories: [communications-secrecy]
relations:
  - id: auth-publishes-login
    name: publishes login events
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        entities: [session-id]
`);
    const { model: loaded, errors, warnings } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(compileModel(loaded!).relations[0]?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: ['communications-secrecy'], entities: ['session-id'] },
    ]);
  });

  test('a transfer whose own categories repeat one of its entities still lists each category once', () => {
    const file = model(`${CATEGORIES}${ELEMENTS}entities:
  - id: session-id
    categories: [personal]
relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        categories: [personal]
        entities: [session-id]
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(compileModel(loaded!).relations[0]?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: ['personal'], entities: ['session-id'] },
    ]);
  });

  test('transfer-names-nothing: a transfer with neither categories nor entities is refused, naming the relation and the transfer', () => {
    const file = model(`${ELEMENTS}relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: 'madarch/model.yaml',
      line: lineIn(file, '- direction: forward'),
      path: 'relations[0].transfers[0]',
    });
    expect(errors[0]!.message).toContain('"auth-publishes-login"');
    expect(errors[0]!.message).toContain('categories, entities or both');
  });

  test('a transfer with `categories: []` and no entities is an answer, not a refusal', () => {
    const file = model(`${ELEMENTS}relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: internal
        categories: []
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(loaded?.relations[0]?.transfers).toEqual([{ direction: 'forward', confidentiality: 'internal', categories: [] }]);
  });

  test('a transfer with entities and `categories: []` takes the entities categories beside the empty list', () => {
    const file = model(`${CATEGORIES}${ELEMENTS}entities:
  - id: session-id
    categories: [communications-secrecy]
relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        categories: []
        entities: [session-id]
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(compileModel(loaded!).relations[0]?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: ['communications-secrecy'], entities: ['session-id'] },
    ]);
  });

  test('a transfer whose entities repeat one id still lists each entity once', () => {
    const file = model(`${ELEMENTS}entities:
  - id: session-id
    categories: []
relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        entities: [session-id, session-id]
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(compileModel(loaded!).relations[0]?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: [], entities: ['session-id'] },
    ]);
  });

  test('a transfer naming an unknown entity is refused beside the refusal of another transfer naming nothing', () => {
    const file = model(`${ELEMENTS}relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        entities: [nowhere]
      - direction: reverse
        confidentiality: internal
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors.map((e) => e.path).sort()).toEqual(['relations[0].transfers[0].entities[0]', 'relations[0].transfers[1]']);
  });
});

describe('compatibility: a model written before this change', () => {
  test('loads and compiles with its entities and scenarios always present, empty, and each transfer stating its (empty) entities', () => {
    const { model: compiled, errors, warnings } = loadAndCompileModel(fixture('valid-relation-full'));

    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('"checkout-uses-payments"'),
      expect.stringContaining('"checkout-charges-card"'),
    ]);
    // Since madarch-hnq.1.4 both arrays are always present, empty when the
    // model declares none, like every other top-level array; a model
    // written before this change still loads, its compiled form differing
    // exactly this way (the owner's decision of 2026-10-08).
    expect(compiled?.entities).toEqual([]);
    expect(compiled?.scenarios).toEqual([]);
    const relation = compiled?.relations.find((r) => r.id === 'checkout-charges-card');
    expect(relation?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: ['payment-card', 'personal'], entities: [] },
      { direction: 'reverse', confidentiality: 'internal', categories: [], entities: [] },
    ]);
    expect(Value.Check(CompiledModelSchema, compiled)).toBe(true);
  });

  test('the compiled categories of a categories-only transfer are sorted by code point, each once, and its entities stated empty', () => {
    const file = model(`${ELEMENTS}categories:
  - id: personal
  - id: order
  - id: payment-card
relations:
  - id: auth-publishes-login
    from: auth-api
    to: event-bus
    transfers:
      - direction: forward
        confidentiality: confidential
        categories: [personal, order, payment-card, personal]
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(compileModel(loaded!).relations[0]?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: ['order', 'payment-card', 'personal'], entities: [] },
    ]);
  });
});

describe('the writers\' reference documents data entities', () => {
  test('the Data entity section names every field the schema defines, and the Relation section names a transfer\'s entities', () => {
    const reference = readFileSync(fileURLToPath(new URL('../skills/write-intended-model/reference.md', import.meta.url)), 'utf8');
    const section = reference.slice(reference.indexOf('## Data entity'), reference.indexOf('## The review report'));
    for (const field of ['id', 'name', 'description', 'categories', 'evidence']) {
      expect(section.includes(`\`${field}\``), `the Data entity section does not document \`${field}\``).toBe(true);
    }
    const relation = reference.slice(reference.indexOf('## Relation'), reference.indexOf('## Evidence'));
    expect(relation.includes('`entities`')).toBe(true);
  });
});

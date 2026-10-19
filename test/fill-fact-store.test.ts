/**
 * The fill's fact store on PGlite (madarch-tzte.20.2, decisions 0026 and 0027):
 * the process's own database owner, the state machines' store and the
 * orchestrator's publication are the landed modules, and the scenario
 * (`test/fill-fact-store-scenario.ts`) publishes real generations through them.
 * The expectations are the task's own words (`test/fill-fact-store-expectations.ts`);
 * the PostgreSQL leg is `test/fill-fact-store-postgres.test.ts`, and it holds the
 * same list.
 *
 * The last tests here are the host's: the background server hands the fill's own
 * fact store to every run whose wiring names none, so a published fact set lands
 * in the process's own tables without the caller wiring a store of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { FACT_APPLICATION, createFactStoreSchema, readFact, readUnitFacts } from '../src/fill/fact-store.js';
import { makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import type { UnitPlanRecord } from '../src/fill/orchestrator-store.js';
import { createUnit, readUnit } from '../src/fill/state-store.js';
import { createFillOrchestratorService, type FillRunResult, type RefusedFillRun } from '../src/fill/orchestrator-host.js';
import type { FactApplication } from '../src/fill/orchestrator.js';
import { StageRegistry } from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { factStoreChecks } from './fill-fact-store-expectations.js';
import { runFactStoreScenario, scenarioFacts, writeOf, type FactStoreScenarioReport } from './fill-fact-store-scenario.js';

let owner: DatabaseOwner | undefined;
let report: FactStoreScenarioReport | undefined;

beforeAll(async () => {
  owner = createPGliteDatabaseOwner();
  report = await runFactStoreScenario(owner);
}, 60_000);

afterAll(async () => {
  await owner?.close();
});

// The checks are built from facts of their own: an id is the digest of a fact's
// identity, so the same fact built twice is the same id (0026).
for (const { name, check } of factStoreChecks(scenarioFacts())) {
  test(name, () => {
    check(report!);
  });
}

/** One fact's provenance, as a reader that read it out of `file` at the pinned commit. */
function provenanceOf(file: string): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: 'acme-shop', commit: 'a'.repeat(40) },
    place: { file: repositoryPath(file), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 10 } },
  };
}

describe('a publication of a large set of facts', () => {
  test('writes its facts and their holdings 500 to a statement, one kind at a time', async () => {
    // madarch-tzte.21.11: a statement per fact and one more per holding — two for every fact — took the
    // embedded store's memory up by about 700 MB for 60 000 facts. A statement carries 500 facts of one
    // kind (the requirement's own number, not the constant's), so 1 001 facts of one kind are three
    // statements, and a publication that wrote a fact a statement takes this test down.
    const count = 1_001;
    const facts = Array.from({ length: count }, (_, at) => makeNodeFact({
      kind: 'symbol',
      value: { repository: 'acme-shop', file: repositoryPath(`src/f${String(at)}.ts`), qualifiedName: `f${String(at)}`, symbolKind: 'function' },
      provenance: provenanceOf(`src/f${String(at)}.ts`),
      layer: 'extracted',
    }));
    await createUnit(owner!, { unitId: 'modules:batched', product: 'fixture-product', runId: 'run-1', stageId: 'modules', scopeKey: 'batched', inputsDigest: 'batched-inputs', retries: 0, at: 1_700_000_000_000 });
    const record = await readUnit(owner!, 'modules:batched');
    if (record === null) throw new Error('the test could not create its unit "modules:batched"');
    const plan: UnitPlanRecord = {
      unitId: 'modules:batched', generation: 1, runId: 'run-1', stageId: 'modules', stageUnitId: 'batched',
      scope: 'batched', stagePosition: 0, planPosition: 0, plannedAt: 1_700_000_000_000,
    };
    const statements: string[] = [];
    const applied = await owner!.transaction('write', async (transaction) => await FACT_APPLICATION.apply({
      executor: {
        query: async (sql: string, values?: readonly unknown[]) => {
          statements.push(sql);
          return await transaction.query(sql, values);
        },
      },
      unit: record,
      plan,
      digest: 'd'.repeat(64),
      writes: facts.map((fact) => writeOf('fact', fact)),
    }));
    expect(applied).toBe(count);
    expect(statements.filter((sql) => sql.startsWith('INSERT INTO fill_fact (id'))).toHaveLength(3);
    expect(statements.filter((sql) => sql.startsWith('INSERT INTO fill_fact_holding'))).toHaveLength(3);
    expect((await readUnitFacts(owner!, 'modules:batched')).length).toBe(count);
  }, 60_000);
});

describe('the store\'s own tables', () => {
  test('creating the schema again leaves the facts and their publishers as they are', async () => {
    const before = await readUnitFacts(owner!, 'unit-a');
    expect(before).toHaveLength(2);
    await createFactStoreSchema(owner!);
    await createFactStoreSchema(owner!);
    expect(await readUnitFacts(owner!, 'unit-a')).toEqual(before);
  }, 30_000);

  test('a holding table without its foreign key gets it back: it is what makes a publication hold its fact', async () => {
    const foreign = async (): Promise<number> => await owner!.run(async (transaction) => (
      await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'fill_fact_holding_id_fkey'")
    ).rows[0]?.count ?? -1);
    expect(await foreign()).toBe(1);
    await owner!.run(async (transaction) => { await transaction.query('ALTER TABLE fill_fact_holding DROP CONSTRAINT fill_fact_holding_id_fkey'); });
    expect(await foreign()).toBe(0);
    await createFactStoreSchema(owner!);
    expect(await foreign()).toBe(1);
    // And the constraint refuses a holding without its fact, which is the invariant it stands for.
    await expect(owner!.transaction('write', async (transaction) => {
      await transaction.query("INSERT INTO fill_fact_holding (id, unit_id, stage_id, generation, publication) VALUES ('module:' || repeat('a', 64), 'unit-orphan', 'modules', 1, 'publication-orphan')");
    })).rejects.toThrow(/foreign key constraint "fill_fact_holding_id_fkey"/);
  }, 30_000);
});

/** The pinned snapshot a run of the host's tests stands on: fill-runtime's own shape. */
const SNAPSHOT = { repository: 'example.com/acme/shop', defaultBranch: 'main', commit: 'a1b2c3d4', registryHash: 'sha256:registry' };

/** A stage that plans one unit and drafts one fact: enough for a run to publish. */
function factStage(id: string, fact: Fact): FillStage {
  return {
    id,
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'repository' }],
    configSchema: Type.Object({}),
    defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [{ id: 'src', scope: 'src' }], coverage: 'planned' }),
    execute: (_unit, context) => {
      context.draft.write(writeOf('fact', fact));
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}

/** One run of the host, over the owner the test lent it, with the wiring the caller gives. */
async function hostRun(options: { readonly facts?: FactApplication }): Promise<{
  readonly result: FillRunResult | RefusedFillRun;
  readonly database: DatabaseOwner;
  readonly fact: Fact;
  close(): Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'madarch-fact-store-host-'));
  const database = createPGliteDatabaseOwner();
  const fact = scenarioFacts().moduleA;
  const service = createFillOrchestratorService({
    home,
    owner: database,
    registry: new StageRegistry().register(factStage('modules', fact)),
    wiring: () => ({
      snapshot: () => SNAPSHOT,
      configuration: () => undefined,
      graph: () => ({ query: async () => [] }),
      inputs: () => ({ commit: 'a1b2c3d4' }),
      ...(options.facts === undefined ? {} : { facts: options.facts }),
    }),
  });
  const result = await service.run({ product: { name: 'fixture-product', folder: home }, runId: 'run-fact-store' });
  return {
    result,
    database,
    fact,
    close: async () => {
      await service.stop();
      await database.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe('the store a published fact set lands in, as the background server hands it over', () => {
  test('a run whose wiring names no store publishes into the process\'s own fact tables', async () => {
    const run = await hostRun({});
    try {
      expect(run.result.ok).toBe(true);
      if (!run.result.ok) return;
      expect(run.result.state).toBe('succeeded');
      expect(run.result.units.every((unit) => unit.state === 'published')).toBe(true);
      const stored = await readUnitFacts(run.database, 'modules/src');
      expect(stored.map((entry) => entry.fact.id)).toEqual([run.fact.id]);
      expect(stored[0]?.publishers.map((publisher) => publisher.unitId)).toEqual(['modules/src']);
      expect((await readFact(run.database, run.fact.id))?.fact.kind).toBe('module');
    } finally {
      await run.close();
    }
  }, 120_000);

  test('a wiring that names its own store keeps it, and the fill\'s own tables stay empty', async () => {
    const applied: string[] = [];
    const run = await hostRun({ facts: { apply: async (input) => { applied.push(input.unit.unitId); return 1; } } });
    try {
      expect(run.result.ok).toBe(true);
      expect(applied).toEqual(['modules/src']);
      expect(await readUnitFacts(run.database, 'modules/src')).toEqual([]);
    } finally {
      await run.close();
    }
  }, 120_000);
});

/**
 * The fact store's behaviour, observed once and judged by every caller: the tests
 * on PGlite (`test/fill-fact-store.test.ts`) and on PostgreSQL
 * (`test/fill-fact-store-postgres.test.ts`) run this, so both engines answer the
 * same questions. This module asserts nothing: it makes the calls and reports
 * what came back, and each caller holds the values it expects — the pattern
 * `test/queue-scenario.ts` set (madarch-tzte.19.2).
 *
 * Nothing here is a fake: the process's one database owner, the state machines'
 * store, the orchestrator's publication (`publishUnitIn`) and the fact store are
 * the landed modules, and a unit reaches `validating` by the machine's own steps.
 * A publication is the real one, so a generation is published exactly once and a
 * second generation of a unit is opened the way the decision opens one: the
 * published generation is invalidated with its replacement named, and
 * `replaceStaleGeneration` opens it (0027, "a published generation stays an
 * immutable record marked stale and linked to its replacement").
 *
 * The facts the scenario publishes are built with the schema's own constructors
 * (`makeNodeFact`, `makeEdgeFact`) and named once (`scenarioFacts`), so the test
 * that judges them names the same facts the scenario wrote.
 */
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { FACT_APPLICATION, createFactStoreSchema, factsOfWrites, readFact, readUnitDraft, readUnitFacts } from '../src/fill/fact-store.js';
import {
  createOrchestratorSchema,
  publishUnit,
  readPublication,
  recordUnitDraft,
  retractUnitDraft,
  type PublicationOutcome,
  type UnitPlanRecord,
} from '../src/fill/orchestrator-store.js';
import {
  advanceRun,
  advanceUnit,
  createFillStateSchema,
  createRun,
  createUnit,
  leaseUnit,
  readUnit,
  replaceStaleGeneration,
  type StoreStep,
} from '../src/fill/state-store.js';
import type { StageDraftWrite } from '../src/fill/stage.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-1';
const COMMIT = 'a'.repeat(40);

/** One provenance, as a fact read out of `src/cart.ts` at the pinned commit. */
function provenance(file: string): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: 'acme-shop', commit: COMMIT },
    place: { file: repositoryPath(file), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 10 } },
  };
}

/** The facts the scenario publishes, named so the test that judges it names the same ones. */
export interface ScenarioFacts {
  readonly symbolOne: Fact;
  readonly symbolTwo: Fact;
  /** The call edge both units publish: one fact of the graph under one id. */
  readonly callEdgeOfA: Fact;
  readonly callEdgeOfB: Fact;
  readonly moduleA: Fact;
  readonly moduleB: Fact;
  readonly draftFact: Fact;
  readonly retractedFact: Fact;
  readonly publishedDraftFact: Fact;
  readonly entity: Fact;
  readonly question: Fact;
  /** A fact two units publish whose ids differ only in case: what tells this store's own order from the database's collation. */
  readonly caseFact: Fact;
  /** A fact a unit publishes and then drops by publishing nothing: a renamed file's inventory fact. */
  readonly emptiedFact: Fact;
  /**
   * One module fact at two rankings: stage 5 measures a rank over the whole
   * repository and writes it onto the fact of the module it is about, so the id
   * — its identity — is the same after a re-ranking, and only `importance`
   * moves (madarch-tzte.21.7).
   */
  readonly rankedModule: Fact;
  readonly rankedModuleReranked: Fact;
  /** A folder unit's facts (a directory and the edge that holds a file in it), as stages 1 and 5 write them. */
  readonly folderDirectory: Fact;
  readonly folderFile: Fact;
  readonly folderContains: Fact;
  readonly otherFolderDirectory: Fact;
  readonly otherFolderFile: Fact;
  readonly otherFolderContains: Fact;
  /** A write whose `value` is not a fact the schema reads: its id is not the digest of its identity. */
  readonly malformed: unknown;
  /** A write the schema refuses in three places at once: no id, an empty repository and an empty name. */
  readonly manyProblems: unknown;
}

/** The scenario's own facts, built by the schema and by nothing else. */
export function scenarioFacts(): ScenarioFacts {
  const peer = 'b'.repeat(40);
  const symbolOne = makeNodeFact({ kind: 'symbol', value: { repository: 'acme-shop', file: repositoryPath('src/cart.ts'), qualifiedName: 'cart.add', symbolKind: 'function' }, provenance: provenance('src/cart.ts'), layer: 'extracted' });
  const symbolTwo = makeNodeFact({ kind: 'symbol', value: { repository: 'acme-shop', file: repositoryPath('src/cart.ts'), qualifiedName: 'cart.total', symbolKind: 'function' }, provenance: provenance('src/cart.ts'), layer: 'extracted' });
  const call = (count: number): Fact => makeEdgeFact({ kind: 'call', value: { from: symbolOne.id, to: symbolTwo.id, count, precision: 'syntactic' }, provenance: provenance('src/cart.ts'), layer: 'extracted' });
  const module = (name: string, source: string): Fact => makeNodeFact({ kind: 'module', value: { repository: 'acme-shop', name, seed: 'package' }, provenance: { source: { system: source, version: '2' }, repository: { id: 'acme-shop', commit: peer }, place: { file: repositoryPath(`src/${name}.ts`), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 4 } } }, layer: 'extracted' });
  const fact = (name: string): Fact => makeNodeFact({ kind: 'module', value: { repository: 'acme-shop', name, seed: 'package' }, provenance: provenance(`src/${name}.ts`), layer: 'extracted' });
  // One folder unit's facts, as stages 1 and 5 write them: the folder, the file it holds and the edge
  // between them. Two folders, so a folder's publication can be held to its own facts alone.
  const folder = (path: string, file: string): { readonly directory: Fact; readonly file: Fact; readonly contains: Fact } => {
    const directory = makeNodeFact({ kind: 'directory', value: { repository: 'acme-shop', path: repositoryPath(path) }, provenance: provenance(path), layer: 'extracted' });
    const held = makeNodeFact({ kind: 'file', value: { repository: 'acme-shop', path: repositoryPath(file), roles: ['source'] }, provenance: provenance(file), layer: 'extracted' });
    return { directory, file: held, contains: makeEdgeFact({ kind: 'contains', value: { from: directory.id, to: held.id }, provenance: provenance(file), layer: 'extracted' }) };
  };
  const ranked = (importance: number, members: number): Fact => makeNodeFact({ kind: 'module', value: { repository: 'acme-shop', name: 'ranked', seed: 'package', members, importance }, provenance: provenance('src/ranked.ts'), layer: 'extracted' });
  const folderA = folder('src', 'src/cart.ts');
  const folderB = folder('lib', 'lib/total.ts');
  const folderDirectory = folderA.directory;
  const folderFile = folderA.file;
  const folderContains = folderA.contains;
  const otherFolderDirectory = folderB.directory;
  const otherFolderFile = folderB.file;
  const otherFolderContains = folderB.contains;
  return {
    rankedModule: ranked(0.5, 3),
    rankedModuleReranked: ranked(0.25, 5),
    symbolOne,
    symbolTwo,
    callEdgeOfA: call(9),
    callEdgeOfB: call(2),
    moduleA: module('cart', 'tree-sitter'),
    moduleB: module('checkout', 'scip-typescript'),
    draftFact: fact('draft-set'),
    retractedFact: fact('retracted-draft'),
    publishedDraftFact: fact('published-draft'),
    caseFact: fact('case-order'),
    emptiedFact: fact('emptied-set'),
    folderDirectory,
    folderFile,
    folderContains,
    otherFolderDirectory,
    otherFolderFile,
    otherFolderContains,
    entity: makeNodeFact({ kind: 'entity-proposal', value: { repository: 'acme-shop', proposed: 'concept', name: 'Cart' }, provenance: provenance('src/cart.ts'), layer: 'inferred' }),
    question: makeNodeFact({ kind: 'question', value: { repository: 'acme-shop', type: 'contradiction', prompt: 'Is the total used?' }, provenance: provenance('src/cart.ts'), layer: 'inferred' }),
    malformed: { kind: 'module', schemaVersion: 1, id: `module:${'f'.repeat(64)}`, provenance: provenance('src/cart.ts'), layer: 'extracted', status: 'proposed', value: { repository: 'acme-shop', name: 'invented', seed: 'package' } },
    manyProblems: { kind: 'module', schemaVersion: 1, provenance: provenance('src/cart.ts'), layer: 'extracted', status: 'proposed', value: { repository: '', name: '', seed: 'package' } },
  };
}

/** One write of a fact, as a stage's draft writer makes it: the write's kind is the tool that wrote it, and its `value` is the fact. */
export function writeOf(kind: StageDraftWrite['kind'], fact: unknown, evidence = 'src/cart.ts:1'): StageDraftWrite {
  return { kind, evidence, value: fact };
}

/** Everything one run of the scenario saw, with no judgement in it. */
export interface FactStoreScenarioReport {
  /** The facts a unit holds after its publication, in the order the store answers them. */
  readonly aHoldsAfterFirst: readonly string[];
  readonly bHoldsAfterFirst: readonly string[];
  /** The call edge both units published: one row, both publishers, and the count the first publication stored. */
  readonly sharedPublishers: readonly string[];
  readonly sharedRows: number;
  readonly sharedCountStored: number;
  /** A's next generation published two of its three facts. */
  readonly aHoldsAfterSecond: readonly string[];
  readonly bHoldsAfterASecond: readonly string[];
  readonly sharedRowsAfterADroppedIt: number;
  readonly sharedPublishersAfterADroppedIt: readonly string[];
  /** The fact whose last holder dropped it: the read answers nothing and no row stands. */
  readonly droppedFact: string | null;
  readonly factRows: number;
  /** A draft set before anything is published. */
  readonly draftFacts: readonly string[];
  readonly draftWrites: number;
  readonly draftUnitHolds: readonly string[];
  readonly draftFactPublished: boolean;
  /** The retracted draft: nothing to read as draft, and nothing published. */
  readonly retractedDraft: boolean;
  readonly retractedPublicationCode: string;
  readonly retractedUnitHolds: readonly string[];
  /** The published draft: no longer readable as draft, and published. */
  readonly publishedDraftReadable: boolean;
  readonly publishedDraftUnitHolds: readonly string[];
  /** A draft holding a write the schema does not read. */
  readonly invalidWriteRefusal: string;
  readonly invalidWriteUnitHolds: readonly string[];
  readonly invalidWritePublication: boolean;
  readonly invalidWriteState: string;
  readonly invalidWriteStillDraft: number;
  /** The four write kinds, as the store holds them. */
  readonly storedKinds: readonly string[];
  /** One write the schema refuses in three places: the refusal counts the write, not the problems. */
  readonly manyProblemsRefusal: string;
  /** Write kinds none of the four, the prototype's own names included: each is refused by name, never a TypeError. */
  readonly unknownKindRefusals: readonly string[];
  /** A write whose fact is not the kind that write writes. */
  readonly wrongKindRefusal: string;
  readonly wrongKindUnitHolds: readonly string[];
  /**
   * The publishers of one fact whose two unit ids differ only in case, as the two
   * reads answer them: a database ordering text by its own collation puts one
   * before the other, and this store's own order is code point order.
   */
  readonly casePublishersOfTheUnit: readonly string[];
  readonly casePublishersOfTheFact: readonly string[];
  /** A publication whose draft set is empty: as a first publication it stores nothing... */
  readonly emptyPublicationHolds: readonly string[];
  readonly emptyPublicationFacts: number;
  /** ...and as the next generation of a unit that held a fact it replaces the unit's set with none. */
  readonly emptiedUnitHolds: readonly string[];
  readonly emptiedFactGone: boolean;
  readonly emptiedPublicationFacts: number;
  /** Two folder units' facts: the one that published again holds its own set, and the other holds all of its own. */
  readonly folderAfterItsSecond: readonly string[];
  readonly otherFolderAfterTheFirstsSecond: readonly string[];
  readonly otherFolderFactsStillThere: readonly boolean[];
  /**
   * One module fact published twice under one id, at two rankings: the rank the
   * second publication carries, the rank the row held after the first, and the
   * field that is not a rank, which the first publication's row keeps.
   */
  readonly rankAfterFirst: number;
  readonly rankAfterSecond: number;
  readonly membersAfterSecond: number;
}

/** Raises the machine's own refusal, so a scenario step that cannot be taken says why. */
function must<R, S extends string>(step: StoreStep<R, S>, what: string): R {
  if (!step.ok) throw new Error(`the scenario could not take "${what}": ${step.refusal.code}: ${step.refusal.reason}`);
  return step.record;
}

/** The scenario: every case against the owner it is given. */
export async function runFactStoreScenario(owner: DatabaseOwner): Promise<FactStoreScenarioReport> {
  const facts = scenarioFacts();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  await createRun(owner, { runId: RUN, product: PRODUCT, at: NOW });
  must(await advanceRun(owner, { runId: RUN, event: { type: 'plan', at: NOW, configuration: 'resolved-configuration' } }), 'planning the run');
  must(await advanceRun(owner, { runId: RUN, event: { type: 'start', at: NOW, stages: 2 } }), 'starting the run');

  /** Steps one planned generation to `validating` with a recorded draft set, and answers the fence it holds. */
  async function draftAndValidate(unitId: string, generation: number, writes: readonly StageDraftWrite[], at: number): Promise<number> {
    must(await advanceUnit(owner, { unitId, event: { type: 'admit', at, generation } }), `admitting ${unitId}/${generation}`);
    const leased = must(await leaseUnit(owner, { unitId, holder: 'scenario', ttlMs: 60_000, at }), `leasing ${unitId}/${generation}`);
    const fence = leased.context.fence;
    must(await advanceUnit(owner, { unitId, event: { type: 'start', at, generation, fence } }), `starting ${unitId}/${generation}`);
    must(await advanceUnit(owner, { unitId, event: { type: 'submit-draft', at, generation, fence } }), `drafting ${unitId}/${generation}`);
    await recordUnitDraft(owner, { unitId, generation, writes, at });
    must(await advanceUnit(owner, { unitId, event: { type: 'validate-draft', at, generation, fence } }), `validating ${unitId}/${generation}`);
    return fence;
  }

  /** Publishes one generation through the machine's own publication, with this store as the sink. */
  async function publish(unitId: string, generation: number, stageId: string, scope: string, fence: number, at: number): Promise<PublicationOutcome> {
    const record = await readUnit(owner, unitId);
    if (record === null) throw new Error(`the scenario published unit "${unitId}", which the store does not hold`);
    const plan: UnitPlanRecord = { unitId, generation, runId: RUN, stageId, stageUnitId: scope, scope, stagePosition: 0, planPosition: 0, plannedAt: at };
    return await publishUnit(owner, {
      unitId,
      generation,
      fence,
      identity: { inputsDigest: record.inputsDigest, stageId, stageVersion: 1 },
      at,
      // No tracked read was recorded for these units, so the publication rechecks none.
      revalidate: async () => ({ membership: 'no reads', members: 0 }),
      apply: async (executor, writes, digest) => await FACT_APPLICATION.apply({ executor, unit: record, plan, digest, writes }),
    });
  }

  /** One unit, from its creation to its publication: the whole path a run takes per unit generation. */
  async function publishUnitFacts(unitId: string, stageId: string, scope: string, writes: readonly StageDraftWrite[], at: number): Promise<PublicationOutcome> {
    await createUnit(owner, { unitId, product: PRODUCT, runId: RUN, stageId, scopeKey: scope, inputsDigest: `${unitId}-inputs`, retries: 2, at });
    const fence = await draftAndValidate(unitId, 1, writes, at);
    return await publish(unitId, 1, stageId, scope, fence, at);
  }

  /** Opens the next generation of a published unit the way the decision does, and drafts it. */
  async function publishNextGeneration(unitId: string, generation: number, writes: readonly StageDraftWrite[], at: number): Promise<PublicationOutcome> {
    const record = await readUnit(owner, unitId);
    if (record === null) throw new Error(`the scenario replaced unit "${unitId}", which the store does not hold`);
    must(await advanceUnit(owner, { unitId, event: { type: 'invalidate', at, replacement: generation, cause: 'the inputs moved' } }), `invalidating ${unitId}/${record.generation}`);
    must(await replaceStaleGeneration(owner, { unitId, runId: RUN, inputsDigest: `${unitId}-inputs-${generation}`, retries: 2, at }), `opening ${unitId}/${generation}`);
    const fence = await draftAndValidate(unitId, generation, writes, at);
    return await publish(unitId, generation, record.stageId, record.scopeKey, fence, at);
  }

  const held = async (unitId: string): Promise<readonly string[]> => (await readUnitFacts(owner, unitId)).map((entry) => entry.fact.id);
  const publishersOf = async (id: string): Promise<readonly string[]> => (await readFact(owner, id))?.publishers.map((publisher) => publisher.unitId) ?? [];
  const rowsOf = async (id: string): Promise<number> => await owner.run(async (transaction) => (await transaction.query<{ count: number }>('SELECT count(*)::int AS count FROM fill_fact WHERE id = $1', [id])).rows[0]?.count ?? -1);
  const factRows = async (): Promise<number> => await owner.run(async (transaction) => (await transaction.query<{ count: number }>('SELECT count(*)::int AS count FROM fill_fact')).rows[0]?.count ?? -1);

  // ---- two units publish the same edge, and each replaces only its own facts ----
  await publishUnitFacts('unit-b', 'modules', 'module-b', [writeOf('fact', facts.callEdgeOfB), writeOf('fact', facts.moduleB)], NOW + 1_000);
  await publishUnitFacts('unit-a', 'modules', 'module-a', [writeOf('fact', facts.symbolOne), writeOf('fact', facts.symbolTwo), writeOf('fact', facts.callEdgeOfA)], NOW + 2_000);
  const aHoldsAfterFirst = await held('unit-a');
  const bHoldsAfterFirst = await held('unit-b');
  const sharedPublishers = await publishersOf(facts.callEdgeOfA.id);
  const sharedRows = await rowsOf(facts.callEdgeOfA.id);
  const sharedCountStored = ((await readFact(owner, facts.callEdgeOfA.id))?.fact as { value?: { count?: number } } | undefined)?.value?.count ?? -1;

  await publishNextGeneration('unit-a', 2, [writeOf('fact', facts.symbolOne), writeOf('fact', facts.symbolTwo)], NOW + 3_000);
  const aHoldsAfterSecond = await held('unit-a');
  const bHoldsAfterASecond = await held('unit-b');
  const sharedRowsAfterADroppedIt = await rowsOf(facts.callEdgeOfA.id);
  const sharedPublishersAfterADroppedIt = await publishersOf(facts.callEdgeOfA.id);

  await publishNextGeneration('unit-b', 2, [writeOf('fact', facts.moduleB)], NOW + 4_000);
  const droppedFact = (await readFact(owner, facts.callEdgeOfA.id))?.fact.id ?? null;
  const rowsAfterEveryHolderLeft = await factRows();

  // ---- a draft set is readable as draft, and never mixed with a published fact ----
  await createUnit(owner, { unitId: 'unit-draft', product: PRODUCT, runId: RUN, stageId: 'modules', scopeKey: 'draft-set', inputsDigest: 'unit-draft-inputs', retries: 2, at: NOW + 5_000 });
  await draftAndValidate('unit-draft', 1, [writeOf('fact', facts.draftFact)], NOW + 5_000);
  const draft = await readUnitDraft(owner, 'unit-draft', 1);
  const draftFacts = draft?.facts.map((fact) => fact.id) ?? [];
  const draftWrites = draft?.writes.length ?? -1;
  const draftUnitHolds = await held('unit-draft');
  const draftFactPublished = (await readFact(owner, facts.draftFact.id)) !== null;

  // ---- a retracted draft leaves nothing ----
  await createUnit(owner, { unitId: 'unit-retracted', product: PRODUCT, runId: RUN, stageId: 'modules', scopeKey: 'retracted-draft', inputsDigest: 'unit-retracted-inputs', retries: 2, at: NOW + 6_000 });
  const retractedFence = await draftAndValidate('unit-retracted', 1, [writeOf('fact', facts.retractedFact)], NOW + 6_000);
  await retractUnitDraft(owner, { unitId: 'unit-retracted', generation: 1, at: NOW + 6_100 });
  const retractedDraft = (await readUnitDraft(owner, 'unit-retracted', 1)) === null;
  const retractedPublication = await publish('unit-retracted', 1, 'modules', 'retracted-draft', retractedFence, NOW + 6_200);
  const retractedPublicationCode = retractedPublication.outcome === 'refused' ? retractedPublication.code : retractedPublication.outcome;

  // ---- a published draft is a published fact set, not a draft ----
  await publishUnitFacts('unit-published-draft', 'modules', 'published-draft', [writeOf('fact', facts.publishedDraftFact)], NOW + 7_000);
  const publishedDraftReadable = (await readUnitDraft(owner, 'unit-published-draft', 1)) !== null;
  const publishedDraftUnitHolds = await held('unit-published-draft');

  // ---- a write the schema does not read refuses the whole publication ----
  await createUnit(owner, { unitId: 'unit-invalid-write', product: PRODUCT, runId: RUN, stageId: 'modules', scopeKey: 'invalid-write', inputsDigest: 'unit-invalid-write-inputs', retries: 2, at: NOW + 8_000 });
  const invalidFence = await draftAndValidate('unit-invalid-write', 1, [writeOf('fact', facts.moduleA), writeOf('fact', facts.malformed)], NOW + 8_000);
  let invalidWriteRefusal = '';
  try {
    await publish('unit-invalid-write', 1, 'modules', 'invalid-write', invalidFence, NOW + 8_100);
  } catch (error) {
    invalidWriteRefusal = (error as Error).message;
  }
  const invalidWriteUnitHolds = await held('unit-invalid-write');
  const invalidWritePublication = (await readPublication(owner, 'unit-invalid-write', 1)) !== null;
  const invalidWriteState = (await readUnit(owner, 'unit-invalid-write'))?.state ?? 'gone';
  const invalidWriteStillDraft = (await readUnitDraft(owner, 'unit-invalid-write', 1))?.writes.length ?? -1;

  // ---- every write kind writes the fact it carries ----
  await publishUnitFacts('unit-kinds', 'modules', 'kinds', [
    writeOf('fact', facts.symbolOne),
    writeOf('entity', facts.entity),
    writeOf('link', facts.callEdgeOfA),
    writeOf('question', facts.question),
  ], NOW + 9_000);
  const storedKinds = (await readUnitFacts(owner, 'unit-kinds')).map((entry) => entry.fact.kind).sort();

  await createUnit(owner, { unitId: 'unit-many-problems', product: PRODUCT, runId: RUN, stageId: 'modules', scopeKey: 'many-problems', inputsDigest: 'unit-many-problems-inputs', retries: 2, at: NOW + 9_500 });
  const manyFence = await draftAndValidate('unit-many-problems', 1, [writeOf('fact', facts.manyProblems)], NOW + 9_500);
  let manyProblemsRefusal = '';
  try {
    await publish('unit-many-problems', 1, 'modules', 'many-problems', manyFence, NOW + 9_600);
  } catch (error) {
    manyProblemsRefusal = (error as Error).message;
  }

  await createUnit(owner, { unitId: 'unit-wrong-kind', product: PRODUCT, runId: RUN, stageId: 'modules', scopeKey: 'wrong-kind', inputsDigest: 'unit-wrong-kind-inputs', retries: 2, at: NOW + 10_000 });
  const wrongFence = await draftAndValidate('unit-wrong-kind', 1, [writeOf('entity', facts.moduleB)], NOW + 10_000);
  let wrongKindRefusal = '';
  try {
    await publish('unit-wrong-kind', 1, 'modules', 'wrong-kind', wrongFence, NOW + 10_100);
  } catch (error) {
    wrongKindRefusal = (error as Error).message;
  }
  const wrongKindUnitHolds = await held('unit-wrong-kind');

  // ---- a write kind none of the four, the prototype's own names included ----
  const unknownKindRefusals = ['constructor', 'toString', '__proto__', 'valueOf', 'bogus'].map((kind) => {
    try {
      const { problems } = factsOfWrites([{ kind, evidence: 'src/cart.ts:1', value: facts.moduleA } as unknown as StageDraftWrite]);
      return problems.map((problem) => problem.message).join('; ') || 'the write was read as a fact of the schema';
    } catch (error) {
      return (error as Error).message;
    }
  });

  // ---- the publishers of one fact, in this store's own order and not the database's ----
  await publishUnitFacts('unit-case', 'modules', 'case-lower', [writeOf('fact', facts.caseFact)], NOW + 10_500);
  await publishUnitFacts('Unit-case', 'modules', 'case-upper', [writeOf('fact', facts.caseFact)], NOW + 10_600);
  const caseHeld = await readUnitFacts(owner, 'unit-case');
  const casePublishersOfTheUnit = caseHeld.find((entry) => entry.fact.id === facts.caseFact.id)?.publishers.map((held) => held.unitId) ?? [];
  const casePublishersOfTheFact = (await readFact(owner, facts.caseFact.id))?.publishers.map((held) => held.unitId) ?? [];

  // ---- a publication with nothing to publish stores nothing ----
  await publishUnitFacts('unit-empty', 'modules', 'empty', [], NOW + 11_000);
  const emptyPublicationHolds = await held('unit-empty');
  const emptyPublicationFacts = (await readPublication(owner, 'unit-empty', 1))?.facts ?? -1;

  // ---- a unit that publishes nothing replaces its own earlier facts with none (a renamed file's inventory fact) ----
  await publishUnitFacts('unit-emptied', 'inventory', 'emptied', [writeOf('fact', facts.emptiedFact)], NOW + 11_500);
  await publishNextGeneration('unit-emptied', 2, [], NOW + 11_600);
  const emptiedUnitHolds = await held('unit-emptied');
  const emptiedFactGone = (await readFact(owner, facts.emptiedFact.id)) === null;
  const emptiedPublicationFacts = (await readPublication(owner, 'unit-emptied', 2))?.facts ?? -1;

  // ---- a folder unit's publication replaces its own facts and no other folder's ----
  await publishUnitFacts('folder-a', 'inventory', 'folder-a', [writeOf('fact', facts.folderDirectory), writeOf('fact', facts.folderFile), writeOf('fact', facts.folderContains)], NOW + 12_000);
  await publishUnitFacts('folder-b', 'inventory', 'folder-b', [writeOf('fact', facts.otherFolderDirectory), writeOf('fact', facts.otherFolderFile), writeOf('fact', facts.otherFolderContains)], NOW + 12_100);
  await publishNextGeneration('folder-a', 2, [writeOf('fact', facts.folderDirectory)], NOW + 12_200);
  const folderAfterItsSecond = await held('folder-a');
  const otherFolderAfterTheFirstsSecond = await held('folder-b');
  const otherFolderFactsStillThere = [
    (await readFact(owner, facts.otherFolderDirectory.id)) !== null,
    (await readFact(owner, facts.otherFolderContains.id)) !== null,
  ];

  // ---- a rank is the one field of a fact row a later publication replaces ----
  const rankOf = async (id: string): Promise<number> => {
    const stored = (await readFact(owner, id))?.fact.value as { readonly importance?: number; readonly members?: number } | undefined;
    return stored?.importance ?? -1;
  };
  const membersOf = async (id: string): Promise<number> => {
    const stored = (await readFact(owner, id))?.fact.value as { readonly members?: number } | undefined;
    return stored?.members ?? -1;
  };
  await publishUnitFacts('unit-ranked', 'modules', 'ranked', [writeOf('fact', facts.rankedModule)], NOW + 13_000);
  const rankAfterFirst = await rankOf(facts.rankedModule.id);
  await publishNextGeneration('unit-ranked', 2, [writeOf('fact', facts.rankedModuleReranked)], NOW + 13_100);
  const rankAfterSecond = await rankOf(facts.rankedModule.id);
  const membersAfterSecond = await membersOf(facts.rankedModule.id);

  return {
    rankAfterFirst,
    rankAfterSecond,
    membersAfterSecond,
    aHoldsAfterFirst,
    bHoldsAfterFirst,
    sharedPublishers,
    sharedRows,
    sharedCountStored,
    aHoldsAfterSecond,
    bHoldsAfterASecond,
    sharedRowsAfterADroppedIt,
    sharedPublishersAfterADroppedIt,
    droppedFact,
    factRows: rowsAfterEveryHolderLeft,
    draftFacts,
    draftWrites,
    draftUnitHolds,
    draftFactPublished,
    retractedDraft,
    retractedPublicationCode,
    retractedUnitHolds: await held('unit-retracted'),
    publishedDraftReadable,
    publishedDraftUnitHolds,
    invalidWriteRefusal,
    invalidWriteUnitHolds,
    invalidWritePublication,
    invalidWriteState,
    invalidWriteStillDraft,
    storedKinds,
    manyProblemsRefusal,
    unknownKindRefusals,
    wrongKindRefusal,
    wrongKindUnitHolds,
    casePublishersOfTheUnit,
    casePublishersOfTheFact,
    emptyPublicationHolds,
    emptyPublicationFacts,
    emptiedUnitHolds,
    emptiedFactGone,
    emptiedPublicationFacts,
    folderAfterItsSecond,
    otherFolderAfterTheFirstsSecond,
    otherFolderFactsStillThere,
  };
}

/**
 * The checked write path (madarch-tzte.20.4, decision 0026, "Writing"): what an
 * agent unit writes the graph through — assert a fact, propose an entity, link,
 * raise a question — and the four checks a write passes before it lands in the
 * unit's draft set: the schema, the cited bytes at the pinned commit, the
 * referenced nodes, and the unit's own scope.
 *
 * Every expectation is taken from the task and the decisions, never from the
 * module: the repository the bytes are read in is one this test makes and pins,
 * the ids are the ones `factId` digests for the fact the task describes, and a
 * refusal is held to the field and to the span it must name. The draft set is
 * the machine's own row (`fill_unit_draft`) and the graph is the fill's own fact
 * store (`fill_fact`), through the landed modules: the orchestrator's state
 * machines, its publication and `FACT_APPLICATION`.
 *
 * The kinds are the ones an agent stage may write (the schema's own layers): a
 * `claim`, a `module`, an `entity-proposal`, a `question` and an `interaction`
 * edge are `inferred`; a `symbol` or a `call` edge is `extracted`, so it is
 * published by its own stage here and only read by a write.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { byCodePoint } from '../src/model/order.js';
import { FACT_APPLICATION, createFactStoreSchema, readFact, readUnitDraft, readUnitFacts } from '../src/fill/fact-store.js';
import { factId, makeNodeFact, repositoryPath, type Fact, type FactKind, type FactProvenance } from '../src/fill/facts.js';
import {
  assertFact, draftSetOf, factGraph, link, proposeEntity, raiseQuestion, recordedDraftSet, scopeText, writeScope,
  type CheckedWriteDraft, type CheckedWriteGraph, type CheckedWriteSession, type SimilarEntity,
} from '../src/fill/checked-writes.js';
import {
  createOrchestratorSchema, publishUnit, recordUnitDraft, retractUnitDraft, type UnitPlanRecord,
} from '../src/fill/orchestrator-store.js';
import {
  advanceRun, advanceUnit, createFillStateSchema, createRun, createUnit, leaseUnit, readUnit,
  type StoreStep,
} from '../src/fill/state-store.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import type { StageDraftWrite, StageDraftWriter } from '../src/fill/stage.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const RUN = 'run-checked-writes';
const REPOSITORY = 'acme-shop';
/** The repositories the store-backed entity tests write about, one each: what they are compared against is their own. */
const ENTITIES = 'acme-shop-entities';
const CAP = 'acme-shop-cap';
const GRAPH = 'acme-shop-graph';
/** The source an agent stage's facts name: the stage that read them (0004). */
const SOURCE = { system: 'fill-stage-12', version: '1' };

/** The file the tests cite: exactly 10 lines, so a span past its last line is a span the reader can refuse. */
const CART_LINES = [
  'export const cart = {',
  '  items: [] as string[],',
  '  total(): number {',
  '    return 0;',
  '  },',
  '};',
  '',
  'export type Cart = typeof cart;',
  '',
  'export const held = true;',
];
const CART = `${CART_LINES.join('\n')}\n`;

/** A throwaway repository holding the file the tests cite, at one commit. */
interface Fixture {
  readonly root: string;
  readonly commit: string;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-checked-writes-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'lib'), { recursive: true });
  await writeFile(join(root, 'src', 'cart.ts'), CART);
  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  await writeFile(join(root, 'src', 'empty.ts'), '');
  await writeFile(join(root, 'lib', 'total.ts'), 'export const total = 0;\n');
  git('add', '-A');
  git('commit', '-qm', 'one');
  return { root, commit: git('rev-parse', 'HEAD').trim(), dispose: () => rm(root, { recursive: true, force: true }) };
}

let owner: DatabaseOwner | undefined;
let repo: Fixture;
let snapshots: ReturnType<typeof createGitSnapshotSource>;

beforeAll(async () => {
  owner = createPGliteDatabaseOwner();
  repo = await fixture();
  // One pin per repository name the tests write about: the whole file shares one database owner, so a
  // store-backed answer is held to a repository of its own and never to what another test published.
  snapshots = createGitSnapshotSource([REPOSITORY, ENTITIES, CAP, GRAPH].map((id) => ({ id, form: 'code' as const, root: repo.root, commit: repo.commit })));
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  await createRun(owner, { runId: RUN, product: PRODUCT, at: NOW });
  const planned = await advanceRun(owner, { runId: RUN, event: { type: 'plan', at: NOW, configuration: 'resolved-configuration' } });
  if (!planned.ok) throw new Error(`the fixture could not plan the run: ${planned.refusal.reason}`);
  const started = await advanceRun(owner, { runId: RUN, event: { type: 'start', at: NOW, stages: 1 } });
  if (!started.ok) throw new Error(`the fixture could not start the run: ${started.refusal.reason}`);
}, 60_000);

afterAll(async () => {
  await owner?.close();
  await repo?.dispose();
});

/** Raises the machine's own refusal, so a step the test cannot take says why. */
function must<R, S extends string>(step: StoreStep<R, S>, what: string): R {
  if (!step.ok) throw new Error(`the test could not take "${what}": ${step.refusal.code}: ${step.refusal.reason}`);
  return step.record;
}

/**
 * A graph a test answers itself: the nodes it holds and the entities it already
 * carries, so a test judges the write path and not the store beside it. The
 * store's own answers are held to `factGraph` further down.
 */
function memoryGraph(options: { readonly nodes?: readonly { readonly id: string; readonly kind: FactKind }[]; readonly entities?: readonly SimilarEntity[] } = {}): CheckedWriteGraph {
  const nodes = new Map((options.nodes ?? []).map((node) => [node.id, node]));
  return {
    node: async (id: string) => nodes.get(id) ?? null,
    similarEntities: async () => options.entities ?? [],
  };
}

/** One unit of the understanding stage, admitted, leased and running: the state its stage writes in. */
interface RunningUnit {
  readonly unitId: string;
  readonly generation: number;
  readonly fence: number;
  readonly draft: CheckedWriteDraft;
  readonly session: CheckedWriteSession;
}

/** A running unit for one scope, with the draft set the machine records and the graph the caller gives. */
async function runningUnit(unitId: string, options: { readonly scope?: string; readonly graph?: CheckedWriteGraph; readonly at?: number } = {}): Promise<RunningUnit> {
  const scope = options.scope ?? `${REPOSITORY}:src`;
  const at = options.at ?? NOW;
  await createUnit(owner!, { unitId, product: PRODUCT, runId: RUN, stageId: 'understanding', scopeKey: unitId, inputsDigest: `${unitId}-inputs`, retries: 2, at });
  must(await advanceUnit(owner!, { unitId, event: { type: 'admit', at, generation: 1 } }), `admitting ${unitId}`);
  const leased = must(await leaseUnit(owner!, { unitId, holder: 'checked-writes-test', ttlMs: 600_000, at }), `leasing ${unitId}`);
  const fence = leased.context.fence;
  must(await advanceUnit(owner!, { unitId, event: { type: 'start', at, generation: 1, fence } }), `starting ${unitId}`);
  const draft = recordedDraftSet(owner!, { unitId, generation: 1, at: () => at });
  return {
    unitId,
    generation: 1,
    fence,
    draft,
    session: {
      unit: { unitId, generation: 1 },
      source: SOURCE,
      layer: 'inferred',
      scope: writeScope(scope),
      snapshot: snapshots,
      draft,
      graph: options.graph ?? memoryGraph(),
    },
  };
}

/** Publishes one running unit's draft set through the machine's own publication: the facts land in the fact store. */
async function publishRunning(unit: RunningUnit, writes: readonly StageDraftWrite[]): Promise<number> {
  await recordUnitDraft(owner!, { unitId: unit.unitId, generation: unit.generation, writes, at: NOW });
  must(await advanceUnit(owner!, { unitId: unit.unitId, event: { type: 'submit-draft', at: NOW, generation: unit.generation, fence: unit.fence } }), `drafting ${unit.unitId}`);
  must(await advanceUnit(owner!, { unitId: unit.unitId, event: { type: 'validate-draft', at: NOW, generation: unit.generation, fence: unit.fence } }), `validating ${unit.unitId}`);
  const record = await readUnit(owner!, unit.unitId);
  if (record === null) throw new Error(`the test published unit "${unit.unitId}", which the store does not hold`);
  const plan: UnitPlanRecord = { unitId: unit.unitId, generation: unit.generation, runId: RUN, stageId: 'understanding', stageUnitId: 'understanding', scope: 'understanding', stagePosition: 0, planPosition: 0, plannedAt: NOW };
  const outcome = await publishUnit(owner!, {
    unitId: unit.unitId,
    generation: unit.generation,
    fence: unit.fence,
    identity: { inputsDigest: record.inputsDigest, stageId: 'understanding', stageVersion: 1 },
    at: NOW,
    revalidate: async () => ({ membership: 'no reads', members: 0 }),
    apply: async (executor, facts, digest) => await FACT_APPLICATION.apply({ executor, unit: record, plan, digest, writes: facts }),
  });
  if (outcome.outcome !== 'published') throw new Error(`the test's publication of "${unit.unitId}" was ${JSON.stringify(outcome)}`);
  return outcome.record.facts;
}

/** Publishes one unit's set on its own, and answers the fact ids it now holds. */
async function publishedFacts(unitId: string, writes: readonly StageDraftWrite[], repository = REPOSITORY): Promise<readonly string[]> {
  const unit = await runningUnit(unitId, { scope: `${repository}:src` });
  await publishRunning(unit, writes);
  return (await readUnitFacts(owner!, unitId)).map((entry) => entry.fact.id);
}

/**
 * How a write answered, for a failure message: the one word an accepted write
 * answers with, or every refusal it came back with. A test that expected an
 * accepted write and was refused then says why, in the module's own words.
 */
function settlement(answer: { readonly ok: boolean }): string {
  return answer.ok ? 'accepted' : JSON.stringify((answer as unknown as { readonly refusals: unknown }).refusals);
}

/** One provenance for a fact a test puts in the store itself, at the pinned commit. */
function provenanceAt(file: string, repository = REPOSITORY): FactProvenance {
  return {
    source: SOURCE,
    repository: { id: repository, commit: repo.commit },
    place: { file: repositoryPath(file), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } },
  };
}

/** One entity proposal, as the graph holds it. */
function proposal(name: string, repository = REPOSITORY): Fact {
  return makeNodeFact({
    kind: 'entity-proposal',
    value: { repository, proposed: 'concept', name },
    provenance: provenanceAt('src/cart.ts', repository),
    layer: 'inferred',
  });
}

/** One symbol a deterministic stage published: a node an agent's write may join. */
function symbol(qualifiedName: string): Fact {
  return makeNodeFact({
    kind: 'symbol',
    value: { repository: REPOSITORY, file: repositoryPath('src/cart.ts'), qualifiedName, symbolKind: 'function' },
    provenance: provenanceAt('src/cart.ts'),
    layer: 'extracted',
  });
}

/** The claim the task's own scenario is about: one assertion citing a place. */
const CLAIM = {
  subject: { form: 'literal', text: 'the cart total' },
  predicate: 'is-implemented-by',
  object: { form: 'literal', text: 'Cart.total' },
};

/** The place request of the task's normal scenario: lines 3 to 5 of the file the fixture holds. */
const LINES_3_TO_5 = { repository: REPOSITORY, file: 'src/cart.ts', startLine: 3, endLine: 5 };

/** What the write path must build for that write: the identity of the claim, at the pinned commit and the span cited. */
function expectedClaimId(range: { startLine: number; startColumn: number; endLine: number; endColumn: number }): string {
  return factId({
    kind: 'claim',
    value: CLAIM as never,
    provenance: { source: SOURCE, repository: { id: REPOSITORY, commit: repo.commit }, place: { file: repositoryPath('src/cart.ts'), range } },
  });
}

describe('the scope a unit writes inside', () => {
  test('the plan\'s own scope text is read as it stands, and a text that is no scope is refused', () => {
    expect(writeScope(REPOSITORY)).toEqual({ repository: REPOSITORY });
    expect(writeScope(`${REPOSITORY}:src`)).toEqual({ repository: REPOSITORY, path: 'src' });
    expect(scopeText(writeScope(`${REPOSITORY}:src`))).toBe(`${REPOSITORY}:src`);
    expect(scopeText(writeScope(REPOSITORY))).toBe(REPOSITORY);
    for (const text of ['', ':', `${REPOSITORY}:`, '../outside', '/absolute', `${REPOSITORY}:src/`, 'a b:c']) {
      expect(() => writeScope(text)).toThrow(/is no unit scope/);
    }
  });
});

describe('the write the task describes', () => {
  test('a fact citing lines 3-5 of a file that holds them lands in the unit\'s draft set, visible as draft', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:normal');
    const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: LINES_3_TO_5 });
    expect(settlement(answer)).toBe('accepted');
    if (!answer.ok) return;
    const range = { startLine: 3, startColumn: 0, endLine: 5, endColumn: CART_LINES[4]!.length };
    expect(answer.fact.id).toBe(expectedClaimId(range));
    expect(answer.fact.kind).toBe('claim');
    expect(answer.fact.provenance.repository.commit).toBe(repo.commit);
    expect(answer.fact.provenance.place).toEqual({ file: repositoryPath('src/cart.ts'), range });
    // 0005: an agent's statement is `inferred`, and a person's acceptance is a record beside it, never a rewrite.
    expect(answer.fact.layer).toBe('inferred');
    expect(answer.fact.status).toBe('proposed');
    expect(answer.evidence).toBe(`${REPOSITORY}@${repo.commit}:src/cart.ts`);
    expect(answer.position).toBe(1);
    expect(answer.writes).toBe(1);

    // The draft set is the machine's own row, and the store answers it as draft.
    const draft = await readUnitDraft(owner!, unit.unitId, unit.generation);
    expect(draft?.draft).toBe(true);
    expect(draft?.writes).toEqual([{ kind: 'fact', evidence: `${REPOSITORY}@${repo.commit}:src/cart.ts`, value: answer.fact }]);
    expect(draft?.facts.map((fact) => fact.id)).toEqual([answer.fact.id]);
    expect(draft?.problems).toEqual([]);
    // A draft is never mixed with a published fact, and a node of a draft is not a node of the graph.
    expect(await readFact(owner!, answer.fact.id)).toBeNull();
    expect(await readUnitFacts(owner!, unit.unitId)).toEqual([]);

    // And the unit's own publication publishes exactly what it wrote (0026, one publication per generation).
    expect(await publishRunning(unit, await unit.draft.writes())).toBe(1);
    expect((await readUnitFacts(owner!, unit.unitId)).map((entry) => entry.fact.id)).toEqual([answer.fact.id]);
    expect((await readFact(owner!, answer.fact.id))?.fact.kind).toBe('claim');
    expect(await readUnitDraft(owner!, unit.unitId, unit.generation)).toBeNull();
  }, 60_000);

  test('the same fact citing line 900 of a 10-line file is refused, and the refusal names the span', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:span');
    const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'src/cart.ts', startLine: 900 } });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusals).toHaveLength(1);
    const refusal = answer.refusals[0]!;
    expect(refusal.field).toBe('place.range');
    expect(refusal.reason).toContain('line 900');
    expect(refusal.reason).toContain('holds 10 lines');
    expect(refusal.file).toBe('src/cart.ts');
    expect(refusal.line).toBe(900);
    // The id a refused write would have had is the id of a fact that stands on bytes no reader can hold.
    expect(expectedClaimId({ startLine: 900, startColumn: 0, endLine: 900, endColumn: 0 })).toMatch(/^claim:[0-9a-f]{64}$/);
    // Nothing of a refused write is stored, not even in part.
    expect(await unit.draft.writes()).toEqual([]);
    expect(await readUnitDraft(owner!, unit.unitId, unit.generation)).toBeNull();
  }, 60_000);

  test('the bytes a span is held to are the pinned commit\'s, whatever the checkout holds now', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:pinned');
    await writeFile(join(repo.root, 'src', 'cart.ts'), 'one line now\n');
    try {
      const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: LINES_3_TO_5 });
      expect(settlement(answer)).toBe('accepted');
      const past = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'src/cart.ts', startLine: 11 } });
      expect(past.ok).toBe(false);
      if (past.ok) return;
      expect(past.refusals[0]?.reason).toContain('holds 10 lines');
    } finally {
      await writeFile(join(repo.root, 'src', 'cart.ts'), CART);
    }
  }, 60_000);

  test('a column past the end of the line it cites is refused, naming the column and the line', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:column');
    const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'src/cart.ts', startLine: 3, endLine: 3, endColumn: 40 } });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusals[0]?.field).toBe('place.range');
    expect(answer.refusals[0]?.reason).toContain('column 40 of line 3');
    expect(answer.refusals[0]?.reason).toContain(`holds ${CART_LINES[2]!.length} characters`);
  }, 60_000);
});

describe('the checks a write passes before it lands', () => {
  test('a file the pinned commit does not hold is refused by its own path', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:nofile');
    const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'src/gone.ts', startLine: 1 } });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusals[0]?.field).toBe('place.file');
    // The refusal names the repository, the commit and the path it refused (the snapshot reader's own words).
    expect(answer.refusals[0]?.reason).toContain('"src/gone.ts" is not in the tree');
    expect(answer.refusals[0]?.reason).toContain(REPOSITORY);
    expect(answer.refusals[0]?.reason).toContain(repo.commit);
  }, 60_000);

  test('a write outside the unit\'s scope is refused, naming the scope it stands outside', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:scoped');
    const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'lib/total.ts', startLine: 1 } });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusals[0]?.field).toBe('place.file');
    expect(answer.refusals[0]?.reason).toContain('"acme-shop:src"');
    expect(answer.refusals[0]?.reason).toContain('"lib/total.ts"');
    // The same write lands in the unit that covers `lib`, and in one that covers the whole repository.
    const elsewhere = await runningUnit('understanding:acme-shop:lib:wider', { scope: `${REPOSITORY}:lib` });
    expect((await assertFact(elsewhere.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'lib/total.ts', startLine: 1 } })).ok).toBe(true);
    const whole = await runningUnit('understanding:acme-shop:everywhere', { scope: REPOSITORY });
    expect((await assertFact(whole.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'lib/total.ts', startLine: 1 } })).ok).toBe(true);
  }, 60_000);

  test('a write about another repository is refused, naming the one the unit was planned for', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:other-repo');
    const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: 'acme-web', file: 'src/cart.ts', startLine: 1 } });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusals[0]?.field).toBe('place.repository');
    expect(answer.refusals[0]?.reason).toContain('"acme-shop:src"');
    expect(answer.refusals[0]?.reason).toContain('"acme-web"');
  }, 60_000);

  test('the schema refuses a write at the field it stands at', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:schema');
    const badPredicate = await assertFact(unit.session, { kind: 'claim', value: { ...CLAIM, predicate: 'Is Implemented By' }, place: LINES_3_TO_5 });
    expect(badPredicate.ok).toBe(false);
    if (badPredicate.ok) return;
    expect(badPredicate.refusals[0]?.field).toBe('value.predicate');
    expect(badPredicate.refusals[0]?.reason).toContain('is no token');

    const unknownKind = await assertFact(unit.session, { kind: 'invented', value: CLAIM, place: LINES_3_TO_5 });
    expect(unknownKind.ok).toBe(false);
    if (unknownKind.ok) return;
    expect(unknownKind.refusals[0]?.field).toBe('kind');
    expect(unknownKind.refusals[0]?.reason).toContain('is not a fact kind');

    // A link draws an edge: a node kind is refused at the write's own kind.
    const nodeLink = await link(unit.session, { kind: 'module', value: { from: `module:${'a'.repeat(64)}`, to: `module:${'b'.repeat(64)}` }, place: LINES_3_TO_5 });
    expect(nodeLink.ok).toBe(false);
    if (nodeLink.ok) return;
    expect(nodeLink.refusals[0]?.field).toBe('kind');
    expect(nodeLink.refusals[0]?.reason).toContain('a link draws an edge');
    expect(await unit.draft.writes()).toEqual([]);
  }, 60_000);

  test('a node the graph does not hold is refused, and one it holds is joined', async () => {
    const callee = symbol('cart.total');
    const caller = symbol('cart.add');
    // An end the schema names for the edge (a deploy unit), and one it does not (a module).
    const deploy = makeNodeFact({ kind: 'deploy-unit', value: { repository: REPOSITORY, name: 'cart-api', form: 'service' }, provenance: provenanceAt('src/cart.ts'), layer: 'extracted' });
    const module = makeNodeFact({ kind: 'module', value: { repository: REPOSITORY, name: 'cart', seed: 'package' }, provenance: provenanceAt('src/cart.ts'), layer: 'extracted' });
    const unit = await runningUnit('understanding:acme-shop:src:links', {
      graph: memoryGraph({ nodes: [{ id: callee.id, kind: 'symbol' }, { id: caller.id, kind: 'symbol' }, { id: deploy.id, kind: 'deploy-unit' }, { id: module.id, kind: 'module' }] }),
    });
    const joined = await link(unit.session, { kind: 'interaction', value: { caller: caller.id, callee: callee.id, form: 'call' }, place: LINES_3_TO_5 });
    expect(settlement(joined)).toBe('accepted');
    if (!joined.ok) return;
    expect(joined.fact.kind).toBe('interaction');
    expect(joined.write.kind).toBe('link');
    // A carrier the agent saw is a value the schema folds in, and one it did not is no part of the fact.
    const carried = await link(unit.session, { kind: 'interaction', value: { caller: caller.id, callee: callee.id, form: 'http', via: 'POST /api/cart' }, place: LINES_3_TO_5 });
    expect(settlement(carried)).toBe('accepted');
    if (!carried.ok) return;
    expect(carried.fact.id).not.toBe(joined.fact.id);

    const absent = `module:${'c'.repeat(64)}`;
    const refused = await link(unit.session, { kind: 'interaction', value: { caller: caller.id, callee: absent, form: 'call' }, place: LINES_3_TO_5 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals[0]?.field).toBe('value.callee');
    expect(refused.refusals[0]?.reason).toContain(absent);
    expect(refused.refusals[0]?.reason).toContain('stands nowhere in the graph');

    // A deploy unit is an end an interaction joins, and a module is not: the second is refused at its field.
    const deployEnd = await link(unit.session, { kind: 'interaction', value: { caller: caller.id, callee: deploy.id, form: 'http' }, place: LINES_3_TO_5 });
    expect(settlement(deployEnd)).toBe('accepted');
    const wrongKind = await link(unit.session, { kind: 'interaction', value: { caller: caller.id, callee: module.id, form: 'http' }, place: LINES_3_TO_5 });
    expect(wrongKind.ok).toBe(false);
    if (wrongKind.ok) return;
    expect(wrongKind.refusals[0]?.field).toBe('value.callee');
    expect(wrongKind.refusals[0]?.reason).toContain('"module"');
    expect(wrongKind.refusals[0]?.reason).toContain('"deploy-unit" or "symbol"');
  }, 60_000);

  test('a write may join a node the unit\'s own draft set already took', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:own-draft');
    const module = await assertFact(unit.session, {
      kind: 'module',
      value: { repository: REPOSITORY, name: 'cart', seed: 'package' },
      place: LINES_3_TO_5,
    });
    expect(settlement(module)).toBe('accepted');
    if (!module.ok) return;
    // The graph holds nothing of this unit yet: the only node the claim may join is the module it wrote itself.
    const claim = await assertFact(unit.session, {
      kind: 'claim',
      value: { subject: { form: 'node', id: module.fact.id }, predicate: 'is-implemented-by', object: { form: 'literal', text: 'Cart.total' } },
      place: LINES_3_TO_5,
    });
    expect(settlement(claim)).toBe('accepted');
    if (!claim.ok) return;
    expect(claim.fact.value).toMatchObject({ subject: { form: 'node', id: module.fact.id } });
    expect((await unit.draft.writes()).map((write) => write.kind)).toEqual(['fact', 'fact']);
  }, 60_000);
});

describe('the entity a unit proposes', () => {
  test('propose_entity answers with the similar existing entities, and the write lands in the draft set', async () => {
    const published = await publishedFacts('understanding:acme-shop-entities:src:published', [
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('Cart Total', ENTITIES) },
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('cart total of the order', ENTITIES) },
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('shopping cart basket', ENTITIES) },
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('Orders', ENTITIES) },
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('Cart Total', 'other-shop') },
    ], ENTITIES);
    expect(published).toHaveLength(5);
    const unit = await runningUnit('understanding:acme-shop-entities:src:propose', { scope: `${ENTITIES}:src`, graph: factGraph(owner!) });
    const answer = await proposeEntity(unit.session, { proposed: 'concept', name: 'cart total', summary: 'the basket total', place: { repository: ENTITIES, file: 'src/cart.ts', startLine: 1, endLine: 2 } });
    expect(settlement(answer)).toBe('accepted');
    if (!answer.ok) return;
    // The closest first, and the other repository's proposal is never this unit's to join.
    expect(answer.similar.found.map((entity) => `${entity.name}:${entity.similarity}`)).toEqual([
      'Cart Total:same-name',
      'cart total of the order:contains-name',
      'shopping cart basket:shares-word',
    ]);
    expect(answer.similar.total).toBe(3);
    expect(answer.similar.truncated).toBe(false);
    expect(answer.similar.cap).toBe(5);
    expect((answer.fact.value as { repository: string }).repository).toBe(ENTITIES);
    expect((answer.fact.value as { name: string }).name).toBe('cart total');
    expect((await readUnitDraft(owner!, unit.unitId, unit.generation))?.writes.map((write) => write.kind)).toEqual(['entity']);
  }, 60_000);

  test('a similar list longer than the cap is cut, and says how many the graph holds', async () => {
    const published = await publishedFacts('understanding:acme-shop-cap:src:many', ['cart-1', 'cart-2', 'cart-3', 'cart-4', 'cart-5', 'cart-6', 'cart-7']
      .map((name) => ({ kind: 'entity' as const, evidence: 'src/cart.ts:1', value: proposal(name, CAP) })), CAP);
    expect(published).toHaveLength(7);
    const unit = await runningUnit('understanding:acme-shop-cap:src:propose-cap', { scope: `${CAP}:src`, graph: factGraph(owner!) });
    const answer = await proposeEntity(unit.session, { proposed: 'entity', name: 'cart', place: { repository: CAP, file: 'src/cart.ts', startLine: 1 } });
    expect(settlement(answer)).toBe('accepted');
    if (!answer.ok) return;
    expect(answer.similar.found).toHaveLength(5);
    expect(answer.similar.total).toBe(7);
    expect(answer.similar.truncated).toBe(true);
    expect(answer.similar.found.every((entity) => entity.similarity === 'contains-name')).toBe(true);
    // A cut answer names the entities in code point order of their ids: the five first of the seven the graph holds.
    expect(answer.similar.found.map((entity) => entity.id)).toEqual([...published].sort(byCodePoint).slice(0, 5));
  }, 60_000);

  test('a refused proposal is answered with the entities it was compared against, and stores no write', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:propose-refused', {
      graph: memoryGraph({ entities: [{ id: `entity-proposal:${'d'.repeat(64)}`, repository: REPOSITORY, proposed: 'concept', name: 'Cart', similarity: 'same-name' }] }),
    });
    // Refused by its place: the proposal is outside the unit's scope, and the entities are answered anyway.
    const answer = await proposeEntity(unit.session, { proposed: 'concept', name: 'Cart', place: { repository: REPOSITORY, file: 'lib/total.ts', startLine: 1 } });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusals[0]?.field).toBe('place.file');
    expect(answer.similar.found.map((entity) => entity.name)).toEqual(['Cart']);
    // A name the schema cannot read is refused at its own field, and nothing is compared.
    const unnamed = await proposeEntity(unit.session, { proposed: 'concept', name: 42 as unknown as string, place: LINES_3_TO_5 });
    expect(unnamed.ok).toBe(false);
    if (unnamed.ok) return;
    expect(unnamed.refusals[0]?.field).toBe('value.name');
    expect(unnamed.refusals[0]?.reason).toContain('is no text');
    expect(unnamed.similar.total).toBe(0);
    expect(await unit.draft.writes()).toEqual([]);
  }, 60_000);
});

describe('the question a unit raises', () => {
  test('a question about a scope lands as a question, and one about a node the graph lacks is refused', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:question');
    const raised = await raiseQuestion(unit.session, { type: 'assumption-check', prompt: 'Is the cart total the only total?', about: 'src/cart.ts', place: LINES_3_TO_5 });
    expect(settlement(raised)).toBe('accepted');
    if (!raised.ok) return;
    expect(raised.fact.kind).toBe('question');
    expect(raised.fact.value).toMatchObject({ repository: REPOSITORY, type: 'assumption-check', about: 'src/cart.ts', prompt: 'Is the cart total the only total?' });
    expect(raised.write.kind).toBe('question');

    const absent = `module:${'e'.repeat(64)}`;
    const refused = await raiseQuestion(unit.session, { type: 'contradiction', prompt: 'Does any module own this?', about: absent, place: LINES_3_TO_5 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals[0]?.field).toBe('value.about');
    expect(refused.refusals[0]?.reason).toContain(absent);
  }, 60_000);
});

describe('the graph the write path reads', () => {
  test('the fact store answers the nodes a write references and the entities it is compared with', async () => {
    const published = await publishedFacts('understanding:acme-shop-graph:src:store-graph', [
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('Cart', GRAPH) },
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('Checkout', GRAPH) },
      { kind: 'entity', evidence: 'src/cart.ts:1', value: proposal('Cart', 'other-shop') },
    ], GRAPH);
    expect(published).toHaveLength(3);
    const graph = factGraph(owner!);
    expect((await graph.node(published[0]!))?.kind).toBe('entity-proposal');
    expect(await graph.node(`module:${'f'.repeat(64)}`)).toBeNull();
    expect((await graph.similarEntities({ repository: GRAPH, name: 'Cart' })).map((entity) => [entity.name, entity.similarity])).toEqual([['Cart', 'same-name']]);
    expect(await graph.similarEntities({ repository: GRAPH, name: 'Invoice' })).toEqual([]);
  }, 60_000);

  test('a unit\'s draft set is not a node of the graph until its generation is published', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:draft-not-node');
    // A fact of its own: the claim the task describes is published by the test above, and this one is not.
    const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'src/other.ts', startLine: 1 } });
    expect(settlement(answer)).toBe('accepted');
    if (!answer.ok) return;
    expect(await factGraph(owner!).node(answer.fact.id)).toBeNull();
    expect(await publishRunning(unit, await unit.draft.writes())).toBe(1);
    expect((await factGraph(owner!).node(answer.fact.id))?.kind).toBe('claim');
  }, 60_000);

  test('a write after the generation\'s draft set was retracted lands: the retraction was the attempt before it', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:retracted');
    const first = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: LINES_3_TO_5 });
    expect(settlement(first)).toBe('accepted');
    if (!first.ok) return;
    // `retryAttempt` retracts the generation's draft set and runs the same generation again (0027: the
    // next attempt starts clean), and the landed store clears the retraction when a draft is recorded.
    await retractUnitDraft(owner!, { unitId: unit.unitId, generation: unit.generation, at: NOW + 1 });
    expect(await readUnitDraft(owner!, unit.unitId, unit.generation)).toBeNull();
    const second = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: { repository: REPOSITORY, file: 'src/cart.ts', startLine: 1, endLine: 2 } });
    expect(settlement(second)).toBe('accepted');
    if (!second.ok) return;
    expect(second.position).toBe(1);
    const draft = await readUnitDraft(owner!, unit.unitId, unit.generation);
    expect(draft?.draft).toBe(true);
    expect(draft?.facts.map((fact) => fact.id)).toEqual([second.fact.id]);
    expect(await readUnitFacts(owner!, unit.unitId)).toEqual([]);
  }, 60_000);

  test('a port built for a generation reads the writes the machine already holds', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:second-port');
    const written = await assertFact(unit.session, { kind: 'module', value: { repository: REPOSITORY, name: 'cart', seed: 'package' }, place: LINES_3_TO_5 });
    expect(settlement(written)).toBe('accepted');
    if (!written.ok) return;
    // A session that starts again over the same generation: a fresh port over the same rows.
    const restarted: CheckedWriteSession = { ...unit.session, draft: recordedDraftSet(owner!, { unitId: unit.unitId, generation: unit.generation, at: () => NOW }) };
    const claim = await assertFact(restarted, {
      kind: 'claim',
      value: { subject: { form: 'node', id: written.fact.id }, predicate: 'is-implemented-by', object: { form: 'literal', text: 'Cart.total' } },
      place: LINES_3_TO_5,
    });
    expect(settlement(claim)).toBe('accepted');
    if (!claim.ok) return;
    expect(claim.position).toBe(2);
    expect((await unit.draft.writes()).map((write) => write.kind)).toEqual(['fact', 'fact']);
  }, 60_000);

  test('a stage\'s own writer is a draft set the attempt records, and the row stays empty until it does', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:stage-writer');
    const held: StageDraftWrite[] = [];
    const writer: StageDraftWriter = { write: (entry) => { held.push(entry); }, writes: () => ({ writes: held }) };
    const answer = await assertFact({ ...unit.session, draft: draftSetOf(writer) }, { kind: 'claim', value: CLAIM, place: LINES_3_TO_5 });
    expect(settlement(answer)).toBe('accepted');
    if (!answer.ok) return;
    expect(answer.position).toBe(1);
    expect(held.map((write) => write.kind)).toEqual(['fact']);
    // What the orchestrator hands a stage's `execute` records nothing by itself: the attempt records the set.
    expect(await readUnitDraft(owner!, unit.unitId, unit.generation)).toBeNull();
    expect(await publishRunning(unit, held)).toBe(1);
    expect((await readUnitFacts(owner!, unit.unitId)).map((entry) => entry.fact.id)).toEqual([answer.fact.id]);
  }, 60_000);

  test('a place the path cannot read is refused at its own field, before any byte of the snapshot is read', async () => {
    const unit = await runningUnit('understanding:acme-shop:src:place-shape');
    const cases: readonly { readonly what: string; readonly place: unknown; readonly field: string; readonly reason: string }[] = [
      { what: 'no place at all', place: undefined, field: 'place', reason: 'cites where its bytes stand' },
      { what: 'a key a cited place does not hold', place: { ...LINES_3_TO_5, line: 3 }, field: 'place.line', reason: 'is no part of a cited place' },
      { what: 'a path that is no repository path', place: { ...LINES_3_TO_5, file: '../outside.ts' }, field: 'place.file', reason: 'climbs out of the repository' },
      { what: 'a line counted from zero', place: { ...LINES_3_TO_5, startLine: 0 }, field: 'place.startLine', reason: 'lines are counted from 1' },
      { what: 'a file whose bytes are empty', place: { repository: REPOSITORY, file: 'src/empty.ts', startLine: 1 }, field: 'place.range', reason: 'holds no line' },
      { what: 'a span whose columns read backwards', place: { ...LINES_3_TO_5, endLine: 3, startColumn: 5, endColumn: 2 }, field: 'place.range', reason: 'ends at or after the column it starts at' },
    ];
    for (const testCase of cases) {
      const answer = await assertFact(unit.session, { kind: 'claim', value: CLAIM, place: testCase.place as never });
      const seen = answer.ok ? 'accepted' : `${answer.refusals[0]?.field}: ${answer.refusals[0]?.reason}`;
      expect(`${testCase.what} -> ${seen}`).toContain(`${testCase.what} -> ${testCase.field}: `);
      if (answer.ok) continue;
      expect(answer.refusals[0]?.reason).toContain(testCase.reason);
    }
    expect(await unit.draft.writes()).toEqual([]);
    // A unit whose scope names a repository the run pinned nothing for: the place reads, and no reader stands.
    const unpinned = await runningUnit('understanding:acme-gone:src:unpinned', { scope: 'acme-gone:src' });
    const unpinnedAnswer = await assertFact(unpinned.session, { kind: 'claim', value: CLAIM, place: { repository: 'acme-gone', file: 'src/cart.ts', startLine: 1 } });
    expect(unpinnedAnswer.ok).toBe(false);
    if (unpinnedAnswer.ok) return;
    expect(unpinnedAnswer.refusals[0]?.field).toBe('place.repository');
    expect(unpinnedAnswer.refusals[0]?.reason).toContain('is not a repository this run pins');
  }, 60_000);
});

/**
 * The agent-stage shape (madarch-tzte.24.1; decision 0026, "Agent input" and "Scale"):
 * what a stage declares — its fixed part, how its packet is assembled, its plan, and
 * what it may write — and what the shape makes of it.
 *
 * Every expectation is taken from the task and the decisions, never from the module:
 * 0026's numbers and its list of what a starting packet holds, 0027's split semantics,
 * 0005's layers and statuses, and self-filling's three levels (outcome 4). Nothing here
 * runs an agent: the shape's own end-to-end walk is `test/fill-overview-stage.test.ts`
 * over the fake ACP agent.
 */
import { describe, expect, test } from 'bun:test';
import { ANSWER_SCHEMA_VERSION, PROMPT_VERSION, UNIT_ANSWER, buildUnitPacket, readAgentAnswer, unitFixedPart, type AgentAnswer, type AgentPacketSection, type UnitPacket } from '../src/fill/agent-packet.js';
import {
  AGENT_FAN_IN,
  AGENT_SUMMARY_TOKENS,
  PRODUCT_SCOPE_NAME,
  childrenOfPlaces,
  createAgentStage,
  resolvedScale,
  coverageWrites,
  memberPlaces,
  productUnits,
  type AgentPlace,
} from '../src/fill/stages/agent-stage.js';
import { overviewDeclaration } from '../src/fill/stages/overview.js';
import { PRODUCT_SCOPE, writeScope } from '../src/fill/checked-writes.js';
import { DEFAULT_STAGE_LIMITS, type StageGraphReader } from '../src/fill/stage.js';
import { factId } from '../src/fill/facts.js';

/** The answer this suite's own stage declares: one status, the places it read, and one word on what it found. */
const ANSWER: AgentAnswer = {
  shape: '{"status":"done"|"partial","covered":["<a place of your scope>"],"remaining":["<a place of your scope>"],"finding":"<one sentence>"}',
  reading: ['`finding` says what you established, in one sentence.'],
  example: '{"status":"partial","covered":["checkout"],"remaining":["billing"],"finding":"checkout takes an order and never settles it"}',
  fields: [
    { name: 'status', type: 'status', required: true },
    { name: 'covered', type: 'places', required: true },
    { name: 'remaining', type: 'places', required: true },
    { name: 'finding', type: 'text', required: true },
  ],
};

describe('the fixed part a stage declares', () => {
  test('is the stage\'s role, its own rules, its answer with an example, and the level of the fill\'s three it writes', () => {
    const fixed = unitFixedPart({
      limits: DEFAULT_STAGE_LIMITS,
      kinds: ['claim', 'question'],
      role: 'You are one unit of the shape\'s own test.',
      rules: ['Write only what the packet points you at.'],
      answer: ANSWER,
      level: 'intent',
    });
    // 0026's "Agent input": role, rules, limits, the answer schema with an example, and the tools.
    expect(fixed.split('\n')[0]).toBe('You are one unit of the shape\'s own test.');
    expect(fixed).toContain('- Write only what the packet points you at.');
    expect(fixed).toContain(ANSWER.shape);
    expect(fixed).toContain(`Example: ${ANSWER.example}`);
    expect(fixed).toContain('`finding` says what you established, in one sentence.');
    expect(fixed).toContain('What you write is intent');
    // The shape's own rules stand before the stage's, and 0026's numbers are the run's resolved limits.
    expect(fixed).toContain('You have no file, shell, network or terminal tools');
    expect(fixed).toContain('a 272000-token context window');
    expect(fixed).toContain('Facts this unit may write: claim, question — and nothing else');
    // 0026's "Scale": where the unit stands in the hierarchy, and the two bounds the decision fixes.
    const scaled = unitFixedPart({ limits: DEFAULT_STAGE_LIMITS, kinds: ['claim'], scale: resolvedScale({ level: 'product', child: 'repository' }) });
    expect(scaled).toContain('you stand at the product level of the hierarchy product → repository → package → cluster');
    expect(scaled).toContain('a unit that splits into yours covers the repository level');
    expect(scaled).toContain('a child\'s summary you read is at most 2000 tokens');
    expect(scaled).toContain('at most 50 children stand beside one parent');
    // A stage that names no bounds is held to 0026's own, and a stage that names its own narrows them.
    expect(resolvedScale({ level: 'cluster', child: 'place', summaryTokens: 1_500, fanIn: 20 })).toEqual({ level: 'cluster', child: 'place', summaryTokens: 1_500, fanIn: 20 });
    expect(AGENT_SUMMARY_TOKENS).toBe(2_000);
    expect(AGENT_FAN_IN).toBe(50);
    // A stage that names no level writes meaning, and 0026's own answer stands where a stage declares none.
    const landed = unitFixedPart({ limits: DEFAULT_STAGE_LIMITS, kinds: ['claim'] });
    expect(landed).toContain('What you write is meaning');
    expect(landed).toContain(UNIT_ANSWER.shape);
    expect(landed).toContain(`Example: ${UNIT_ANSWER.example}`);
  });
});

describe('the answer a stage declares, read', () => {
  test('the last object the schema reads is the answer, prose around it allowed', () => {
    const read = readAgentAnswer('Here it is: {"status":"partial","covered":["checkout"],"remaining":["billing"],"finding":"half"} — done.', ANSWER);
    expect(read.answer).toBeDefined();
    expect(read.answer?.status).toBe('partial');
    expect(read.answer?.covered).toEqual(['checkout']);
    expect(read.answer?.remaining).toEqual(['billing']);
    expect(read.answer?.texts['finding']).toBe('half');
  });

  test('a wrong field is refused by its name, a missing one by its name, and a list that is no list by its name', () => {
    // 0026: a unit at a limit is asked again, so a malformed answer is a refusal the unit reads, never a failure.
    const wrongStatus = readAgentAnswer('{"status":"mostly","covered":[],"remaining":[],"finding":"x"}', ANSWER);
    expect(wrongStatus.answer).toBeUndefined();
    expect(String(wrongStatus.refusal)).toContain('`status` is `done` or `partial`');
    const missing = readAgentAnswer('{"status":"done","covered":[],"remaining":[]}', ANSWER);
    expect(String(missing.refusal)).toContain('the answer names no `finding`');
    const notAList = readAgentAnswer('{"status":"done","covered":"checkout","remaining":[],"finding":"x"}', ANSWER);
    expect(String(notAList.refusal)).toContain('`covered` is a list of places');
    const nothing = readAgentAnswer('still reading', ANSWER);
    expect(String(nothing.refusal)).toContain('this turn holds no JSON object');
    // An entry that is no place names none: the list is read as its text entries, which can only narrow what the
    // unit covered, never widen it.
    expect(readAgentAnswer('{"status":"done","covered":["a",3],"remaining":[],"finding":"x"}', ANSWER).answer?.covered).toEqual(['a']);
    // A status is every unit's own word (0026's unit contract): a schema without one is refused by name.
    const noStatus: AgentAnswer = { ...ANSWER, fields: ANSWER.fields.filter((field) => field.name !== 'status') };
    expect(String(readAgentAnswer('{"covered":[],"remaining":[],"finding":"x"}', noStatus).refusal)).toContain('names no `status`');
  });
});

describe('the plan of a stage at 0026\'s product level', () => {
  /** The fact id of one repository the fixture holds: the schema's own identity, never a made-up id. */
  function repositoryFactId(name: string): string {
    return factId({ kind: 'repository', value: { repository: name, form: 'code' }, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: name, commit: 'a'.repeat(40) } } });
  }

  /** A reader that answers the repository facts of a fixture, through the grammar's own read text. */
  function repositoriesReader(repositories: readonly string[]): StageGraphReader {
    return {
      async query(text: string) {
        const request = JSON.parse(text) as { read: string; kind?: string; field?: string; value?: string };
        if (request.read !== 'facts-with' || request.kind !== 'repository' || request.field !== 'form') return [];
        // Only the code form answers here: the stage reads the repository facts of the product the stage 0 snapshot
        // published, and a fixture with one form is enough to hold the plan to its own rule.
        return request.value === 'code'
          ? repositories.map((name) => ({
            id: repositoryFactId(name),
            kind: 'repository',
            schema_version: 1,
            provenance: { source: { system: 'fixture', version: '1' }, repository: { id: name, commit: 'a'.repeat(40) } },
            layer: 'extracted',
            status: 'proposed',
            value: { repository: name, form: 'code' },
          }))
          : [];
      },
    };
  }

  test('one unit for the whole product, and nothing found where the graph holds no repository', async () => {
    // 0026's hierarchy, its top: a unit per product, whose scope is every repository the run pins. Its id is the
    // product's own word for the scope, never a run's (0026, "Updates").
    const planned = await productUnits(repositoriesReader(['orders-api', 'billing-api']));
    expect(planned.coverage).toBe('planned');
    // The id is the graph's own word for the product-wide scope (`CoverageValue.scope`'s token); the scope *text* is
    // the one text no repository can be named by, which is what the write path reads.
    expect(planned.units).toEqual([{ id: PRODUCT_SCOPE_NAME, scope: PRODUCT_SCOPE, estimatedTokens: 2 * 2_000 }]);
    // A product the graph holds no repository of is nothing found, which 0027 distinguishes from "no producer".
    expect(await productUnits(repositoriesReader([]))).toEqual({ units: [], coverage: 'nothing-found' });
  });
});

describe('the places a unit of the whole product covers', () => {
  /** One place of the product: the repository's own fact, the name the answer names it by, and 0026's estimate. */
  function place(repository: string, estimatedTokens: number): AgentPlace {
    return {
      id: factId({ kind: 'repository', value: { repository, form: 'code' }, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: repository, commit: 'a'.repeat(40) } } }),
      place: repository,
      scope: repository,
      repository,
      commit: 'a'.repeat(40),
      estimatedTokens,
    };
  }

  test('a child per repository the unit did not cover, and none for a place that is the unit\'s own scope', () => {
    const scope = writeScope(PRODUCT_SCOPE);
    const places = [place('billing-api', 2_000), place('orders-api', 2_000)];
    const children = childrenOfPlaces({ scope, places, covered: ['orders-api'] });
    expect(children.map((child) => child.scope)).toEqual(['billing-api']);
    expect(children[0]?.id).toBe(places[0]!.id);
    // Every place of a product unit is a repository, and none of them is the unit's own scope: a child named by the
    // product's own scope would be the same unit again.
    expect(childrenOfPlaces({ scope: writeScope('orders-api'), places: [place('orders-api', 2_000)], covered: [] })).toEqual([]);
    // 0027's bound on one split is the orchestrator's; the stage names at most eight children and the rest stay gaps.
    const many = Array.from({ length: 10 }, (_unused, index) => place(`repo-${String(index).padStart(2, '0')}`, 2_000));
    expect(childrenOfPlaces({ scope, places: many, covered: [] }).length).toBe(8);
  });

  test('a coverage per repository the unit\'s places stand in, complete only for the repositories it read', () => {
    const scope = writeScope(PRODUCT_SCOPE);
    const places = [place('billing-api', 2_000), place('orders-api', 2_000)];
    const writes = coverageWrites({
      unit: { id: PRODUCT_SCOPE, scope: PRODUCT_SCOPE },
      scope,
      source: { system: 'fixture-agent', version: '1' },
      places,
      covered: ['orders-api'],
      cut: false,
      complete: true,
      cutGap: 'the places the list did not hold',
    });
    expect(writes.length).toBe(2);
    // The identity of a coverage names its repository, its scope and its reader, so a unit of the product writes one
    // fact per repository and none of them replaces another.
    const values = writes.map((write) => (write.value as unknown as { value: { repository: string; scope: string; complete: boolean; read: readonly string[]; unread: readonly { what: string; reason: string }[] } }).value);
    expect(values.map((value) => [value.repository, value.scope, value.complete, value.read, value.unread])).toEqual([
      ['billing-api', PRODUCT_SCOPE_NAME, false, [], [{ what: 'billing-api', reason: 'budget' }]],
      ['orders-api', PRODUCT_SCOPE_NAME, true, ['orders-api'], []],
    ]);
    // The evidence is the draft's own spelling: the repository, the commit and no path, since a place is the whole
    // repository of the product.
    expect(writes.map((write) => write.evidence)).toEqual([`billing-api@${'a'.repeat(40)}`, `orders-api@${'a'.repeat(40)}`]);
    // 0005: an agent's statement is inferred and proposed.
    for (const write of writes) {
      const fact_ = write.value as unknown as { layer: string; status: string; kind: string };
      expect(fact_.kind).toBe('coverage');
      expect(fact_.layer).toBe('inferred');
      expect(fact_.status).toBe('proposed');
    }
  });
});

describe('a stage\'s own packet sections', () => {
  /** The reader a product-level packet with no graph sections needs: it answers nothing, and every read it is asked. */
  function reader(rows: readonly unknown[], asked: string[] = []): StageGraphReader {
    return { async query(text: string) { asked.push(text); return [...rows]; } };
  }

  /** One declared section over a fixed list of rows, as a stage declares one. */
  function section(name: string, rows: readonly unknown[], extra: Partial<AgentPacketSection> = {}): AgentPacketSection {
    return { name, what: `the ${name} of the product`, rows: () => [...rows], ...extra };
  }

  /** A product unit's packet: no scope node, so the packet is the shape's own two sections and the stage's. */
  function request(sections: readonly AgentPacketSection[]): Parameters<typeof buildUnitPacket>[0] {
    return {
      unit: { id: PRODUCT_SCOPE_NAME, scope: PRODUCT_SCOPE },
      product: [{ repository: 'orders-api', commit: 'a'.repeat(40), form: 'code' }],
      graph: reader([]),
      limits: DEFAULT_STAGE_LIMITS,
      kinds: ['claim', 'coverage'],
      task: 'Write the product\'s overview.',
      sections,
    };
  }

  test('a declared section is read, held in the packet under its own key, and its own bound is the cut it names', async () => {
    const rows = Array.from({ length: 25 }, (_unused, index) => ({ name: `module-${String(index).padStart(2, '0')}` }));
    const packet = await buildUnitPacket(request([section('modules', rows, { max: 20 })]));
    // 0026's "Agent input": the stage's own list stands between the shape's packet and the kinds it may write.
    expect(packet.sections).toEqual(['unit', 'place', 'modules', 'writes']);
    const parsed = JSON.parse(packet.packet) as Record<string, unknown>;
    expect((parsed['modules'] as { name: string }[]).length).toBe(20);
    expect((parsed['modules'] as { name: string }[])[0]?.name).toBe('module-00');
    // 0026's "no silently smaller result": the list's own bound cuts it, and the packet's marker says so.
    expect(String(packet.marker)).toContain('the modules of the product holds 25 rows');
    expect(String(packet.marker)).toContain('this list\'s own bound of 20 rows');
    expect(parsed['marker']).toBe(packet.marker);
    // Nothing outside 0026's cap, and the stage's section is exactly what the stage wrote.
    expect(packet.tokens).toBeLessThanOrEqual(20_000);
  });

  test('a section that would take a key the packet already holds is refused by name, and so is a second one', async () => {
    // The shape's own keys belong to the shape: a stage section under `members` would replace a list the packet had
    // already read and charged for, and the agent would never learn the list was cut.
    await expect(buildUnitPacket(request([section('place', [])]))).rejects.toThrow(/a key the packet already holds/);
    await expect(buildUnitPacket(request([section('writes', [])]))).rejects.toThrow(/a key the packet already holds/);
    await expect(buildUnitPacket(request([section('modules', []), section('modules', [])]))).rejects.toThrow(/a key the packet already holds/);
    // A section a stage declares for another level is not in this unit's packet at all.
    const packet = await buildUnitPacket(request([section('modules', [{ name: 'checkout' }], { when: () => false })]));
    expect(packet.sections).toEqual(['unit', 'place', 'writes']);
  });
});

describe('the places a unit of one repository covers', () => {
  test('the member that stands at a path wins over a ranked member that only cites it', () => {
    // A packet's members are ranked (0026: "ranked symbols without bodies"), so an entry point or a module at a file's
    // path comes first. A child named by such a member would describe a node whose own places lie outside the child's
    // write scope, so the folder or the file itself names the place (madarch-tzte.22.3's rule for a split's
    // children, now the shape's own place reader).
    const file = factId({ kind: 'file', value: { repository: 'orders-api', path: 'src/index.ts' as never, roles: ['source'], language: 'typescript' }, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: 'orders-api', commit: 'a'.repeat(40) } } });
    const module = factId({ kind: 'module', value: { repository: 'orders-api', name: 'checkout', seed: 'package' }, provenance: { source: { system: 'fixture', version: '1' }, repository: { id: 'orders-api', commit: 'a'.repeat(40) } } });
    const packet = {
      unit: { id: 'orders-api', scope: 'orders-api' },
      place: { repository: 'orders-api', commit: 'a'.repeat(40) },
      members: [
        { kind: 'module' as const, label: 'checkout', id: module, file: 'src/index.ts', place: 'orders-api:src/index.ts' },
        { kind: 'file' as const, label: 'orders-api:src/index.ts', id: file, file: 'src/index.ts', place: 'orders-api:src/index.ts' },
      ],
      membersCut: false,
    } as unknown as UnitPacket;
    const places = memberPlaces({ unit: { id: 'orders-api', scope: 'orders-api' }, scope: writeScope('orders-api'), packet, graph: { async query() { return []; } } });
    expect(places.places.map((place) => [place.place, place.id])).toEqual([['src/index.ts', file]]);
    expect(places.cut).toBe(false);
  });
});

describe('a declaration the schema refuses at registration', () => {
  const wiring = { agent: { id: 'fake-agent', command: 'bun' }, snapshots: {} as never };

  test('a kind its own stage of the fill does not write is refused by name, and so is a kind the schema lacks', () => {
    // `entity-proposal` is 0026's stages 12 and 13, so a stage-8 declaration that named it would have every write of it
    // refused at publication, after the agent run; the refusal lands where the declaration is read.
    expect(() => createAgentStage({ ...overviewDeclaration(), kinds: ['claim', 'entity-proposal'] }, wiring)).toThrow(/the agent stage "overview" declares the fact kind "entity-proposal" and names 0026's stage "8-overview"/);
    expect(() => createAgentStage({ ...overviewDeclaration(), kinds: ['claims'] }, wiring)).toThrow(/is no kind of the schema: the schema's kinds are/);
  });

  test("the stage it builds carries its cache key's versions: the prompt, the answer schema and the agent it is driven with", async () => {
    // Decision 0026, "Updates": a unit's cache key holds "the prompt, schema and model versions" beside its
    // reads, its spans and its inputs, so a run that resolves another of them replaces the units the last one
    // planned. The shape puts them on every stage it builds, whatever its id — this is where madarch-tzte.26.1's
    // round-3 review found them missing.
    const { agentIdentity } = await import('../src/fill/stages/agent-stage.js');
    const spec = { id: 'omp', command: 'opencode', args: ['--model', 'glm-5.3-flash'] };
    const stage = createAgentStage(overviewDeclaration(), { agent: spec, snapshots: {} as never });
    expect(stage.cacheVersions?.()).toEqual({
      prompt: PROMPT_VERSION,
      answer: ANSWER_SCHEMA_VERSION,
      agent: agentIdentity(spec),
    });
    // The agent's own identity is the program, its arguments and its id: another model is another key.
    const other = createAgentStage(overviewDeclaration(), { agent: { ...spec, args: ['--model', 'deepseek-v4.1'] }, snapshots: {} as never });
    expect(other.cacheVersions?.()).not.toEqual(stage.cacheVersions?.());
  });
});

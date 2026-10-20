import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { readFillStageConfiguration } from '../src/fill/config.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { overviewDeclaration } from '../src/fill/stages/overview.js';
import {
  deriveStageGraph, resolveStageConfiguration, snapshotStageConfigurations, StageRegistry, type DerivedStageGraph,
} from '../src/fill/registry.js';
import { DEFAULT_STAGE_DEFAULTS, DEFAULT_STAGE_LIMITS, type FillStage } from '../src/fill/stage.js';
import { MANIFEST_FILE } from '../src/product/manifest.js';
import { summaryStage } from './fill-stage-summary.js';

/** A fake stage: the declaration under test, everything else a placeholder. */
function fakeStage(id: string, declaration: Partial<FillStage> = {}): FillStage {
  return {
    id,
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [],
    configSchema: Type.Object({}),
    defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [], coverage: 'planned' }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
    ...declaration,
  };
}

/**
 * The chain decision 0026 and 0027 shape: a deterministic stage writes file
 * facts, a second clusters them into module facts, the fixture module
 * summarises the modules (and orders itself after the snapshot it does not
 * consume), and two consumers read the summaries into pages and an overview.
 */
function chainRegistry(): StageRegistry {
  return new StageRegistry()
    .register(fakeStage('snapshot', { produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }] }))
    .register(fakeStage('modules', {
      consumes: { required: [{ capability: 'file-facts', scope: 'repository' }], optional: [] },
      produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'repository' }],
    }))
    .register(summaryStage)
    .register(fakeStage('pages', {
      consumes: {
        required: [
          { capability: 'module-summaries', scope: 'repository' },
          { capability: 'module-facts', scope: 'repository' },
        ],
        optional: [],
      },
      produces: [{ kind: 'page-drafts', schemaVersion: 1, scope: 'product' }],
    }))
    .register(fakeStage('overview', {
      consumes: { required: [{ capability: 'page-drafts', scope: 'product' }], optional: [] },
      produces: [{ kind: 'product-overview', schemaVersion: 1, scope: 'product' }],
    }));
}

/** A product folder holding one manifest, written from lines so a test can pin their numbers. */
async function productWith(lines: readonly string[]): Promise<{ folder: string; manifest: string; dispose: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), 'madarch-fill-registry-'));
  await writeFile(join(folder, MANIFEST_FILE), lines.join('\n') + '\n');
  return { folder, manifest: join(folder, MANIFEST_FILE), dispose: () => rm(folder, { recursive: true, force: true }) };
}

/** A manifest whose third line opens `fill.stages`, the lines a test adds standing under it. */
function manifest(...stages: string[]): string[] {
  return [
    'schemaVersion: 1',
    'id: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f',
    'name: stage-registry-fixture',
    'fill:',
    '  stages:',
    ...stages,
  ];
}

/** The graph a derivation gave, refusing loudly where it refused: a fixture expected to plan. */
function deriveGraph(registry: StageRegistry, configuration?: ReturnType<typeof readFillStageConfiguration>): DerivedStageGraph {
  const read = deriveStageGraph(registry, configuration);
  if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
  return read.graph;
}

/** The product's configuration as a run would hand it in, without a file behind it. */
function configured(stages: Record<string, unknown>): { ok: true; file: string; stages: Record<string, unknown>; lines: Record<string, number> } {
  return { ok: true, file: '', stages, lines: Object.fromEntries(Object.keys(stages).map((id) => [id, 1])) };
}

describe('the stage contract and its defaults', () => {
  test('the defaults are the numbers decision 0026 and 0027 fix', () => {
    expect(DEFAULT_STAGE_LIMITS).toEqual({
      contextTokens: 272_000,
      wrapAtFraction: 0.7,
      stopAtFraction: 0.8,
      maxTurns: 30,
      maxDurationMs: 10 * 60 * 1000,
      maxOutputTokens: 16_000,
    });
    expect(DEFAULT_STAGE_DEFAULTS).toEqual({ enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} });
  });

  test('a stage is registered once, and a second registration of one id is refused', () => {
    const registry = new StageRegistry().register(summaryStage);
    expect(registry.get('summary')?.version).toBe(3);
    expect(registry.get('absent')).toBeUndefined();
    expect(() => registry.register(fakeStage('summary', { version: 4 })))
      .toThrow('the stage "summary" is registered twice (versions 3 and 4): each stage is registered once');
  });

  test('a stage id a product could never name is refused where it is made', () => {
    expect(() => new StageRegistry().register(fakeStage('bad id')))
      .toThrow('the stage id "bad id" is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"');
    expect(() => new StageRegistry().register(fakeStage('9lives'))).toThrow('"9lives" is not a stage id');
  });

  test('the registry lists its stages in code point order whatever the registration order', () => {
    const registry = new StageRegistry()
      .register(fakeStage('summary'))
      .register(fakeStage('Claims'))
      .register(fakeStage('claims'))
      .register(fakeStage('draft'));
    // Code point order, not locale collation: an upper-case letter sorts
    // before every lower-case one, so `Claims` leads.
    expect(registry.all().map((stage) => stage.id)).toEqual(['Claims', 'claims', 'draft', 'summary']);
  });
});

describe('the stage graph derived from capabilities', () => {
  test('a full registry whose required capabilities are produced plans cleanly', () => {
    const read = deriveStageGraph(chainRegistry());
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.order).toEqual(['snapshot', 'modules', 'summary', 'pages', 'overview']);
    expect(read.graph.stages.map((stage) => [stage.id, stage.version, stage.enabled])).toEqual([
      ['modules', 1, true],
      ['overview', 1, true],
      ['pages', 1, true],
      ['snapshot', 1, true],
      ['summary', 3, true],
    ]);
    expect(read.graph.edges).toEqual([
      { from: 'modules', to: 'pages', via: 'module-facts' },
      { from: 'modules', to: 'summary', via: 'module-facts' },
      { from: 'pages', to: 'overview', via: 'page-drafts' },
      { from: 'snapshot', to: 'modules', via: 'file-facts' },
      { from: 'snapshot', to: 'summary', via: 'after' },
      { from: 'summary', to: 'pages', via: 'module-summaries' },
    ]);
  });

  test('one module plus its registration adds a stage, and the graph follows what it declares', () => {
    // The fixture module declares version 3, produces `module-summaries` at
    // schema version 2 and orders itself after `snapshot`: registering it is
    // all the registry asks, and every later reader sees those declarations.
    const read = deriveStageGraph(chainRegistry());
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.stages.find((stage) => stage.id === 'summary')).toEqual({
      id: 'summary',
      version: 3,
      enabled: true,
      concurrency: 2,
      limits: DEFAULT_STAGE_LIMITS,
      config: { maxDepth: 3 },
    });
    expect(read.graph.edges.filter((edge) => edge.to === 'pages').map((edge) => edge.via))
      .toEqual(['module-facts', 'module-summaries']);
    expect(read.graph.edges).toContainEqual({ from: 'snapshot', to: 'summary', via: 'after' });
  });

  test('a capability edge and an ordering edge of one pair are drawn once', () => {
    const registry = new StageRegistry()
      .register(fakeStage('modules', { produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('pages', {
        consumes: { required: [{ capability: 'module-facts', scope: 'repository' }], optional: [] },
        after: ['modules'],
      }));
    const read = deriveStageGraph(registry);
    if (!read.ok) throw new Error('expected a clean graph');
    expect(read.graph.edges).toEqual([{ from: 'modules', to: 'pages', via: 'module-facts' }]);
  });

  test('a capability required twice draws one edge', () => {
    const registry = new StageRegistry()
      .register(fakeStage('modules', { produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('pages', {
        consumes: {
          required: [
            { capability: 'module-facts', scope: 'repository' },
            { capability: 'module-facts', scope: 'repository', freshness: 'current' },
          ],
          optional: [],
        },
      }));
    const read = deriveStageGraph(registry);
    if (!read.ok) throw new Error('expected a clean graph');
    expect(read.graph.edges).toEqual([{ from: 'modules', to: 'pages', via: 'module-facts' }]);
  });

  test('an optional consume of a produced capability orders the consumer after its producer', () => {
    // "Read when present" is true of this run only if the consumer runs after
    // the producer that publishes it, so an optional consume draws the same
    // edge a required one does — and starves nobody when the producer does not
    // run.
    const registry = new StageRegistry()
      .register(fakeStage('history', { produces: [{ kind: 'history-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('summary', { consumes: { required: [], optional: [{ capability: 'history-facts', scope: 'repository' }] } }));
    const read = deriveStageGraph(registry);
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.order).toEqual(['history', 'summary']);
    expect(read.graph.edges).toEqual([{ from: 'history', to: 'summary', via: 'history-facts' }]);
  });

  test('an optional consume whose producers are disabled draws no edge and starves nothing', () => {
    const registry = new StageRegistry()
      .register(fakeStage('history', { produces: [{ kind: 'history-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('crawl', { produces: [{ kind: 'history-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('summary', { consumes: { required: [], optional: [{ capability: 'history-facts', scope: 'repository' }] } }));
    const read = deriveStageGraph(registry, configured({ history: { enabled: false }, crawl: { enabled: false } }));
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.order).toEqual(['summary']);
    expect(read.graph.edges).toEqual([]);
  });

  test('one capability consumed both as required and as optional draws one edge', () => {
    const registry = new StageRegistry()
      .register(fakeStage('modules', { produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('summary', {
        consumes: {
          required: [{ capability: 'module-facts', scope: 'repository' }],
          optional: [{ capability: 'module-facts', scope: 'repository', freshness: 'current' }],
        },
      }));
    const read = deriveStageGraph(registry);
    if (!read.ok) throw new Error('expected a clean graph');
    expect(read.graph.edges).toEqual([{ from: 'modules', to: 'summary', via: 'module-facts' }]);
  });

  test('an `after` naming a stage the product disabled orders nothing', () => {
    // The ordering is "run after those stages that run": a disabled stage is
    // absent from the order, so an edge from it would name a stage the plan
    // never admits.
    const registry = new StageRegistry()
      .register(fakeStage('snapshot'))
      .register(fakeStage('pages', { after: ['snapshot'] }));
    const read = deriveStageGraph(registry, configured({ snapshot: { enabled: false } }));
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.order).toEqual(['pages']);
    expect(read.graph.edges).toEqual([]);
    expect(read.graph.stages.map((stage) => [stage.id, stage.enabled])).toEqual([['pages', true], ['snapshot', false]]);
  });

  test('deriving runs no stage: plan, execute and validate are never called', () => {
    // Decision 0027 separates "no producer" from "producer found nothing":
    // the second is a plan's own answer with its coverage said, so deriving
    // reads declarations and the product's configuration and runs nothing.
    const uncalled = (): never => {
      throw new Error('deriving the stage graph called a stage');
    };
    const registry = new StageRegistry()
      .register(fakeStage('snapshot', {
        produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
        plan: uncalled,
        execute: uncalled,
        validate: uncalled,
      }))
      .register(fakeStage('modules', { consumes: { required: [{ capability: 'file-facts', scope: 'repository' }], optional: [] } }));
    expect(deriveStageGraph(registry).ok).toBe(true);
  });

  test('the order is deterministic, code point order breaking ties', () => {
    const registry = new StageRegistry()
      .register(fakeStage('seed', { produces: [{ kind: 'seed-facts', schemaVersion: 1, scope: 'product' }] }))
      .register(fakeStage('zeta', { consumes: { required: [{ capability: 'seed-facts', scope: 'product' }], optional: [] } }))
      .register(fakeStage('alpha', { consumes: { required: [{ capability: 'seed-facts', scope: 'product' }], optional: [] } }))
      .register(fakeStage('Beta', { consumes: { required: [{ capability: 'seed-facts', scope: 'product' }], optional: [] } }));
    const first = deriveStageGraph(registry);
    const second = deriveStageGraph(registry);
    if (!first.ok || !second.ok) throw new Error('expected a clean graph');
    expect(first.graph.order).toEqual(['seed', 'Beta', 'alpha', 'zeta']);
    expect(second.graph.order).toEqual(first.graph.order);
    expect(second.graph.edges).toEqual(first.graph.edges);
  });

  test('one fact kind produced at two schema versions is refused', () => {
    const registry = new StageRegistry()
      .register(fakeStage('index', { produces: [{ kind: 'file-facts', schemaVersion: 2, scope: 'repository' }] }))
      .register(fakeStage('crawl', { produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('modules', { consumes: { required: [{ capability: 'file-facts', scope: 'repository' }], optional: [] } }));
    const read = deriveStageGraph(registry);
    if (read.ok) throw new Error('expected a refusal');
    expect(read.problems).toEqual([{
      stage: 'crawl',
      path: 'produces.file-facts',
      message: 'the fact kind "file-facts" is produced at schema versions 1 and 2 (by crawl at 1, index at 2): one kind carries one schema version',
    }]);
  });
});

describe('the product configuration enables, disables and limits a stage', () => {
  test('fill.stages.<id> in the manifest reads as written, each entry on its line', async () => {
    const product = await productWith(manifest(
      '    snapshot:',                        // line 6
      '      enabled: false',
      '    modules:',                         // line 8
      '      concurrency: 4',
      '      limits:',
      '        maxTurns: 12',
      '        wrapAtFraction: 0.6',
      '        contextTokens: 131072',
      '    summary:',                         // line 14
      '      config:',
      '        maxDepth: 2',
    ));
    try {
      const read = readFillStageConfiguration(product.folder);
      if (!read.ok) throw new Error(`expected a read, refused: ${JSON.stringify(read.errors)}`);
      expect(read.file).toBe(product.manifest);
      expect(read.stages).toEqual({
        snapshot: { enabled: false },
        modules: { concurrency: 4, limits: { maxTurns: 12, wrapAtFraction: 0.6, contextTokens: 131_072 } },
        summary: { config: { maxDepth: 2 } },
      });
    } finally {
      await product.dispose();
    }
  });

  test('a product folder holding no manifest configures no stage: every default holds', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'madarch-fill-registry-'));
    try {
      const read = readFillStageConfiguration(folder);
      if (!read.ok) throw new Error('expected a read');
      expect(read.stages).toEqual({});
      expect(read.file).toBe(join(folder, MANIFEST_FILE));
      const graph = deriveStageGraph(chainRegistry(), read);
      if (!graph.ok) throw new Error('expected a clean graph');
      expect(graph.graph.stages.map((stage) => [stage.id, stage.enabled, stage.concurrency])).toEqual([
        ['modules', true, 1],
        ['overview', true, 1],
        ['pages', true, 1],
        ['snapshot', true, 1],
        ['summary', true, 2],
      ]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test('a disabled stage leaves the graph and work is not ordered through it', async () => {
    const product = await productWith(manifest(
      '    overview:',
      '      enabled: false',
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
      expect(read.graph.order).toEqual(['snapshot', 'modules', 'summary', 'pages']);
      expect(read.graph.stages.find((stage) => stage.id === 'overview')?.enabled).toBe(false);
      expect(read.graph.edges.some((edge) => edge.to === 'overview' || edge.from === 'overview')).toBe(false);
    } finally {
      await product.dispose();
    }
  });

  test('the limits the product writes ride over the stage\'s defaults, the rest kept', async () => {
    const product = await productWith(manifest(
      '    modules:',
      '      concurrency: 4',
      '      limits:',
      '        maxTurns: 12',
      '        stopAtFraction: 0.75',
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
      expect(read.graph.stages.find((stage) => stage.id === 'modules')).toEqual({
        id: 'modules',
        version: 1,
        enabled: true,
        concurrency: 4,
        limits: {
          contextTokens: 272_000,
          wrapAtFraction: 0.7,
          stopAtFraction: 0.75,
          maxTurns: 12,
          maxDurationMs: 600_000,
          maxOutputTokens: 16_000,
        },
        config: {},
      });
    } finally {
      await product.dispose();
    }
  });

  test('a stage the registry does not hold is read past, whatever its entry says', async () => {
    // The manifest's own rule for a field this madarch does not know: a
    // product's configuration grows by fields a later madarch reads, so an
    // entry for a stage this madarch does not have is neither judged nor
    // planned.
    const product = await productWith(manifest(
      '    invented:',
      '      concurrency: auto',
      '      limits:',
      '        maxTurns: never',
      '    another: 4',
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
      expect(read.graph.stages.map((stage) => stage.id)).toEqual(['modules', 'overview', 'pages', 'snapshot', 'summary']);
    } finally {
      await product.dispose();
    }
  });

  test('a stage id or a limit name that is a member of Object.prototype is read by what the file wrote', async () => {
    // `constructor` and `toString` are stage ids STAGE_ID_PATTERN allows, so a
    // lookup that read the prototype chain would judge an entry the product
    // never wrote (a stage it left out falsely refused, with a line that is a
    // function) and would call an inherited function in place of a limit rule.
    const registry = new StageRegistry()
      .register(fakeStage('constructor'))
      .register(fakeStage('toString'))
      .register(fakeStage('summary', {
        consumes: { required: [{ capability: 'module-facts', scope: 'repository' }], optional: [] },
      }))
      .register(fakeStage('modules', { produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'repository' }] }));
    const product = await productWith(manifest(
      '    summary:',
      '      limits:',
      '        toString: 3',
      '        constructor: 4',
    ));
    try {
      const read = deriveStageGraph(registry, readFillStageConfiguration(product.folder));
      if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
      expect(read.graph.order).toEqual(['constructor', 'modules', 'summary', 'toString']);
      expect(read.graph.stages.map((stage) => [stage.id, stage.config, stage.limits.maxTurns]))
        .toEqual([['constructor', {}, 30], ['modules', {}, 30], ['summary', {}, 30], ['toString', {}, 30]]);
    } finally {
      await product.dispose();
    }
  });

  test('the run\'s snapshot digest follows the configuration it resolved, not the order it holds it in', async () => {
    const plain = deriveStageGraph(chainRegistry());
    const limited = await productWith(manifest(
      '    modules:',
      '      limits:',
      '        maxTurns: 12',
    ));
    try {
      const changed = deriveStageGraph(chainRegistry(), readFillStageConfiguration(limited.folder));
      if (!plain.ok || !changed.ok) throw new Error('expected two clean graphs');
      const left = snapshotStageConfigurations(plain.graph.stages);
      // Two derivations from one configuration: the same digest. A caller that
      // holds the same configurations in another order is the same run, so the
      // digest is the same too; a changed configuration gives another.
      expect(snapshotStageConfigurations(deriveGraph(chainRegistry()).stages)).toBe(left);
      expect(snapshotStageConfigurations([...plain.graph.stages].reverse())).toBe(left);
      expect(snapshotStageConfigurations(changed.graph.stages)).not.toBe(left);
    } finally {
      await limited.dispose();
    }
  });

  test('a configuration written in another key order digests the same', async () => {
    // The digest is canonical in the configuration's own content: two manifests
    // that write one stage's configuration in two key orders are one resolved
    // configuration, and a changed value is another.
    const registry = (): StageRegistry => new StageRegistry().register(fakeStage('tuned', {
      configSchema: Type.Object({ maxDepth: Type.Integer({ minimum: 1 }), mode: Type.String() }),
      defaults: { ...DEFAULT_STAGE_DEFAULTS, config: { maxDepth: 2, mode: 'deep' } },
    }));
    const digests: string[] = [];
    for (const stages of [
      ['    tuned:', '      config:', '        maxDepth: 4', '        mode: deep'],
      ['    tuned:', '      config:', '        mode: deep', '        maxDepth: 4'],
    ]) {
      const product = await productWith(manifest(...stages));
      try {
        digests.push(snapshotStageConfigurations(deriveGraph(registry(), readFillStageConfiguration(product.folder)).stages));
      } finally {
        await product.dispose();
      }
    }
    expect(digests[1]).toBe(digests[0]!);
    const changed = await productWith(manifest('    tuned:', '      config:', '        maxDepth: 4', '        mode: shallow'));
    try {
      const other = snapshotStageConfigurations(deriveGraph(registry(), readFillStageConfiguration(changed.folder)).stages);
      expect(other).not.toBe(digests[0]!);
    } finally {
      await changed.dispose();
    }
  });

  test('one stage\'s resolved configuration without a product is its own defaults', () => {
    expect(resolveStageConfiguration(summaryStage)).toEqual({
      id: 'summary',
      version: 3,
      enabled: true,
      concurrency: 2,
      limits: DEFAULT_STAGE_LIMITS,
      config: { maxDepth: 3 },
    });
  });
});

describe('the product configuration\'s own refusals', () => {
  test('each fault of an entry names the file, the line and the field\'s path', async () => {
    const cases: readonly { stages: readonly string[]; line: number; path: string; message: string }[] = [
      {
        stages: ['    snapshot:', '      enabled: maybe'],           // `enabled` on line 7
        line: 7,
        path: 'fill.stages.snapshot.enabled',
        message: 'fill.stages.snapshot.enabled is true or false, not "maybe"',
      },
      {
        stages: ['    modules:', '      concurrency: 0'],             // `concurrency` on line 7
        line: 7,
        path: 'fill.stages.modules.concurrency',
        message: 'fill.stages.modules.concurrency is a whole number of 1 or more, not 0',
      },
      {
        stages: ['    modules:', '      limits:', '        wrapAtFraction: 1'],  // line 8
        line: 8,
        path: 'fill.stages.modules.limits.wrapAtFraction',
        message: 'fill.stages.modules.limits.wrapAtFraction is a fraction between 0 and 1, not 1',
      },
      {
        stages: ['    modules:', '      limits:', '        maxDurationMs: -1'],  // line 8
        line: 8,
        path: 'fill.stages.modules.limits.maxDurationMs',
        message: 'fill.stages.modules.limits.maxDurationMs is a whole number of 1 or more, not -1',
      },
      {
        stages: ['    snapshot: 4'],                                  // the entry on line 6
        line: 6,
        path: 'fill.stages.snapshot',
        message: 'fill.stages.snapshot is a mapping of the stage\'s configuration, not 4',
      },
    ];
    for (const refuse of cases) {
      const product = await productWith(manifest(...refuse.stages));
      try {
        const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
        if (read.ok) throw new Error(`expected a refusal of ${refuse.path}`);
        expect(read.problems).toEqual([{
          stage: refuse.path.split('.')[2]!,
          file: product.manifest,
          line: refuse.line,
          path: refuse.path,
          message: refuse.message,
        }]);
        expect(read.config).toEqual([]);
      } finally {
        await product.dispose();
      }
    }
  });

  test('a limit or a field this madarch does not know is read past, never refused', async () => {
    const product = await productWith(manifest(
      '    modules:',
      '      concurrency: 2',
      '      limits:',
      '        maxParagraphs: 3',
      '      retention: 7',
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
      expect(read.graph.stages.find((stage) => stage.id === 'modules')).toMatchObject({
        concurrency: 2,
        limits: DEFAULT_STAGE_LIMITS,
      });
    } finally {
      await product.dispose();
    }
  });

  test('a stage id that is no stage id refuses the file, at its key\'s line', async () => {
    const product = await productWith(manifest('    bad id:', '      enabled: true'));
    try {
      expect(readFillStageConfiguration(product.folder)).toEqual({
        ok: false,
        errors: [{
          file: product.manifest,
          line: 6,
          path: 'fill.stages.bad id',
          message: '"bad id" is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"',
        }],
      });
    } finally {
      await product.dispose();
    }
  });

  test('a fill section that is no mapping refuses the whole configuration', async () => {
    const product = await productWith(['schemaVersion: 1', 'id: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f', 'name: stage-registry-fixture', 'fill: everywhere']);
    try {
      expect(readFillStageConfiguration(product.folder)).toEqual({
        ok: false,
        errors: [{ file: product.manifest, line: 4, path: 'fill', message: 'fill is a mapping of the fill\'s own keys, not "everywhere"' }],
      });
    } finally {
      await product.dispose();
    }
  });

  test('a manifest whose root is no mapping is refused, as the manifest\'s own reader refuses it', async () => {
    const product = await productWith(['just-a-word']);
    try {
      const read = readFillStageConfiguration(product.folder);
      if (read.ok) throw new Error('expected a refusal');
      expect(read.errors).toHaveLength(1);
      expect(read.errors[0]?.file).toBe(product.manifest);
      expect(read.errors[0]?.line).toBe(1);
      expect(read.errors[0]?.message).toBe(`the manifest ${product.manifest} holds "just-a-word": a manifest is a mapping of fields, and this is not one`);
    } finally {
      await product.dispose();
    }
  });

  test('a manifest that does not read refuses the configuration whole, at its own line', async () => {
    const product = await productWith(['schemaVersion: 1', 'fill:', '   stages:', '  snapshot:', '    enabled: false']);
    try {
      const read = readFillStageConfiguration(product.folder);
      if (read.ok) throw new Error('expected a refusal');
      expect(read.errors).toHaveLength(1);
      expect(read.errors[0]?.file).toBe(product.manifest);
      expect(read.errors[0]?.line).toBeGreaterThan(1);
      expect(read.errors[0]?.message.length).toBeGreaterThan(0);
    } finally {
      await product.dispose();
    }
  });

  test('a fill or fill.stages written and left empty configures nothing', async () => {
    for (const lines of [
      ['schemaVersion: 1', 'id: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f', 'name: stage-registry-fixture', 'fill:'],
      ['schemaVersion: 1', 'id: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f', 'name: stage-registry-fixture', 'fill:', '  stages:'],
    ]) {
      const product = await productWith(lines);
      try {
        const read = readFillStageConfiguration(product.folder);
        if (!read.ok) throw new Error(`expected a read, refused: ${JSON.stringify(read.errors)}`);
        expect(read.stages).toEqual({});
        expect(deriveStageGraph(chainRegistry(), read).ok).toBe(true);
      } finally {
        await product.dispose();
      }
    }
  });

  test('a configuration that does not read refuses the graph before anything is derived from it', async () => {
    // The defaults stand for nothing the product agreed to, so a starvation
    // they would show is not reported beside the configuration's own refusal.
    const product = await productWith(['schemaVersion: 1', 'id: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f', 'name: stage-registry-fixture', 'fill: everywhere']);
    try {
      const read = deriveStageGraph(new StageRegistry().register(fakeStage('modules', {
        consumes: { required: [{ capability: 'nothing-provides-this', scope: 'product' }], optional: [] },
      })), readFillStageConfiguration(product.folder));
      if (read.ok) throw new Error('expected a refusal');
      expect(read.config).toEqual([{
        file: product.manifest,
        line: 4,
        path: 'fill',
        message: 'fill is a mapping of the fill\'s own keys, not "everywhere"',
      }]);
      expect(read.problems).toEqual([]);
      expect(read.starvation).toEqual([]);
      expect(read.cycles).toEqual([]);
    } finally {
      await product.dispose();
    }
  });
});

describe('a stage\'s own configuration is judged against its configSchema', () => {
  test('a field the schema refuses is named at its own line and path', async () => {
    const product = await productWith(manifest(
      '    summary:',                                // line 6
      '      config:',
      '        maxDepth: 0',                          // line 8
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (read.ok) throw new Error('expected a refusal');
      expect(read.problems).toEqual([{
        stage: 'summary',
        file: product.manifest,
        line: 8,
        path: 'fill.stages.summary.config.maxDepth',
        message: 'must be >= 1',
      }]);
      expect(read.config).toEqual([]);
      expect(read.starvation).toEqual([]);
    } finally {
      await product.dispose();
    }
  });

  test('a configuration missing what the schema requires is named on the config field', async () => {
    // The fault is the `config` field's: its own value is what lacks
    // `maxDepth`, so the line is the field's and not the stage key's, however
    // far the two stand apart in the file.
    const product = await productWith(manifest(
      '    summary:',                                // line 6, the entry's key
      '      enabled: true',
      '      concurrency: 2',
      '      limits:',
      '        maxTurns: 30',
      '      retention: 7',                       // an unknown field, read past
      '      config:',                              // line 12, the field the fault is about
      '        depth: 2',                             // line 13, the only field written
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (read.ok) throw new Error('expected a refusal');
      expect(read.problems).toEqual([{
        stage: 'summary',
        file: product.manifest,
        line: 12,
        path: 'fill.stages.summary.config',
        message: 'must have required properties maxDepth',
      }]);
    } finally {
      await product.dispose();
    }
  });

  test('a configuration that is no mapping, and a nested fault, are named at their own field', async () => {
    for (const one of [
      {
        stages: ['    summary:', '      config: 4'],                    // `config` on line 7
        line: 7,
        path: 'fill.stages.summary.config',
        message: 'must be object',
      },
      {
        stages: ['    summary:', '      config:', '        maxDepth: 0'], // `maxDepth` on line 8
        line: 8,
        path: 'fill.stages.summary.config.maxDepth',
        message: 'must be >= 1',
      },
    ]) {
      const product = await productWith(manifest(...one.stages));
      try {
        const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
        if (read.ok) throw new Error(`expected a refusal of ${one.path}`);
        expect(read.problems).toEqual([{
          stage: 'summary',
          file: product.manifest,
          line: one.line,
          path: one.path,
          message: one.message,
        }]);
      } finally {
        await product.dispose();
      }
    }
  });

  test('a configuration the schema accepts plans cleanly, and reaches the stage', async () => {
    const product = await productWith(manifest(
      '    summary:',
      '      config:',
      '        maxDepth: 4',
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
      expect(read.graph.stages.find((stage) => stage.id === 'summary')?.config).toEqual({ maxDepth: 4 });
    } finally {
      await product.dispose();
    }
  });
});

describe('a stage\'s own configuration is judged wherever its value came from', () => {
  const strict = (id: string): FillStage => fakeStage(id, {
    configSchema: Type.Object({ maxDepth: Type.Integer({ minimum: 1 }) }),
  });

  test('a stage whose declared default its own schema refuses is refused, entry or no entry', () => {
    // The same missing setting two ways: no entry at all, and an entry that
    // configures everything but `config`. A stage planned without a
    // configuration its schema refuses would fail inside `execute`, far from
    // the manifest its author edited, so both refuse the graph, each naming
    // where the value it will run with came from.
    for (const configuration of [undefined, configured({ tuned: { concurrency: 2 } })]) {
      const read = deriveStageGraph(new StageRegistry().register(strict('tuned')), configuration);
      if (read.ok) throw new Error('expected a refusal');
      expect(read.problems).toEqual([{
        stage: 'tuned',
        path: 'defaults.config',
        message: 'must have required properties maxDepth; the product\'s fill.stages.tuned.config replaces the stage\'s default',
      }]);
      expect(read.starvation).toEqual([]);
      expect(read.cycles).toEqual([]);
    }
  });

  test('a stage\'s declared default configuration stands where the product writes none', () => {
    const tuned = fakeStage('tuned', {
      configSchema: Type.Object({ maxDepth: Type.Integer({ minimum: 1 }) }),
      defaults: { ...DEFAULT_STAGE_DEFAULTS, config: { maxDepth: 2 } },
    });
    const read = deriveStageGraph(new StageRegistry().register(tuned));
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.stages).toEqual([{
      id: 'tuned',
      version: 1,
      enabled: true,
      concurrency: 1,
      limits: DEFAULT_STAGE_LIMITS,
      config: { maxDepth: 2 },
    }]);
  });

  test('a configuration written and left empty is judged as written, not replaced by the default', async () => {
    // `config:` with nothing after it is YAML's null. The stage's default
    // satisfies the schema, so a reader that fell back to it would plan the
    // stage with a setting its author did not write; the schema refuses null
    // at the field's own line instead.
    const product = await productWith(manifest(
      '    summary:',
      '      config:',                              // line 7
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (read.ok) throw new Error('expected a refusal');
      expect(read.problems).toEqual([{
        stage: 'summary',
        file: product.manifest,
        line: 7,
        path: 'fill.stages.summary.config',
        message: 'must be object',
      }]);
    } finally {
      await product.dispose();
    }
  });
});

describe('a stage\'s declared settings are judged as its own module\'s', () => {
  test('an enabled, a concurrency or a limit a stage declares for itself is refused by the rule the product\'s own is', () => {
    // The product's entry is judged with these rules; a stage's own declaration is
    // the value a run plans with wherever the product says nothing, so the same
    // rules judge it, and the fault names the stage and the declared field: no
    // product's manifest can be blamed for a default the stage brought itself.
    const broken = fakeStage('tuned', {
      defaults: {
        ...DEFAULT_STAGE_DEFAULTS,
        enabled: 'yes' as unknown as boolean,
        concurrency: 0,
        limits: { maxTurns: -1, maxParagraphs: 3 } as unknown as typeof DEFAULT_STAGE_DEFAULTS.limits,
      },
    });
    const read = deriveStageGraph(new StageRegistry().register(broken));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.problems).toEqual([
      { stage: 'tuned', path: 'defaults.enabled', message: 'the stage "tuned" declares defaults.enabled as "yes": it is true or false' },
      { stage: 'tuned', path: 'defaults.concurrency', message: 'the stage "tuned" declares defaults.concurrency as 0: it is a whole number of 1 or more' },
      { stage: 'tuned', path: 'defaults.limits.maxParagraphs', message: 'the stage "tuned" declares defaults.limits.maxParagraphs as 3: it is a limit this madarch knows, since the stage is the code that would read it' },
      { stage: 'tuned', path: 'defaults.limits.maxTurns', message: 'the stage "tuned" declares defaults.limits.maxTurns as -1: it is a whole number of 0 or more' },
    ]);
  });

  test('a stage that declares its own sensible settings is judged clean', () => {
    const tuned = fakeStage('tuned', {
      defaults: { ...DEFAULT_STAGE_DEFAULTS, enabled: false, concurrency: 3, limits: { ...DEFAULT_STAGE_LIMITS, maxTurns: 12, wrapAtFraction: 0.5 } },
    });
    const read = deriveStageGraph(new StageRegistry().register(tuned));
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.stages[0]?.concurrency).toBe(3);
  });
});

describe('a stage declares its own default configuration, and the digest holds it as resolved', () => {
  test('a stage that declares no default is refused, even where its schema accepts anything', () => {
    const loose = fakeStage('loose', {
      configSchema: Type.Any(),
      defaults: { ...DEFAULT_STAGE_DEFAULTS, config: undefined },
    });
    const read = deriveStageGraph(new StageRegistry().register(loose));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.problems).toEqual([{
      stage: 'loose',
      path: 'defaults.config',
      message: 'the stage "loose" declares no default configuration: a stage declares its own, {} where it has nothing to configure',
    }]);
  });

  test('a written null and the stage\'s declared default are two resolved configurations, and two digests', async () => {
    const registry = (): StageRegistry => new StageRegistry().register(fakeStage('tuned', {
      configSchema: Type.Union([Type.Object({ maxDepth: Type.Integer({ minimum: 1 }) }), Type.Null()]),
      defaults: { ...DEFAULT_STAGE_DEFAULTS, config: { maxDepth: 2 } },
    }));
    const nulled = await productWith(manifest('    tuned:', '      config:'));
    try {
      const written = deriveGraph(registry(), readFillStageConfiguration(nulled.folder));
      const declared = deriveGraph(registry());
      expect(written.stages[0]?.config).toBeNull();
      expect(declared.stages[0]?.config).toEqual({ maxDepth: 2 });
      expect(snapshotStageConfigurations(written.stages)).not.toBe(snapshotStageConfigurations(declared.stages));
    } finally {
      await nulled.dispose();
    }
  });

  test('a configuration the canonical serialization cannot hold is refused, never written as null', () => {
    // A caller that hand-builds a resolved configuration is answered with the
    // refusal naming the path, not with a digest that hides the value.
    expect(() => snapshotStageConfigurations([{
      id: 'tuned',
      version: 1,
      enabled: true,
      concurrency: 1,
      limits: DEFAULT_STAGE_LIMITS,
      config: undefined,
    }])).toThrow(/a canonical JSON serialization holds only null, booleans, numbers, strings, arrays and objects, but the value at "\/0\/config" is undefined/);
  });
});

describe('planning reports what starves a stage, by its exact path', () => {
  function producerAndConsumer(): StageRegistry {
    return new StageRegistry()
      .register(fakeStage('snapshot', { produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('modules', { consumes: { required: [{ capability: 'file-facts', scope: 'repository' }], optional: [] } }));
  }

  test('a disabled required producer names consumer, capability and producer', async () => {
    const product = await productWith(manifest('    snapshot:', '      enabled: false'));
    try {
      const read = deriveStageGraph(producerAndConsumer(), readFillStageConfiguration(product.folder));
      if (read.ok) throw new Error('expected a starvation');
      expect(read.starvation).toEqual([{
        consumer: 'modules',
        capability: 'file-facts',
        producer: 'snapshot',
        reason: 'producer-disabled',
        path: 'modules → file-facts → snapshot (disabled)',
      }]);
      expect(read.cycles).toEqual([]);
      expect(read.problems).toEqual([]);
    } finally {
      await product.dispose();
    }
  });

  test('a capability no stage produces says so, and names no producer', async () => {
    const registry = new StageRegistry()
      .register(fakeStage('modules', { consumes: { required: [{ capability: 'model-facts', scope: 'product' }], optional: [] } }));
    const read = deriveStageGraph(registry);
    if (read.ok) throw new Error('expected a starvation');
    expect(read.starvation).toEqual([{
      consumer: 'modules',
      capability: 'model-facts',
      reason: 'no-producer',
      path: 'modules → model-facts → no producer',
    }]);
  });

  test('every disabled producer of one capability is named', async () => {
    const registry = new StageRegistry()
      .register(fakeStage('index', { produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('crawl', { produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }] }))
      .register(fakeStage('modules', { consumes: { required: [{ capability: 'file-facts', scope: 'repository' }], optional: [] } }));
    const read = deriveStageGraph(registry, configured({ crawl: { enabled: false }, index: { enabled: false } }));
    if (read.ok) throw new Error('expected a starvation');
    expect(read.starvation.map((starved) => starved.path)).toEqual([
      'modules → file-facts → crawl (disabled)',
      'modules → file-facts → index (disabled)',
    ]);
  });

  test('an optional consume nothing produces is no starvation', async () => {
    const registry = new StageRegistry().register(fakeStage('summary', {
      consumes: { required: [], optional: [{ capability: 'history', scope: 'repository' }] },
    }));
    expect(deriveStageGraph(registry).ok).toBe(true);
  });

  test('a stage reading the capability it produces does not wait for itself', async () => {
    const registry = new StageRegistry()
      .register(fakeStage('history', {
        consumes: { required: [{ capability: 'history-facts', scope: 'repository' }], optional: [] },
        produces: [{ kind: 'history-facts', schemaVersion: 1, scope: 'repository' }],
      }))
      .register(fakeStage('evolution', { consumes: { required: [{ capability: 'history-facts', scope: 'repository' }], optional: [] } }));
    const read = deriveStageGraph(registry);
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.edges).toEqual([{ from: 'history', to: 'evolution', via: 'history-facts' }]);
  });

  test('a stage reading the capability it produces is not starved by another disabled producer', async () => {
    const registry = new StageRegistry()
      .register(fakeStage('history', {
        consumes: { required: [{ capability: 'history-facts', scope: 'repository' }], optional: [] },
        produces: [{ kind: 'history-facts', schemaVersion: 1, scope: 'repository' }],
      }))
      .register(fakeStage('crawl', {
        consumes: { required: [{ capability: 'history-facts', scope: 'repository' }], optional: [] },
        produces: [{ kind: 'history-facts', schemaVersion: 1, scope: 'repository' }],
      }));
    const read = deriveStageGraph(registry, configured({ crawl: { enabled: false } }));
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.order).toEqual(['history']);
  });
});

describe('a cycle of the stage graph is refused, naming it', () => {
  test('two stages needing each other\'s capability name the cycle as a path', () => {
    const registry = new StageRegistry()
      .register(fakeStage('refine', {
        consumes: { required: [{ capability: 'module-facts', scope: 'repository' }], optional: [] },
        produces: [{ kind: 'refined-facts', schemaVersion: 1, scope: 'repository' }],
      }))
      .register(fakeStage('cluster', {
        consumes: { required: [{ capability: 'refined-facts', scope: 'repository' }], optional: [] },
        produces: [{ kind: 'module-facts', schemaVersion: 1, scope: 'repository' }],
      }));
    const read = deriveStageGraph(registry);
    if (read.ok) throw new Error('expected a cycle');
    expect(read.cycles).toEqual([['cluster', 'refine', 'cluster']]);
    expect(read.starvation).toEqual([]);
  });

  test('an `after` that closes a cycle is refused the same way', () => {
    const registry = new StageRegistry()
      .register(fakeStage('pages', { after: ['overview'] }))
      .register(fakeStage('overview', { after: ['pages'] }));
    const read = deriveStageGraph(registry);
    if (read.ok) throw new Error('expected a cycle');
    expect(read.cycles).toEqual([['overview', 'pages', 'overview']]);
  });

  test('a stage that orders itself after itself is a refused declaration', () => {
    const registry = new StageRegistry().register(fakeStage('pages', { after: ['pages'] }));
    const read = deriveStageGraph(registry);
    if (read.ok) throw new Error('expected a refusal');
    expect(read.problems).toEqual([{
      stage: 'pages',
      path: 'after[0]',
      message: 'the stage "pages" orders itself after "pages": a stage cannot run after itself',
    }]);
    expect(read.cycles).toEqual([]);
  });

  test('an `after` naming a stage the registry does not hold is refused, not dropped', () => {
    const registry = new StageRegistry().register(fakeStage('pages', { after: ['overveiw'] }));
    const read = deriveStageGraph(registry);
    if (read.ok) throw new Error('expected a refusal');
    expect(read.problems).toEqual([{
      stage: 'pages',
      path: 'after[0]',
      message: 'the stage "pages" orders itself after "overveiw", which the registry does not hold: register that stage or name one it has',
    }]);
  });

  test('a refusal carries every fault at once: a cycle, a starved consumer, a declaration fault and a config fault', async () => {
    // The four classes come from one derivation: the cycle is derived from the
    // edges, the starvation from the required capability, and the two faults
    // from what the stages and the product wrote. A derivation that answered
    // the first fault it met would drop the rest.
    const registry = new StageRegistry()
      .register(fakeStage('a', {
        consumes: { required: [{ capability: 'b-facts', scope: 'product' }], optional: [] },
        produces: [{ kind: 'a-facts', schemaVersion: 1, scope: 'product' }],
      }))
      .register(fakeStage('b', {
        consumes: { required: [{ capability: 'a-facts', scope: 'product' }], optional: [] },
        produces: [{ kind: 'b-facts', schemaVersion: 1, scope: 'product' }],
      }))
      .register(fakeStage('hungry', { consumes: { required: [{ capability: 'ghost-facts', scope: 'product' }], optional: [] } }))
      .register(fakeStage('tuned', {
        after: ['nowhere'],
        configSchema: Type.Object({ maxDepth: Type.Integer({ minimum: 1 }) }),
        defaults: { ...DEFAULT_STAGE_DEFAULTS, config: { maxDepth: 2 } },
      }));
    const product = await productWith(manifest('    tuned:', '      concurrency: 0'));  // line 7
    try {
      const read = deriveStageGraph(registry, readFillStageConfiguration(product.folder));
      if (read.ok) throw new Error('expected a refusal');
      expect(read.cycles).toEqual([['a', 'b', 'a']]);
      expect(read.starvation.map((starved) => starved.path)).toEqual(['hungry → ghost-facts → no producer']);
      expect(read.problems).toEqual([
        {
          stage: 'tuned',
          path: 'after[0]',
          message: 'the stage "tuned" orders itself after "nowhere", which the registry does not hold: register that stage or name one it has',
        },
        {
          stage: 'tuned',
          file: product.manifest,
          line: 7,
          path: 'fill.stages.tuned.concurrency',
          message: 'fill.stages.tuned.concurrency is a whole number of 1 or more, not 0',
        },
      ]);
      expect(read.config).toEqual([]);
    } finally {
      await product.dispose();
    }
  });

  test('a disabled stage breaks the cycle instead of closing it', () => {
    const registry = new StageRegistry()
      .register(fakeStage('a', {
        consumes: { required: [{ capability: 'b-facts', scope: 'product' }], optional: [] },
        produces: [{ kind: 'a-facts', schemaVersion: 1, scope: 'product' }],
      }))
      .register(fakeStage('b', {
        consumes: { required: [{ capability: 'a-facts', scope: 'product' }], optional: [] },
        produces: [{ kind: 'b-facts', schemaVersion: 1, scope: 'product' }],
      }));
    const read = deriveStageGraph(registry, configured({ b: { enabled: false } }));
    if (read.ok) throw new Error('expected a starvation');
    expect(read.cycles).toEqual([]);
    expect(read.starvation.map((starved) => starved.path)).toEqual(['a → b-facts → b (disabled)']);
  });
});

describe('the stages a run registers, together', () => {
  // The registry a wired run holds: the eight deterministic stages and every agent stage of 0026 this
  // build lands. A fake source is enough — derivation reads declarations and runs nothing.
  const snapshots = {
    pins: async () => [],
    open: async () => { throw new Error('derivation reads no repository'); },
  };
  const registry = createStageRegistry({ snapshots, agent: { agent: { id: 'fake-agent', command: 'fake-agent' } } });

  test('read together with no cycle, stage 8 before stage 10 and by no edge of stage 10 back', () => {
    // madarch-tzte.26.1, run of 2026-10-20: the overview declared an optional consume of `claim`, which
    // stage 10 also produces, and stage 10 reads the overview's claims — the pair was a cycle
    // (doc-intent → overview → doc-intent) and every run of the product was refused.
    const read = deriveStageGraph(registry);
    if (!read.ok) throw new Error(`the declared stages do not read together: ${read.cycles.map((cycle) => cycle.join(' → ')).join('; ')}`);
    const order = read.graph.order;
    expect(order).toContain('overview');
    expect(order).toContain('doc-intent');
    // 0026: a later pass relies on the results of earlier ones — stage 10 reads the overview's claims.
    expect(order.indexOf('doc-intent')).toBeGreaterThan(order.indexOf('overview'));
    expect(read.graph.edges.some((edge) => edge.from === 'overview' && edge.to === 'doc-intent')).toBe(true);
    expect(read.graph.edges.some((edge) => edge.from === 'doc-intent' && edge.to === 'overview')).toBe(false);
  });

  test('the overview declares no consume of a kind an agent stage writes: the unit reads the intent so far through its own tool', () => {
    // The packet never reads a kind an agent unit writes (0026, "Agent input"), and the overview's own
    // words say the intent the graph holds is left to the unit's `claims_about` tool. A declared consume
    // of `claim` was the half of the cycle above that stage 8 brought to the pair.
    const declared = overviewDeclaration().consumes.optional.map((consume) => consume.capability);
    expect(declared).not.toContain('claim');
  });
});

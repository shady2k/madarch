import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { readFillStageConfiguration } from '../src/fill/config.js';
import { deriveStageGraph, resolveStageConfiguration, snapshotStageConfigurations, StageRegistry } from '../src/fill/registry.js';
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
async function productWith(lines: readonly string[]): Promise<{ folder: string; dispose: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), 'madarch-fill-registry-'));
  await writeFile(join(folder, MANIFEST_FILE), lines.join('\n') + '\n');
  return { folder, dispose: () => rm(folder, { recursive: true, force: true }) };
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
    expect(DEFAULT_STAGE_DEFAULTS).toEqual({ enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS });
  });

  test('a stage is registered once, and a second registration of one id is refused', () => {
    const registry = new StageRegistry().register(summaryStage);
    expect(registry.get('summary')?.version).toBe(3);
    expect(registry.get('absent')).toBeUndefined();
    expect(() => registry.register(fakeStage('summary', { version: 4 })))
      .toThrow('the stage "summary" is registered twice (versions 3 and 4): each stage is registered once');
  });

  test('the registry lists its stages in code point order whatever the registration order', () => {
    const registry = new StageRegistry()
      .register(fakeStage('summary'))
      .register(fakeStage('Claims'))
      .register(fakeStage('claims'))
      .register(fakeStage('_draft'));
    expect(registry.all().map((stage) => stage.id)).toEqual(['Claims', '_draft', 'claims', 'summary']);
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
      config: undefined,
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

  test('a producer found nothing is the plan\'s own word, not a starvation', () => {
    // Decision 0027 separates "no producer" from "producer found nothing":
    // the second is a plan with its coverage said, and the graph is clean.
    const registry = new StageRegistry()
      .register(fakeStage('snapshot', {
        produces: [{ kind: 'file-facts', schemaVersion: 1, scope: 'repository' }],
        plan: () => ({ units: [], coverage: 'nothing-found' }),
      }))
      .register(fakeStage('modules', { consumes: { required: [{ capability: 'file-facts', scope: 'repository' }], optional: [] } }));
    expect(deriveStageGraph(registry).ok).toBe(true);
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
      expect(readFillStageConfiguration(product.folder)).toEqual({
        ok: true,
        stages: {
          snapshot: { enabled: false },
          modules: { concurrency: 4, limits: { maxTurns: 12, wrapAtFraction: 0.6, contextTokens: 131_072 } },
          summary: { config: { maxDepth: 2 } },
        },
        lines: { snapshot: 6, modules: 8, summary: 14 },
      });
    } finally {
      await product.dispose();
    }
  });

  test('a product folder holding no manifest configures no stage: every default holds', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'madarch-fill-registry-'));
    try {
      expect(readFillStageConfiguration(folder)).toEqual({ ok: true, stages: {}, lines: {} });
      const read = deriveStageGraph(chainRegistry());
      if (!read.ok) throw new Error('expected a clean graph');
      expect(read.graph.stages.every((stage) => stage.enabled && stage.concurrency === 1
        || stage.id === 'summary' && stage.concurrency === 2)).toBe(true);
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
      expect(read.graph.stages.find((stage) => stage.id === 'overview'))
        .toMatchObject({ enabled: false });
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
      expect(read.graph.stages.find((stage) => stage.id === 'modules')?.limits).toEqual({
        contextTokens: 272_000,
        wrapAtFraction: 0.7,
        stopAtFraction: 0.75,
        maxTurns: 12,
        maxDurationMs: 600_000,
        maxOutputTokens: 16_000,
      });
      expect(read.graph.stages.find((stage) => stage.id === 'modules')?.concurrency).toBe(4);
    } finally {
      await product.dispose();
    }
  });

  test('a stage the registry does not hold is configured and left out of the graph', async () => {
    // The manifest's own rule for a field this madarch does not know: a
    // product's configuration grows by fields a later madarch reads.
    const product = await productWith(manifest(
      '    invented:',
      '      enabled: false',
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
      expect(read.graph.stages.map((stage) => stage.id)).not.toContain('invented');
    } finally {
      await product.dispose();
    }
  });

  test('the run\'s snapshot digest follows the configuration it resolved', async () => {
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
      expect(snapshotStageConfigurations(plain.graph.stages)).toBe(left);
      expect(snapshotStageConfigurations(changed.graph.stages)).not.toBe(left);
    } finally {
      await limited.dispose();
    }
  });

  test('one stage\'s resolved configuration without a product is its own defaults', () => {
    expect(resolveStageConfiguration(summaryStage)).toEqual({
      id: 'summary',
      version: 3,
      enabled: true,
      concurrency: 2,
      limits: DEFAULT_STAGE_LIMITS,
      config: undefined,
    });
  });
});

describe('the product configuration\'s own refusals', () => {
  test('each refusal names the file, the line and the field\'s path', async () => {
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
      {
        stages: ['    bad id:', '      enabled: true'],               // the id on line 6
        line: 6,
        path: 'fill.stages.bad id',
        message: '"bad id" is not a stage id: a stage id is a word the registry registers',
      },
    ];
    for (const refuse of cases) {
      const product = await productWith(manifest(...refuse.stages));
      try {
        expect(readFillStageConfiguration(product.folder)).toEqual({
          ok: false,
          errors: [{ file: MANIFEST_FILE, line: refuse.line, path: refuse.path, message: refuse.message }],
        });
      } finally {
        await product.dispose();
      }
    }
  });

  test('a fill section that is no mapping refuses the whole configuration', async () => {
    const product = await productWith(['schemaVersion: 1', 'id: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f', 'name: stage-registry-fixture', 'fill: everywhere']);
    try {
      expect(readFillStageConfiguration(product.folder)).toEqual({
        ok: false,
        errors: [{ file: MANIFEST_FILE, line: 4, path: 'fill', message: 'fill is a mapping of the fill\'s own keys, not "everywhere"' }],
      });
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
      expect(read.errors[0]?.file).toBe(MANIFEST_FILE);
      expect(read.errors[0]?.line).toBeGreaterThan(1);
      expect(read.errors[0]?.message.length).toBeGreaterThan(0);
    } finally {
      await product.dispose();
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
        file: MANIFEST_FILE,
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

  test('a limit or a field this madarch does not know is read past, never refused', async () => {
    const product = await productWith(manifest(
      '    modules:',
      '      concurrency: 2',
      '      limits:',
      '        maxParagraphs: 3',
      '      retention: 7',
    ));
    try {
      expect(readFillStageConfiguration(product.folder)).toEqual({
        ok: true,
        stages: { modules: { concurrency: 2, limits: {} } },
        lines: { modules: 6 },
      });
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
        file: MANIFEST_FILE,
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
    const product = await productWith(manifest(
      '    summary:',
      '      config:',
      '        depth: 2',                             // line 8, the only field
    ));
    try {
      const read = deriveStageGraph(chainRegistry(), readFillStageConfiguration(product.folder));
      if (read.ok) throw new Error('expected a refusal');
      expect(read.problems).toEqual([{
        stage: 'summary',
        file: MANIFEST_FILE,
        line: 6,
        path: 'fill.stages.summary.config',
        message: 'must have required properties maxDepth',
      }]);
    } finally {
      await product.dispose();
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
    const configuration = { ok: true as const, stages: { index: { enabled: false }, crawl: { enabled: false } }, lines: { index: 1, crawl: 1 } };
    const read = deriveStageGraph(registry, configuration);
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
    const configuration = { ok: true as const, stages: { b: { enabled: false } }, lines: { b: 1 } };
    const read = deriveStageGraph(registry, configuration);
    if (read.ok) throw new Error('expected a starvation');
    expect(read.cycles).toEqual([]);
    expect(read.starvation.map((starved) => starved.path)).toEqual(['a → b-facts → b (disabled)']);
  });
});

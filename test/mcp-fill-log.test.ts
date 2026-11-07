/**
 * A fill that says what it is doing (madarch-8bdc.2.5): every durable fill event
 * is written beside the store as it happens, and the same snapshot says how many
 * units were planned, published, failed and blocked per stage, and what the last
 * pass cost. The fixture is a product the test makes itself.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { FillLog } from '../src/mcp/fill-log.js';
import { createStagesFill } from '../src/product/fill-stages.js';
import { writeProduct } from './fixtures/code-stages/repository.js';

describe('the fill log beside the store', () => {
  test('writes one line per durable event and answers the per-stage state and the last pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-fill-log-'));
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
    try {
      const { product } = writeProduct(root);
      const fill = await createStagesFill({ product, database: owner });
      const file = join(root, 'fill.log');
      const lines: string[] = [];
      const log = new FillLog(file, (line) => lines.push(line));
      const service = createFillOrchestratorService({
        home: join(root, 'products'), owner, registry: fill.registry, wiring: () => fill.wiring,
        maxPasses: 100_000, sink: (event) => log.sink(event),
      });
      try {
        const result = await service.run({ product: fill.product, runId: 'run-fill-log' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state).toBe('succeeded');

        expect(existsSync(file)).toBe(true);
        const written = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
        expect(written.length).toBeGreaterThan(0);
        for (const line of written) {
          const held = JSON.parse(line) as Record<string, unknown>;
          expect(typeof held['at']).toBe('string');
          expect(typeof held['kind']).toBe('string');
          expect(typeof held['summary']).toBe('string');
        }
        // The pass timing is one of those lines, with the run's own size and every part's wall time.
        const timing = written.map((line) => JSON.parse(line) as Record<string, unknown>).filter((held) => held['kind'] === 'pass-timing');
        expect(timing.length).toBeGreaterThan(0);
        expect(typeof timing[0]!['summary']).toBe('string');
        const parsed = JSON.parse(String(timing[0]!['summary'])) as Record<string, unknown>;
        expect(typeof parsed['pass']).toBe('number');
        expect(typeof parsed['units']).toBe('number');
        expect(typeof parsed['phases']).toBe('object');

        const snapshot = log.snapshot();
        expect(snapshot.published).toBeGreaterThan(0);
        expect(snapshot.pass).not.toBeNull();
        expect(Object.keys(snapshot.stages).length).toBeGreaterThan(0);
        expect(log.line()).toContain('planned');
        expect(log.line()).toContain('published');
        expect(lines.length).toBeGreaterThan(0);
      } finally {
        await service.stop();
      }
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);
});

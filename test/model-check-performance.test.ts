import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { assigned, checkModel, Repo } from './model-check-repo.js';

/**
 * Performance requirement (docs/changes/agent-model/capabilities/
 * model-check.md, "Quality requirements"): checking a repository of
 * 3 000 tracked files and a model of 200 elements, history included,
 * takes under one minute on a developer's laptop. Skipped when
 * `MADARCH_SKIP_PERF` is set; under CI the measured time is logged rather
 * than asserted, the same as `test/views-performance.test.ts`.
 */

/**
 * A repository of 3 000 tracked files (fifteen per element) with ten
 * commits of history, and a model of 200 elements with one evidence item
 * each and 300 relations, whose review's assignment table covers every
 * file. Every evidence item resolves at the checked revision, so the
 * check has nothing to refuse and the run measures the reading, not the
 * refusing.
 */
function perfRepo(): Repo {
  const repo = new Repo();
  for (let e = 0; e < 200; e++) {
    for (let f = 0; f < 15; f++) repo.write(`src/comp${e}/file${f}.ts`, `export const value = ${e};\n`);
  }
  for (let round = 1; round <= 10; round++) {
    for (let k = 0; k < 10; k++) {
      const e = (round * 10 + k) % 200;
      repo.write(`src/comp${e}/file0.ts`, `export const value = ${e}; // round ${round}\n`);
    }
    repo.commit(`round ${round}`);
  }
  const base = repo.run(['rev-parse', 'HEAD']).stdout.trim();
  const blob = (e: number): string => repo.blob(`src/comp${e}/file0.ts`, base);
  const evidence = (e: number): string[] => ['    evidence:', `      - file: src/comp${e}/file0.ts`, `        commit: ${base}`, `        blob: ${blob(e)}`];
  const parts = ['version: 1', '', 'elements:'];
  for (let e = 0; e < 200; e++) {
    parts.push(`  - id: comp${e}`, '    kind: service', `    name: Component ${e}`, ...evidence(e));
  }
  parts.push('', 'relations:');
  for (let e = 0; e < 200; e++) {
    parts.push(`  - id: r${e}`, `    name: calls on`, `    from: comp${e}`, `    to: comp${(e + 1) % 200}`, ...evidence(e));
  }
  for (let e = 0; e < 100; e++) {
    parts.push(`  - id: rx${e}`, `    name: also calls`, `    from: comp${e}`, `    to: comp${(e + 150) % 200}`, ...evidence(e));
  }
  parts.push('');
  repo.writeModel('model.yaml', parts.join('\n'));
  repo.writeReview(
    [],
    assigned(Array.from({ length: 200 }, (_, e) => [`src/comp${e}/`, `comp${e}`, ''])),
  );
  repo.commit('the model');
  return repo;
}

describe('performance: checking a 3 000-file repository with a 200-element model', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'finishes in under one minute, history included',
    () => {
      const repo = perfRepo();
      try {
        const started = performance.now();
        const report = checkModel(repo.path);
        const elapsed = performance.now() - started;

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);

        if (process.env['CI']) {
          // eslint-disable-next-line no-console
          console.log(`model check of 3 000 files and 200 elements: ${Math.round(elapsed)}ms`);
        } else {
          expect(elapsed).toBeLessThan(60_000);
        }
      } finally {
        rmSync(repo.path, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

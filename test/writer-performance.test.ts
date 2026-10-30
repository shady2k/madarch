/**
 * The writer's page check reads a page's structure in proportion to its size
 * (madarch-ztyq.12): a page with 2,000 statements, code spans and footnote
 * grounds is read in linear time, not by a page-wide scan per paragraph or
 * reference. Skipped when `MADARCH_SKIP_PERF` is set; under CI the measured
 * times are logged rather than asserted, like `test/views-performance.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { checkPage, type GroundResolver, type PageExpectation } from '../src/writer/format.js';

const header = '---\nid: domain:perf\nkind: domain\ntitle: Performance\nrelates: []\nproducer: agent\nsources: []\n---\n\n';
const expected: PageExpectation = { id: 'domain:perf', kind: 'domain', domains: ['perf'], mustLinkDomains: false, language: 'en' };

const resolver: GroundResolver = {
  graphKey: async (key) => key.startsWith('code.symbol:src/a.ts#s'),
  docSection: async () => false,
  sourceName: async () => false,
  uniqueRoute: async () => undefined,
  uniqueSymbol: async () => undefined,
  keyPrefixes: async () => ['code.symbol:'],
};

/** A page with `n` statements, each a code span and a ground on the same paragraph and its definition. */
function page(n: number): string {
  let body = '';
  for (let i = 0; i < n; i += 1) body += `Fact ${i} stands at \`code${i}\`.[^g${i}]\n\n`;
  for (let i = 0; i < n; i += 1) body += `[^g${i}]: [Source ${i}](madarch:code.symbol:src/a.ts#s${i})\n`;
  return header + body;
}

async function time(n: number): Promise<number> {
  const markdown = page(n);
  const checked = await checkPage(markdown, expected, resolver);
  expect(checked.ok).toBe(true);
  const times: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    const again = await checkPage(markdown, expected, resolver);
    times.push(performance.now() - started);
    expect(again.ok).toBe(true);
  }
  times.sort((left, right) => left - right);
  return times[1]!;
}

describe('performance: checking a page of statements', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'a 2,000-statement page is checked in linear time',
    async () => {
      const small = await time(1_000);
      const large = await time(2_000);
      if (process.env['CI']) {
        // eslint-disable-next-line no-console
        console.log(`writer check: 1,000 statements ${Math.round(small)}ms, 2,000 statements ${Math.round(large)}ms`);
      } else {
        // Doubling the page should double the work; four times the work would mean a scan per paragraph or reference.
        expect(large).toBeLessThan(3 * small);
        expect(large).toBeLessThan(5_000);
      }
    },
    30_000,
  );
});

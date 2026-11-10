import { expect, test } from 'bun:test';
import { withHistoryLinks } from '../src/knowledge/temporal.js';

test('API links retain selected repository and date without changing external links or product prose', () => {
  const values = { links: [{ href: '/k/e/code.symbol%3Asrc%2Fpart.ts%23Part' }, { href: '/k/src?repo=sample&path=src%2Fpart.ts&line=3' }, { href: '/k/e/domain%3Asales' }, { href: 'https://example.test/source' }] };
  const linked = withHistoryLinks(values, { repo: 'sample', at: 'first-release' });
  expect(linked.links[0]!.href).toContain('at=first-release');
  expect(linked.links[1]!.href).toContain('path=src%2Fpart.ts&line=3&at=first-release');
  expect(linked.links[2]).toEqual(values.links[2]);
  expect(linked.links[3]).toEqual(values.links[3]);
  expect(values.links[0]!.href).not.toContain('at=');
});

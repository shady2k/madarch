import { describe, expect, test } from 'bun:test';
import { recommendNextStep } from '../src/product-wiki/recommendations.js';

const kinds = [
  { name: 'Product vision', folder: 'docs/vision.md', hint: 'Explain the purpose' },
  { name: 'Product requirement', folder: 'docs/requirements', hint: 'Write a requirement' },
];
const base = { kinds, pages: [{ path: 'docs/vision.md', title: 'Vision', kind: 'Product vision', id: 'VISION', markdown: '# Vision' }], questions: [] as Array<{ id: string; path: string; title: string; prompt: string; dependsOn: string[]; rank: number; state: string }> };

describe('registry-driven next-step recommendations', () => {
  test('answers the highest-ranked open question that blocks this page before other rules', () => {
    const result = recommendNextStep({ ...base, questions: [
      { id: 'Q-002', path: 'docs/questions/Q-002.md', title: 'Lower rank', prompt: 'Resolve lower', dependsOn: ['VISION'], rank: 1, state: 'open' },
      { id: 'Q-001', path: 'docs/questions/Q-001.md', title: 'Higher rank', prompt: 'Resolve first', dependsOn: ['VISION'], rank: 3, state: 'open' },
    ], pagePath: 'docs/vision.md' });
    expect(result).toEqual({ action: 'Answer: Higher rank', reason: 'Resolve first', target: 'docs/questions/Q-001.md', rule: 'answer-question', questionTitle: 'Higher rank' });
  });
  test('reviews unverified claims before missing registry entries', () => {
    const result = recommendNextStep({ ...base, pages: [{ ...base.pages[0]!, markdown: '# Vision\n\n**Unverified**' }], pagePath: 'docs/vision.md' });
    expect(result.rule).toBe('review-assumption');
    expect(result.target).toBe('docs/vision.md');
  });
  test('fills the first missing kind in the order the registry declares, not alphabetical', () => {
    const result = recommendNextStep({ ...base, pagePath: 'docs/vision.md' });
    expect(result).toEqual({ action: 'Add Product requirement', reason: 'The registry requires a page of Product requirement, but none is present.', target: 'docs/requirements', rule: 'fill-required', kindName: 'Product requirement' });
    const zFirst = recommendNextStep({ ...base, kinds: [{ name: 'Zeta note', folder: 'docs/zeta', hint: 'write a zeta' }, { name: 'Alpha note', folder: 'docs/alpha', hint: 'write an alpha' }] });
    expect(zFirst).toEqual({ action: 'Add Zeta note', reason: 'The registry requires a page of Zeta note, but none is present.', target: 'docs/zeta', rule: 'fill-required', kindName: 'Zeta note' });
  });
  test('fills the first code-point-ordered page with a missing required link before the registry hint', () => {
    const result = recommendNextStep({ ...base, kinds: [kinds[0]!], pages: [{ ...base.pages[0]!, structural: [{ rule: 'structural.required-link', what: 'a Product vision carries its References link: the wiki found none' }] }], pagePath: 'docs/vision.md' });
    expect(result).toEqual({ action: 'Fill a required link', reason: 'a Product vision carries its References link: the wiki found none', target: 'docs/vision.md', rule: 'fill-required' });
  });
  test('an Unverified badge quoted inside a fenced code block is not the page\'s own claim', () => {
    const result = recommendNextStep({ ...base, kinds: [kinds[0]!], pages: [{ ...base.pages[0]!, markdown: '# Vision\n\n```md\n**Unverified**\n```\n' }], pagePath: 'docs/vision.md' });
    expect(result.rule).toBe('registry-hint');
  });
  test('the review-assumption reason names the page when the ask is the home', () => {
    const result = recommendNextStep({ ...base, pages: [{ path: 'docs/notes/n1.md', title: 'N-001', markdown: 'text **Unverified** here' }] });
    expect(result).toEqual({ action: 'Review unverified assumption', reason: 'The page N-001 contains a claim marked Unverified.', target: 'docs/notes/n1.md', rule: 'review-assumption' });
    const onPage = recommendNextStep({ ...base, pages: [{ ...base.pages[0]!, markdown: '# Vision\n\n**Unverified**' }], pagePath: 'docs/vision.md' });
    expect(onPage.reason).toBe('This page contains a claim marked Unverified.');
  });
  test('a page outside the declared folder does not satisfy a registry kind', () => {
    const result = recommendNextStep({ ...base, pages: [...base.pages, { path: 'drafts/REQ-001.md', title: 'Requirement', kind: 'Product requirement' }] });
    expect(result.rule).toBe('fill-required');
    expect(result.target).toBe('docs/requirements');
  });
  test('uses the current kind registry hint after higher-priority rules are clear', () => {
    const result = recommendNextStep({ ...base, kinds: [kinds[0]!], pagePath: 'docs/vision.md' });
    expect(result).toEqual({ action: 'Explain the purpose', reason: 'Explain the purpose', target: 'docs/vision.md', rule: 'registry-hint', kindName: 'Product vision' });
  });
  test('falls back to generic inspect and update when no registry or pages exist', () => {
    expect(recommendNextStep({ kinds: [], pages: [], questions: [] })).toEqual({ action: 'Review this page and its sources', reason: 'Check whether this page still reflects the product.', target: '/', rule: 'inspect-update' });
  });
});

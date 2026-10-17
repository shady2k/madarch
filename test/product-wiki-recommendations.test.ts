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
    expect(result).toEqual({ action: 'Answer: Higher rank', reason: 'Resolve first', target: 'docs/questions/Q-001.md', rule: 'answer-question' });
  });
  test('reviews unverified claims before missing registry entries', () => {
    const result = recommendNextStep({ ...base, pages: [{ ...base.pages[0]!, markdown: '# Vision\n\n**Unverified**' }], pagePath: 'docs/vision.md' });
    expect(result.rule).toBe('review-assumption');
    expect(result.target).toBe('docs/vision.md');
  });
  test('fills the first code-point-ordered missing kind declared by the registry', () => {
    const result = recommendNextStep({ ...base, pagePath: 'docs/vision.md' });
    expect(result).toEqual({ action: 'Add Product requirement', reason: 'The registry requires a page of Product requirement, but none is present.', target: 'docs/requirements', rule: 'fill-required' });
  });
  test('a page outside the declared folder does not satisfy a registry kind', () => {
    const result = recommendNextStep({ ...base, pages: [...base.pages, { path: 'drafts/REQ-001.md', title: 'Requirement', kind: 'Product requirement' }] });
    expect(result.rule).toBe('fill-required');
    expect(result.target).toBe('docs/requirements');
  });
  test('uses the current kind registry hint after higher-priority rules are clear', () => {
    const result = recommendNextStep({ ...base, kinds: [kinds[0]!], pagePath: 'docs/vision.md' });
    expect(result).toEqual({ action: 'Explain the purpose', reason: 'Explain the purpose', target: 'docs/vision.md', rule: 'registry-hint' });
  });
  test('falls back to generic inspect and update when no registry or pages exist', () => {
    expect(recommendNextStep({ kinds: [], pages: [], questions: [] })).toEqual({ action: 'Review this page and its sources', reason: 'Check whether this page still reflects the product.', target: '/', rule: 'inspect-update' });
  });
});

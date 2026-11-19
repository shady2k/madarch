import { expect, test } from 'bun:test';
import { decodeSourceResponse } from '../src/page-contract/source-response.js';

test('source output validates its explicit language and closed transport contract', () => {
  const response = { repo: null, path: 'src/a.ts', language: 'typescript', commit: null, text: 'const a = 1;' } as const;
  expect(decodeSourceResponse(response, '/response:1')).toEqual(response);
  expect(decodeSourceResponse({ ...response, language: 'text' }, '/response:1').language).toBe('text');
  expect(() => decodeSourceResponse({ ...response, language: 'invented-language' }, '/response:1')).toThrow('/response:1: source response');
  expect(() => decodeSourceResponse({ ...response, extra: true }, '/response:1')).toThrow('/response:1: source response');
});

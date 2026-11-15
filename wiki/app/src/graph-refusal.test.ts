import { afterEach, expect, test } from 'bun:test';
import { postQuery } from './client.js';
import { CommandError, readProduct } from './components/command.js';
import { i18n, setWikiLanguage } from './i18n.js';

const originalFetch = globalThis.fetch;
const originalLanguage = i18n.resolvedLanguage ?? 'en';
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await i18n.changeLanguage(originalLanguage);
});

const refusal = { code: 'SCHEMA_INVALID', path: '/values/count', expected: 'integer', actual: 'many', retryable: false };
function answer(body: unknown, status: number): void {
  globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch;
}

for (const [language, words] of [
  ['en', 'Invalid value at /values/count: expected integer, got "many".'],
  ['ru', 'Недопустимое значение в /values/count: ожидалось integer, получено "many".'],
] as const) {
  test(`command refusal uses the reader's ${language} locale and preserves its code`, async () => {
    await setWikiLanguage(language);
    answer({ error: refusal }, 400);
    const failure = await readProduct('').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandError);
    expect((failure as CommandError).code).toBe('SCHEMA_INVALID');
    expect((failure as Error).message).toBe(words);
  });

  test(`GraphQL HTTP refusal uses the reader's ${language} locale`, async () => {
    await setWikiLanguage(language);
    answer({ error: refusal }, 400);
    const result = await postQuery('', 'query {}', {});
    expect(result.errors).toEqual([{ message: words, extensions: refusal }]);
  });

  for (const status of [200, 400]) {
    test(`GraphQL errors envelope at HTTP ${status} uses the reader's ${language} locale and preserves arguments`, async () => {
      await setWikiLanguage(language);
      answer({ data: null, errors: [{ message: 'server diagnostic', extensions: refusal }] }, status);
      const result = await postQuery('', 'query {}', {});
      expect(result.errors).toEqual([{ message: words, extensions: refusal }]);
    });
  }
}

test('uncoded command and GraphQL errors keep their messages without inferring codes', async () => {
  answer({ error: { message: 'SCHEMA_INVALID: expected integer' } }, 400);
  const failure = await readProduct('').catch((error: unknown) => error);
  expect((failure as CommandError).message).toBe('SCHEMA_INVALID: expected integer');
  expect((failure as CommandError).code).toBeUndefined();
  answer({ errors: [{ message: 'SCHEMA_INVALID: expected integer' }] }, 200);
  expect((await postQuery('', 'query {}', {})).errors).toEqual([{ message: 'SCHEMA_INVALID: expected integer' }]);
});

test('unknown and incomplete coded errors keep the existing fallback', async () => {
  for (const error of [{ ...refusal, code: 'FUTURE_CODE' }, { code: 'SCHEMA_INVALID' }]) {
    answer({ error: { ...error, message: 'server fallback' } }, 400);
    expect((await readProduct('').catch((failure: unknown) => failure) as Error).message).toBe('server fallback');
    answer({ errors: [{ message: 'server fallback', extensions: error }] }, 200);
    expect((await postQuery('', 'query {}', {})).errors[0]?.message).toBe('server fallback');
  }
});

import { expect, test } from 'bun:test';
import * as upstream from 'linguist-languages';
import languages from '../plugins/disk/languages.json';
import { readFileSync } from 'node:fs';

test('disk ships every language and field from the pinned upstream dataset', () => {
  const upstreamPackage = JSON.parse(readFileSync(new URL('../node_modules/linguist-languages/package.json', import.meta.url), 'utf8'));
  expect(upstreamPackage.version).toBe('9.5.0');
  expect(languages).toEqual(JSON.parse(JSON.stringify(upstream)));
});

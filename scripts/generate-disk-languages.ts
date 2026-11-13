#!/usr/bin/env bun
/** Regenerate the shipped full Linguist dataset from the root's pinned package. */
import * as languages from 'linguist-languages';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('node_modules/linguist-languages/package.json', root), 'utf8')) as { version: string };
if (source.version !== '9.5.0') throw new Error(`expected linguist-languages 9.5.0, got ${source.version}`);
const target = new URL('plugins/disk/languages.json', root);
const text = `${JSON.stringify(languages, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== text) throw new Error(`${fileURLToPath(target)} differs: run bun scripts/generate-disk-languages.ts`);
} else {
  writeFileSync(target, text);
}

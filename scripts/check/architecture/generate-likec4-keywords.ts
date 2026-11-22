/** Regenerate the gate's external grammar authority from the installed, pinned LikeC4 grammar bundle. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSync } from '@swc/core';
import { byCodePoint } from '../../../src/model/order.js';

export interface LikeC4Keywords {
  readonly package: 'likec4';
  readonly version: string;
  readonly authority: 'likec4/dist/chunks/node.mjs#LikeC4Grammar';
  readonly keywords: readonly string[];
}

export async function installedLikeC4Keywords(): Promise<LikeC4Keywords> {
  const metadata = JSON.parse(readFileSync(new URL(import.meta.resolve('likec4/package.json')), 'utf8')) as { version: string };
  const bundle = readFileSync(new URL('./dist/chunks/node.mjs', import.meta.resolve('likec4/package.json')), 'utf8');
  const tree = parseSync(bundle, { syntax: 'ecmascript' });
  const grammar: unknown[] = [];
  const findGrammar = (value: unknown, factory = false): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const entry of value) findGrammar(entry, factory); return; }
    const node = value as Record<string, unknown>;
    const id = node['id'] as Record<string, unknown> | undefined;
    const inside = factory || (node['type'] === 'VariableDeclarator' && id?.['value'] === 'LikeC4Grammar');
    if (inside && node['type'] === 'TemplateLiteral' && (node['expressions'] as unknown[]).length === 0) {
      const part = (node['quasis'] as Record<string, unknown>[])[0];
      const decoded = JSON.parse(String(part?.['cooked'])) as Record<string, unknown>;
      if (decoded['$type'] === 'Grammar' && decoded['name'] === 'LikeC4') grammar.push(decoded);
    }
    for (const entry of Object.values(node)) findGrammar(entry, inside);
  };
  findGrammar(tree);
  if (grammar.length !== 1) throw new Error('The installed LikeC4 bundle must declare exactly one serialized LikeC4Grammar');

  const keywords = new Set<string>();
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    const node = value as Record<string, unknown>;
    if (node['$type'] === 'Keyword' && typeof node['value'] === 'string') keywords.add(node['value']);
    for (const [key, entry] of Object.entries(node)) if (!key.startsWith('$')) walk(entry);
  };
  walk(grammar[0]);
  return { package: 'likec4', version: metadata.version, authority: 'likec4/dist/chunks/node.mjs#LikeC4Grammar', keywords: [...keywords].sort(byCodePoint) };
}

if (import.meta.main) {
  writeFileSync(new URL('./external-likec4-keywords.json', import.meta.url), JSON.stringify(await installedLikeC4Keywords(), null, 2) + '\n');
}

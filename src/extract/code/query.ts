/** Shipped structural query assets; no repository text predicates. */
import goQuery from './queries/go.scm' with { type: 'text' };
import javascriptQuery from './queries/javascript.scm' with { type: 'text' };
import typescriptQuery from './queries/typescript.scm' with { type: 'text' };
import type { SyntaxLanguage } from '../../fill/stages/syntax-extract.js';
import { createHash } from 'node:crypto';
import { byCodePoint } from '../../model/order.js';

export const CODE_QUERY_ASSETS = [
  { path: 'go.scm', source: goQuery },
  { path: 'javascript.scm', source: javascriptQuery },
  { path: 'typescript.scm', source: typescriptQuery },
] as const;

export function codeQueryDigest(assets: readonly { readonly path: string; readonly source: string }[] = CODE_QUERY_ASSETS): string {
  const seen = new Set<string>();
  const hash = createHash('sha256');
  for (const asset of [...assets].sort((left, right) => byCodePoint(left.path, right.path))) {
    if (asset.path === '' || seen.has(asset.path) || asset.source === '') throw new Error(`code query asset: invalid or duplicate ${asset.path}`);
    seen.add(asset.path);
    const bytes = new TextEncoder().encode(asset.source);
    hash.update(`${asset.path.length}:${asset.path}:${bytes.length}:`); hash.update(bytes);
  }
  return hash.digest('hex');
}

export function codeQuery(language: SyntaxLanguage): string {
  return language === 'go' ? goQuery : language === 'javascript' ? javascriptQuery : typescriptQuery;
}

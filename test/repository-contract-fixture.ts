/** Ordinary starter declarations used by graph mechanism tests; no built-in repository schema. */
import { parseDocument } from 'yaml';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf, declaredKindReads, declaredEdgeReads } from '../src/fill/stages/plugin-contract.js';

const repositoryKinds = new Set(['code.repository', 'code.directory', 'code.file', 'code.gitlink', 'code.commit', 'code.author']);

/** Keep only declarations exercised by repository tests, not the entire starter catalogue. */
function repositoryDeclarations(text: string): string {
  const document = parseDocument(text);
  const body = document.toJS();
  document.set('kinds', Object.fromEntries(Object.entries(body.kinds).filter(([name]) => repositoryKinds.has(name))));
  document.set('plugins', body.plugins.filter((plugin: { id: string }) => ['disk', 'git'].includes(plugin.id)));
  document.set('edges', body.edges.filter((edge: { capability: string }) => ['disk', 'git'].includes(edge.capability)));
  return document.toString();
}

export function restrictRepositoryDeclarations(folder: string): void {
  const file = join(folder, 'madarch', 'kinds.yaml');
  writeFileSync(file, repositoryDeclarations(readFileSync(file, 'utf8')));
}

const files = new Map(STARTER_FILES.map(file => [file.path, file]));
export const repositoryManifest = parseKinds(repositoryDeclarations(files.get('madarch/kinds.yaml')!.content), 'madarch/kinds.yaml', '/fixture', {
  has: path => files.has(path),
  text: path => files.get(path)?.content,
  size: path => files.get(path)?.bytes?.length ?? files.get(path)?.content.length ?? null,
});
export const repositoryContract = graphContractOf(repositoryManifest);
export const repositoryKindReads = declaredKindReads(repositoryManifest);
export const repositoryEdgeReads = declaredEdgeReads(repositoryManifest);

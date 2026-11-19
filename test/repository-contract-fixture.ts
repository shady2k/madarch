import { readFolderManifestText, starterManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
/** Ordinary starter declarations used by graph mechanism tests; no built-in repository schema. */
import { parseDocument } from 'yaml';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { fixtureProductFiles, withFixtureProduct } from './product-producer-fixture.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf, declaredKindReads, declaredEdgeReads } from '../src/fill/stages/plugin-contract.js';

const repositoryKinds = new Set(['product', 'product-profile', 'code.repository', 'code.directory', 'code.file', 'code.gitlink', 'code.commit', 'code.author', 'code.blob']);

/** Keep only declarations exercised by repository tests, not the entire starter catalogue. */
function repositoryDeclarations(text: string): string {
  const document = parseDocument(text);
  const body = document.toJS();
  document.set('kinds', document.createNode(Object.fromEntries(Object.entries(body.kinds).filter(([name]) => repositoryKinds.has(name)))));
  for(const [role,binding] of Object.entries(body['semantic-bindings']??{}) as [string,{kind:string}][]) if(!repositoryKinds.has(binding.kind)) document.deleteIn(['semantic-bindings',role]);
  document.set('edges', body.edges.filter((edge: { name: string; capability: string }) => edge.name === 'profile-product' || ['disk', 'git'].includes(edge.capability)));
  const edges = new Set(document.toJS().edges.map((edge: { name: string }) => edge.name));
  for (const [role, binding] of Object.entries(document.toJS()['semantic-bindings'] ?? {}) as [string, { edges?: Record<string, { kind: string }> }][]) {
    for (const [name, edge] of Object.entries(binding.edges ?? {})) {
      if (!edges.has(edge.kind)) document.deleteIn(['semantic-bindings', role, 'edges', name]);
    }
  }
  return document.toString();
}

export function restrictRepositoryDeclarations(folder: string): void {
  writeFolderManifest(folder, repositoryDeclarations(readFolderManifestText(folder)));
}

// Only the in-memory fixture installs the root producer here; disk fixtures keep their installed declarations.
const starter = parseDocument(starterManifestText());
starter.set('plugins', starter.toJS().plugins.filter((plugin: { id: string }) => ['disk', 'git'].includes(plugin.id)));
const files = new Map([...STARTER_FILES, ...fixtureProductFiles].map(file => [file.path, file]));
export const repositoryManifest = parseKinds(withFixtureProduct(repositoryDeclarations(starter.toString())), 'madarch/catalog.yaml', '/fixture', {
  has: path => files.has(path),
  text: path => files.get(path)?.content,
  size: path => files.get(path)?.bytes?.length ?? files.get(path)?.content.length ?? null,
});
export const repositoryContract = graphContractOf(repositoryManifest);
export const repositoryKindReads = declaredKindReads(repositoryManifest);
export const repositoryEdgeReads = declaredEdgeReads(repositoryManifest);

/** Ordinary starter declarations used by graph mechanism tests; no built-in repository schema. */
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf, declaredKindReads, declaredEdgeReads } from '../src/fill/stages/plugin-contract.js';

const files = new Map(STARTER_FILES.map(file => [file.path, file]));
export const repositoryManifest = parseKinds(files.get('madarch/kinds.yaml')!.content, 'madarch/kinds.yaml', '/fixture', {
  has: path => files.has(path),
  text: path => files.get(path)?.content,
  size: path => files.get(path)?.bytes?.length ?? files.get(path)?.content.length ?? null,
});
export const repositoryContract = graphContractOf(repositoryManifest);
export const repositoryKindReads = declaredKindReads(repositoryManifest);
export const repositoryEdgeReads = declaredEdgeReads(repositoryManifest);

/** The manifest producer's graph kinds: declarations, not repository content. */
import { generatedTableName, type GraphContract, type VertexContract } from './contract.js';
import { TEMPLATE_CONTRACT } from '../plugin/template-declarations.js';

export const MANIFEST_CATEGORIES = ['catalogue', 'kind', 'field', 'relation', 'workflow', 'dependency'] as const;
export const MANIFEST_CONTRACT: GraphContract = {
  vertex: [...MANIFEST_CATEGORIES.map<VertexContract>((category) => ({
    name: `manifest.${category}`, table: generatedTableName(`manifest.${category}`, 'vertex'),
    key: ['name'], capability: 'manifest',
    fields: [{ name: 'name', type: 'text' }, { name: 'declaration', type: 'json' }],
  })), ...TEMPLATE_CONTRACT.vertex], edge: [], dictionary: [],
};

/** Catalogue metadata survives a fill replacing the product's entity contract. */
export function withManifestContract(contract: GraphContract): GraphContract {
  return { ...contract, vertex: [...contract.vertex.filter((one) => !MANIFEST_CONTRACT.vertex.some((held) => held.name === one.name)), ...MANIFEST_CONTRACT.vertex] };
}

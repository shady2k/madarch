/** The manifest producer's graph kinds: declarations, not repository content. */
import { generatedTableName, type GraphContract } from './contract.js';

export const MANIFEST_CATEGORIES = ['catalogue', 'kind', 'field', 'relation', 'workflow', 'dependency'] as const;
export const MANIFEST_CONTRACT: GraphContract = {
  vertex: MANIFEST_CATEGORIES.map((category) => ({
    name: `manifest.${category}`, table: generatedTableName(`manifest.${category}`, 'vertex'),
    key: ['name'], capability: 'manifest',
    fields: [{ name: 'name', type: 'text' }, { name: 'declaration', type: 'json' }],
  })), edge: [], dictionary: [],
};

/** Catalogue metadata survives a fill replacing the product's entity contract. */
export function withManifestContract(contract: GraphContract): GraphContract {
  return { ...contract, vertex: [...contract.vertex, ...MANIFEST_CONTRACT.vertex.filter((one) => !contract.vertex.some((held) => held.name === one.name))] };
}

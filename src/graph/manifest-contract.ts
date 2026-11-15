/** The manifest producer's graph kinds: declarations, not repository content. */
import { JSON_DIALECT } from './value-types.js';
import { generatedTableName, type GraphContract, type VertexContract } from './contract.js';

export const MANIFEST_CATEGORIES = ['catalogue', 'kind', 'field', 'relation', 'workflow', 'dependency'] as const;
export const MANIFEST_DEPENDS_ON = 'manifest.depends-on';
export const MANIFEST_RELATION_EDGE = 'manifest.relation-edge';
export const MANIFEST_CONTRACT: GraphContract = {
  vertex: [...MANIFEST_CATEGORIES.map<VertexContract>((category) => ({
    name: `manifest.${category}`, table: generatedTableName(`manifest.${category}`, 'vertex'),
    key: ['name'], capability: 'manifest',
    fields: [{ name: 'name', type: 'text' }, { name: 'declaration', type: 'json', schema: { $schema: JSON_DIALECT, type: 'object' } }],
  }))], edge: [
    { name: MANIFEST_DEPENDS_ON, table: generatedTableName(MANIFEST_DEPENDS_ON, 'edge'),
      from: ['manifest.kind'], to: ['manifest.kind'], repeats: false, capability: 'manifest',
      fields: [{ name: 'declaration', type: 'json', schema: { $schema: JSON_DIALECT, type: 'object' } }] },
    { name: MANIFEST_RELATION_EDGE, table: generatedTableName(MANIFEST_RELATION_EDGE, 'edge'),
      from: ['manifest.kind'], to: ['manifest.kind'], repeats: true, discriminator: 'relation', capability: 'manifest',
      fields: [{ name: 'relation', type: 'text' }, { name: 'declaration', type: 'json', schema: { $schema: JSON_DIALECT, type: 'object' } }] },
  ], dictionary: [],
};

/** Catalogue metadata survives a fill replacing the product's entity contract. */
export function withManifestContract(contract: GraphContract): GraphContract {
  return { ...contract, vertex: [...contract.vertex.filter((one) => !MANIFEST_CONTRACT.vertex.some((held) => held.name === one.name)), ...MANIFEST_CONTRACT.vertex],
    edge: [...contract.edge.filter((one) => !MANIFEST_CONTRACT.edge.some((held) => held.name === one.name)), ...MANIFEST_CONTRACT.edge] };
}

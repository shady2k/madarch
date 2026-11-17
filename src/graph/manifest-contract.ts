/** The manifest producer's graph kinds: declarations, not repository content. */
import { inheritProtectedContract } from './system-contract.js';
import { generatedTableName, type GraphContract, type VertexContract } from './contract.js';

export const MANIFEST_CATEGORIES = ['catalogue', 'kind', 'field', 'relation', 'workflow', 'dependency'] as const;
export const MANIFEST_DEPENDS_ON = 'manifest.depends-on';
export const MANIFEST_RELATION_EDGE = 'manifest.relation-edge';
const WORKFLOW_STAGE: VertexContract = {
  name: 'manifest.workflow-stage', table: generatedTableName('manifest.workflow-stage', 'vertex'),
  key: ['name'], capability: 'manifest',
  keyEdges: [{ role: 'workflow', edge: 'manifest.workflow-stage-workflow', direction: 'from', onDelete: 'cascade' }],
  fields: [{ name: 'name', type: 'text' }, { name: 'position', type: 'integer' }, { name: 'declaration', type: 'text' }],
};
export const MANIFEST_CONTRACT: GraphContract = {
  vertex: [...MANIFEST_CATEGORIES.map<VertexContract>((category) => ({
    name: `manifest.${category}`, table: generatedTableName(`manifest.${category}`, 'vertex'),
    key: ['name'], capability: 'manifest',
    fields: [{ name: 'name', type: 'text' }, { name: 'declaration', type: 'text' },
      ...(category === 'catalogue' ? [{ name: 'publication_fingerprint', type: 'text' as const, nullable: true }] : [])],
  })), WORKFLOW_STAGE], edge: [
    { name: WORKFLOW_STAGE.keyEdges![0]!.edge, table: generatedTableName(WORKFLOW_STAGE.keyEdges![0]!.edge, 'edge'),
      from: [WORKFLOW_STAGE.name], to: ['manifest.workflow'], repeats: false, cardinality: { from: 'many', to: 'one' },
      labels: { en: { out: 'stage of', in: 'has stage' }, ru: { out: 'стадия процесса', in: 'содержит стадию' } }, capability: 'manifest', fields: [] },
    { name: MANIFEST_DEPENDS_ON, table: generatedTableName(MANIFEST_DEPENDS_ON, 'edge'),
      from: ['manifest.kind'], to: ['manifest.kind'], repeats: false, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'depends on', in: 'required by' }, ru: { out: 'зависит от', in: 'нужен для' } }, capability: 'manifest',
      fields: [{ name: 'declaration', type: 'text' }] },
    { name: MANIFEST_RELATION_EDGE, table: generatedTableName(MANIFEST_RELATION_EDGE, 'edge'),
      from: ['manifest.kind'], to: ['manifest.kind'], repeats: true, cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'relates to', in: 'related from' }, ru: { out: 'связан с', in: 'связан от' } }, discriminator: 'relation', capability: 'manifest',
      fields: [{ name: 'relation', type: 'text' }, { name: 'declaration', type: 'text' }] },
  ], dictionary: [],
};

/** Every metadata writer uses the installed declaration as its kind authority. */
export function manifestDeclaration(category: (typeof MANIFEST_CATEGORIES)[number] | 'workflow-stage'): VertexContract {
  const declaration = MANIFEST_CONTRACT.vertex.find(kind => kind.name === `manifest.${category}`);
  if (declaration === undefined) throw new Error(`${import.meta.path}:40: missing manifest declaration ${category}`);
  return declaration;
}

/** Catalogue metadata survives a fill replacing the product's entity contract. */
export function withManifestContract(contract: GraphContract): GraphContract {
  return inheritProtectedContract(contract, MANIFEST_CONTRACT);
}

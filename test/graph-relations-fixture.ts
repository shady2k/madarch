import { generatedTableName, type GraphContract } from '../src/graph/contract.js';

export const contract: GraphContract = {
  vertex: ['delta-child', 'delta-parent', 'delta-note'].map(name => ({ name,
    table: generatedTableName(name, 'vertex'), key: ['name'],
    fields: [{ name: 'name', type: 'text' }], capability: 'fixture' })),
  edge: [{ name: 'delta-parent-link', from: ['delta-child'], to: ['delta-parent'],
    fields: [{ name: 'weight', type: 'integer' }], repeats: false, capability: 'fixture',
    cardinality: { from: 'many', to: 'one' },
    labels: { en: { out: 'parent', in: 'child' }, ru: { out: 'parent', in: 'child' } } }], dictionary: [],
};
export const producer = { producer: 'fixture', producerVersion: '1' };
export const ref = (kind: string, name = '0') => ({ kind: `delta-${kind}`, key: { name } });
export const vertex = (kind: string, name = '0', interval: { validFrom?: string; validTo?: string } = {}) =>
  ({ ...ref(kind, name), ...producer, ...interval });
export const edge = (name = '0', interval: { validFrom?: string; validTo?: string } = {}, weight = 1) =>
  ({ kind: 'delta-parent-link', from: ref('child', name), to: ref('parent', name), values: { weight }, ...producer, ...interval });
export const pair = (name = '0', interval: { validFrom?: string; validTo?: string } = {}) =>
  ({ vertices: [vertex('parent', name, interval), vertex('child', name, interval)], edges: [edge(name, interval)], removals: [] });

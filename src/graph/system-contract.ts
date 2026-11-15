/** Engine-owned kinds are installed independently of product declarations. */
import { generatedTableName, type GraphContract, type VertexContract } from './contract.js';

const OPERATIONAL_KINDS = ['run', 'unit', 'event', 'agent-usage', 'operation', 'problem', 'question', 'role', 'setting', 'kind'] as const;
const IDENTITY_KINDS = ['source', 'person', 'plugin', 'agent', 'agent-session'] as const;
function identityKind(name: string): VertexContract {
  return { name, table: generatedTableName(name, 'vertex'), capability: 'system', key: [], fields: [
    { name: 'installation', type: 'text' }, { name: 'label', type: 'text', nullable: true },
    { name: 'version', type: 'text', nullable: true }, { name: 'scope', type: 'text', nullable: true },
  ] };
}
export const SYSTEM_CONTRACT: GraphContract = {
  vertex: [...OPERATIONAL_KINDS.map((name): VertexContract => ({ name, table: generatedTableName(name, 'vertex'),
    capability: 'system', key: [], fields: [{ name: 'label', type: 'text', nullable: true }] })), ...IDENTITY_KINDS.map(identityKind)],
  edge: [
    { name: 'source-principal', table: generatedTableName('source-principal', 'edge'), from: ['source', 'plugin', 'agent'], to: ['person'], repeats: false, fields: [], capability: 'system' },
    { name: 'session-agent', table: generatedTableName('session-agent', 'edge'), from: ['agent-session'], to: ['agent'], repeats: false, fields: [], capability: 'system' },
  ], dictionary: [],
};
/** Reserved names cannot be replaced by a product's declaration. */
export function withSystemContract(contract: GraphContract): GraphContract {
  for (const sort of ['vertex', 'edge'] as const) {
    for (const supplied of contract[sort]) {
      const system = SYSTEM_CONTRACT[sort].find((kind) => kind.name === supplied.name);
      if (system !== undefined && ('key' in supplied && supplied.key.length !== 0)) {
        throw new Error(`${import.meta.path}:1: product cannot replace protected system ${sort} kind ${supplied.name} with a natural key`);
      }
      if (system !== undefined && sort === 'edge' && JSON.stringify(supplied) !== JSON.stringify(system)) {
        throw new Error(`${import.meta.path}:1: product cannot replace protected system edge kind ${supplied.name}`);
      }
      if (system !== undefined && (supplied.table !== system.table || supplied.capability !== system.capability)) {
        throw new Error(`${import.meta.path}:1: product cannot replace protected system ${sort} storage or producer ${supplied.name}`);
      }
    }
  }
  const vertex = SYSTEM_CONTRACT.vertex.map((system) => {
    const supplied = contract.vertex.find((kind) => kind.name === system.name);
    if (supplied === undefined) return system;
    for (const field of supplied.fields) {
      const base = system.fields.find((held) => held.name === field.name);
      if (base !== undefined && ((['type', 'nullable', 'valueType', 'schema', 'reference'] as const).some((property) => JSON.stringify(base[property]) !== JSON.stringify(field[property])))) {
        throw new Error(`${import.meta.path}:1: product cannot replace protected field ${system.name}.${field.name}`);
      }
    }
    return { ...system, fields: [...system.fields, ...supplied.fields.filter((field) => !system.fields.some((held) => held.name === field.name))] };
  });
  return { ...contract, vertex: [...contract.vertex.filter((kind) => !SYSTEM_CONTRACT.vertex.some((system) => system.name === kind.name)), ...vertex],
    edge: [...contract.edge.filter((kind) => !SYSTEM_CONTRACT.edge.some((system) => system.name === kind.name)), ...SYSTEM_CONTRACT.edge] };
}

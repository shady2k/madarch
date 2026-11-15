/** Host-owned grants for writer tests; no external request can call this fixture. */
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { GraphContract } from '../src/graph/contract.js';
import { installAgentSession, registerSystemSource, withSystemContract } from '../src/graph/system-installation.js';
import { bindGraphProducer } from '../src/graph/producer-binding.js';

export async function testAgentBinding(owner: DatabaseOwner, contract: GraphContract, session = 'session-1') {
  const source = await installAgentSession(owner, contract, session);
  return bindGraphProducer(owner, contract, {
    principal: source.principal,
    vertices: Object.fromEntries(contract.vertex.map((kind) => [kind.name, kind.fields.map((field) => field.name)])),
    edges: Object.fromEntries(contract.edge.map((kind) => [kind.name, kind.fields.map((field) => field.name)])),
  });
}

const fixtureSources = new WeakMap<DatabaseOwner, Map<string, ReturnType<typeof registerSystemSource>>>();

/** A retained fixture installation, granted by the test host before it opens a write transaction. */
export async function testHostBinding(owner: DatabaseOwner, contract: GraphContract, producer: string, version = '1', contextId = 1) {
  const sources = fixtureSources.get(owner) ?? new Map<string, ReturnType<typeof registerSystemSource>>();
  fixtureSources.set(owner, sources);
  const key = JSON.stringify([producer, version]);
  let installed = sources.get(key);
  if (installed === undefined) {
    installed = registerSystemSource(owner, withSystemContract(contract), { type: 'plugin', installationKey: producer, scope: `test:${producer}`, version });
    sources.set(key, installed);
  }
  const source = await installed;
  return bindGraphProducer(owner, contract, {
    principal: source.principal,
    contextId,
    actions: ['assert', 'retract-own', 'merge', 'resolve'],
    vertices: Object.fromEntries(contract.vertex.map((kind) => [kind.name, kind.fields.map((field) => field.name)])),
    edges: Object.fromEntries(contract.edge.map((kind) => [kind.name, kind.fields.map((field) => field.name)])),
  });
}

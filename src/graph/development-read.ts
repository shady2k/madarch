/** Development reads over active declared edges and typed assertions (0039 items 1,6,7,14,25,30). */
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { readPublishedManifest } from './manifest-publication.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { withManifestContract } from './manifest-contract.js';
import { withAssertionContract } from './system-contract.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { graphContractVersion, type GraphContract } from './contract.js';
import { readKindAssertions, type AssertionRecord } from './records.js';
import { byCodePoint } from '../model/order.js';
import { withSpan } from '../obs/trace.js';
import type { McpToolDefinition, UnitToolAnswer } from '../mcp/types.js';

const names = ['impact', 'owner', 'dependencies', 'dependants', 'search'] as const;
export function isDevelopmentTool(name: string): boolean { return names.some(value => value === name); }
const enumeration = (values: readonly string[]) => Type.Union(values.map(value => Type.Literal(value)));

/** The installed catalogue supplies every kind and relation selector; no vocabulary is guessed (0039.7,30). */
export function developmentTools(contract: GraphContract): McpToolDefinition[] {
  const common = {
    contractVersion: Type.Literal(graphContractVersion(contract)),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
    lang: Type.Optional(Type.String({ minLength: 1 })),
  };
  const relations = Type.Array(Type.Object({
    kind: enumeration(contract.edge.map(edge => edge.name)),
    direction: Type.Union([Type.Literal('in'), Type.Literal('out')]),
  }, { additionalProperties: false }), { minItems: 1, uniqueItems: true });
  return names.map(name => ({
    name,
    description: name === 'search'
      ? 'Search effective names and synonyms. Homonyms remain separate with kind labels and assertion lineage.'
      : `${name}: traverse explicit catalogue relations from an entity UID. For dependencies use the dependency direction; for dependants and impact use its inverse. For owner select ownership/containment directions toward owners. Results group by kind, retain edge and entity lineage, and report depth/count cuts. No name-based ownership is inferred.`,
    inputSchema: { ...Type.Object(name === 'search' ? {
      ...common, text: Type.String({ minLength: 1 }),
      kinds: Type.Optional(Type.Array(enumeration(contract.vertex.map(kind => kind.name)), { minItems: 1, uniqueItems: true })),
    } : {
      ...common, entity: Type.String({ minLength: 36, maxLength: 36 }), relations,
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, default: name === 'impact' || name === 'owner' ? 8 : 1 })),
    }, { additionalProperties: false }) },
  }));
}

function refusal(code: string, path: string, expected: string, actual: unknown): UnitToolAnswer {
  return { isError: true, answer: { error: { code, path, expected, actual, retryable: false, message: `${import.meta.path}:50: ${path}: expected ${expected}` } } };
}

/** One caller-owned snapshot covers the contract, traversal, values and lineage (0039.25,30). */
export async function readDevelopmentTool(tx: OuterTransaction, manifest: KindsManifest, contract: GraphContract, name: string, input: unknown): Promise<UnitToolAnswer> {
  return await withSpan('graph.development.read', { 'mcp.tool': name }, async () => {
    const tool = developmentTools(contract).find(tool => tool.name === name);
    if (tool === undefined) return refusal('SCHEMA_INVALID', '/tool', 'declared development tool', name);
    const schema = Type.Unsafe(tool.inputSchema);
    const supplied = input;
    if (!Value.Check(schema, supplied)) {
      if (input !== null && typeof input === 'object' && 'contractVersion' in input && input.contractVersion !== graphContractVersion(contract)) return refusal('CONTRACT_CONFLICT', '/contractVersion', graphContractVersion(contract), input.contractVersion);
      const failure = [...Value.Errors(schema, input)][0];
      return refusal('SCHEMA_INVALID', failure?.instancePath ?? '', failure?.message ?? 'tool input schema', input);
    }
    const args = input as { contractVersion: string; limit?: number; lang?: string; text?: string; kinds?: string[]; entity?: string; depth?: number; relations?: { kind: string; direction: 'in' | 'out' }[] };
    const limit = args.limit ?? 100;
    const depth = args.depth ?? (name === 'impact' || name === 'owner' ? 8 : 1);
    const lang = args.lang ?? manifest.language ?? 'en';
    const vertices = new Map<string, AssertionRecord[]>();
    const loadKind = async (kind: string) => {
      let rows = vertices.get(kind);
      if (rows === undefined) {
        const declared = contract.vertex.find(vertex => vertex.name === kind)!;
        rows = await readKindAssertions(tx, 'vertex', kind, declared.fields.map(field => field.name), { contract });
        vertices.set(kind, rows);
      }
      return rows;
    };
    const identities = new Map<number, { kind: string; row: AssertionRecord }>();
    const describe = async (kind: string, row: AssertionRecord) => {
      const declared = manifest.kinds.get(kind);
      const label = declared?.labels?.[lang]?.one;
      if (label === undefined) throw new Error(`${import.meta.path}:88: kind ${kind} lacks label for ${lang}`);
      const values = { ...row.key, ...row.values };
      const title = declared?.title ?? 'name';
      const display = values[title];
      return { uid: row.uid, kind, kindLabel: label, label: typeof display === 'string' ? display : row.uid, values, assertions: await lineage(row) };
    };
    const sourceCache = new Map<string, { uid: string; kind: string }>();
    const lineage = async (row: AssertionRecord) => {
      const assertions = [];
      for (const assertion of row.assertions) {
        let source = sourceCache.get(assertion.source);
        if (source === undefined) {
          const result = await tx.query<{ uid: string; kind: string }>('SELECT n.uid::text AS uid,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid', [assertion.source]);
          source = result.rows[0];
          if (source === undefined) throw new Error(`${import.meta.path}:103: assertion ${assertion.id} has missing source ${assertion.source}`);
          sourceCache.set(assertion.source, source);
        }
        assertions.push({ uid: assertion.id, property: assertion.property, value: assertion.value, operation: assertion.operation, source, author: assertion.author, unit: assertion.unit, evidence: assertion.evidence, validFrom: assertion.validFrom, validTo: assertion.validTo, recordedAt: assertion.recordedAt, selected: row.selectedAssertions.some(selected => selected.id === assertion.id) });
      }
      return assertions;
    };
    const groups = new Map<string, Awaited<ReturnType<typeof describe>>[]>();
    const add = async (kind: string, row: AssertionRecord) => {
      const group = groups.get(kind) ?? [];
      group.push(await describe(kind, row)); groups.set(kind, group);
    };
    let cutByCount = false;
    let cutByDepth = false;
    const links: unknown[] = [];
    let subject: Awaited<ReturnType<typeof describe>> | undefined;
    if (name === 'search') {
      const needle = args.text!.trim().toLowerCase();
      if (needle === '') return refusal('SCHEMA_INVALID', '/text', 'nonblank text', args.text);
      const hits: { kind: string; row: AssertionRecord }[] = [];
      for (const kind of [...(args.kinds ?? manifest.kinds.keys())].sort(byCodePoint)) {
        for (const row of await loadKind(kind)) {
          const values = { ...row.key, ...row.values };
          const title = manifest.kinds.get(kind)?.title ?? 'name';
          const synonyms = values['synonyms'];
          const words = [values[title], ...(Array.isArray(synonyms) ? synonyms : [])];
          if (words.some(word => typeof word === 'string' && word.toLowerCase().includes(needle))) hits.push({ kind, row });
        }
      }
      hits.sort((a,b) => byCodePoint(a.kind,b.kind) || byCodePoint(a.row.uid,b.row.uid));
      cutByCount = hits.length > limit;
      for (const hit of hits.slice(0,limit)) await add(hit.kind, hit.row);
    } else {
      const uid = args.entity!;
      if ([...uid].some((point,index) => [8,13,18,23].includes(index) ? point !== '-' : !'0123456789abcdef'.includes(point))) return refusal('SCHEMA_INVALID', '/entity', 'lowercase UUID', uid);
      const target = await tx.query<{ kind: string }>('SELECT k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid', [uid]);
      const kind = target.rows[0]?.kind;
      if (kind === undefined || !contract.vertex.some(vertex => vertex.name === kind)) return refusal('TARGET_MISSING', '/entity', 'active declared entity UID', uid);
      const root = (await loadKind(kind)).find(row => row.uid === uid);
      if (root === undefined) return refusal('TARGET_MISSING', '/entity', 'active declared entity UID', uid);
      subject = await describe(kind, root);
      const relations = [...args.relations!].sort((a,b) => byCodePoint(a.kind,b.kind) || byCodePoint(a.direction,b.direction));
      const edges = new Map<string, AssertionRecord[]>();
      for (const relation of relations) {
        const edge = contract.edge.find(edge => edge.name === relation.kind)!;
        if (!edges.has(edge.name)) edges.set(edge.name, await readKindAssertions(tx,'edge',edge.name,edge.fields.map(field => field.name),{contract}));
        for (const endpointKind of new Set([...edge.from,...edge.to])) {
          for (const vertexKind of endpointKind === 'any' ? contract.vertex.map(vertex => vertex.name) : [endpointKind]) {
            for (const row of await loadKind(vertexKind)) identities.set(row.id,{kind:vertexKind,row});
          }
        }
      }
      const seen = new Set([root.id]);
      let frontier = [root.id];
      let count = 0;
      for (let level = 0; frontier.length > 0; level += 1) {
        const candidates = new Map<number, { kind: string; row: AssertionRecord }>();
        const traversed: { edge: AssertionRecord; relation: string; from: number; to: number }[] = [];
        for (const current of frontier) for (const relation of relations) for (const edge of edges.get(relation.kind)!) {
          const from = relation.direction === 'out' ? edge.from! : edge.to!;
          const to = relation.direction === 'out' ? edge.to! : edge.from!;
          if (from !== current || seen.has(to)) continue;
          const other = identities.get(to);
          if (other === undefined) continue; // Retired endpoints are not active relations.
          candidates.set(to,other); traversed.push({edge,relation:relation.kind,from,to});
        }
        if (level === depth) { cutByDepth = candidates.size > 0; break; }
        const ordered = [...candidates.values()].sort((a,b) => byCodePoint(a.kind,b.kind) || byCodePoint(a.row.uid,b.row.uid));
        const shown = ordered.slice(0,limit-count);
        cutByCount = ordered.length > shown.length;
        frontier = [];
        for (const item of shown) { seen.add(item.row.id); frontier.push(item.row.id); count += 1; await add(item.kind,item.row); }
        const included = new Set(frontier);
        for (const link of traversed) if (included.has(link.to)) links.push({ uid:link.edge.uid,kind:link.relation,from:identities.get(link.edge.from!)!.row.uid,to:identities.get(link.edge.to!)!.row.uid,depth:level+1,assertions:await lineage(link.edge) });
        if (cutByCount) break;
      }
    }
    return { isError:false, answer:{ contractVersion:graphContractVersion(contract), ...(subject === undefined ? {} : { subject }), groups:[...groups].sort(([a],[b])=>byCodePoint(a,b)).map(([kind,entities])=>({kind,entities})), links, cut:{depth:cutByDepth,count:cutByCount}, bounds:{depth:name==='search'?null:depth,count:limit} } };
  });
}

/** Open the published catalogue and its answer in the same database snapshot. */
export async function developmentRead(owner: DatabaseOwner, name?: string, input?: unknown) {
  return await withSpan('graph.development.snapshot', {}, async () => await owner.transaction('snapshot', async tx => {
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined) throw new Error(`${import.meta.path}:1: no published manifest`);
    const contract = withAssertionContract(withManifestContract(graphContractOf(manifest)));
    return name === undefined ? developmentTools(contract) : await readDevelopmentTool(tx, manifest, contract, name, input);
  }));
}

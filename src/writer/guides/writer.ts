/** Guide-only preparation on the existing temporal graph and pinned Git snapshot. */
import { resolve } from 'node:path';
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import { createGitSnapshotSource, type SnapshotSource } from '../../fill/snapshot.js';
import { resolveLens } from '../../graph/reads.js';
import type { GraphStore } from '../../graph/index.js';
import type { UnitAgent } from '../run.js';
import type { GuideContext, GuideDocument, GuideGround, GuideKind, GuideLocale, GuideProcedure, GuideStep, GuideValidationHost } from './model.js';
import { GUIDE_SCHEMA } from './model.js';
import { GUIDE_OUTPUTS, type GuidePreparedUnit, type GuideWriterHost } from './host-contract.js';
import { guideDigest, guideStepDigest, sameGuideContext } from './digest.js';
import { byCodePoint } from '../../model/order.js';
import { createGuidePublication, type GuidePublicationOwner } from './publication.js';
import { readGuideReceipts } from './receipt-read.js';
import { instantText } from '../../graph/time.js';
import { isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';
import { unified } from 'unified';
import { runGit } from '../../product/git.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import remarkParse from 'remark-parse';
import { firstGuideCursor, guidePagesComplete, registerGuidePages } from './prepared.js';

export const GUIDE_UNIT_VERSION = 'guide-writer@1';
const MAX_PREPARED_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_ROWS = 1200;
const MAX_SOURCE_LINES = 200;
export interface GuideEvidenceSpan { readonly ground: GuideGround; readonly text: string; readonly digest: string }
export interface GuidePreparedEvidence {
  readonly context: GuideContext;
  readonly facts: readonly unknown[];
  readonly spans: readonly GuideEvidenceSpan[];
  readonly gaps: readonly string[];
  readonly policy: { readonly version: 'withhold-config-values@1'; readonly withheldValues: number; readonly classifiedSources: readonly string[] };
  /** Private source policy values; removed before publication or an agent sees the packet. */
  readonly configValues?: readonly string[];
}
/** The actual graph owner lends its snapshot, not an agent-supplied evidence callback. */
export interface GuideWriterWiring {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly snapshots: SnapshotSource;
  readonly output: string;
  readonly scope: string;
  readonly valid: string;
  readonly agent: UnitAgent;
  /** Additional host-known sensitive values; parsed configuration withholding always applies independently. */
  readonly sensitiveValues?: readonly string[];
  readonly afterWrite?: (path: string) => Promise<void>;
}

/** Resolve all coordinates through the graph's own state-chain policy. */
export async function resolveGuideContext(wiring: Pick<GuideWriterWiring, 'owner' | 'snapshots' | 'valid'>): Promise<GuideContext> {
  const repositories = [];
  for (const pin of await wiring.snapshots.pins()) {
    const reader = await wiring.snapshots.open(pin.id);
    repositories.push({ name: pin.id, commit: reader.commit });
  }
  const lens = await wiring.owner.transaction('snapshot', async (tx) => {
    const time = await tx.query<{ now: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now");
    const now = time.rows[0]?.now;
    if (typeof now !== 'string') throw new Error('guide context: the database did not supply its recorded-time instant');
    return await resolveLens(tx, { valid: wiring.valid }, now);
  });
  return { valid: lens.valid, known: lens.known, state: String(lens.state), repositories: repositories.sort((a, b) => byCodePoint(a.name, b.name)) };
}

const visible = (alias: string): string => `${alias}.valid_from <= $1::timestamptz AND $1::timestamptz < ${alias}.valid_to AND ${alias}.recorded_from <= $2::timestamptz AND $2::timestamptz < ${alias}.recorded_to AND ${alias}.states @> $3::bigint AND ${alias}.scope_id = $4::bigint`;
export interface GuideGraphMembership { readonly nodes: readonly Record<string, unknown>[]; readonly edges: readonly Record<string, unknown>[] }
/** The legacy knowledge graph has its own publication namespace, not fill_fact. */
export async function readGuideGraph(wiring: Pick<GuideWriterWiring, 'owner' | 'scope'>, context: GuideContext, current = false, transaction?: import('../../history/types.js').OuterTransaction): Promise<GuideGraphMembership> {
  const read = async (tx: import('../../history/types.js').OuterTransaction): Promise<GuideGraphMembership> => {
    let known = context.known;
    if (current) {
      const row = (await tx.query<{known:string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS known")).rows[0];
      if (row === undefined) throw new Error('guide graph: recorded-time coordinate is unavailable');
      known = row.known;
    }
    const params = [context.valid,known,context.state,wiring.scope,MAX_GRAPH_ROWS+1];
    const nodes = (await tx.query<Record<string,unknown>>(`SELECT v.node_id::text AS id,k.key AS kind,v.label,v.properties,v.payload_digest FROM node_version v JOIN node_kind k ON k.id=v.kind_id WHERE ${visible('v')} AND k.key LIKE 'code.%' ORDER BY k.key COLLATE "C",v.node_id,v.id LIMIT $5`,params)).rows;
    const edges = (await tx.query<Record<string,unknown>>(`SELECT v.edge_id::text AS id,r.key AS relation,v.src_id::text AS src,v.dst_id::text AS dst,v.properties,v.payload_digest FROM edge_version v JOIN relation_type r ON r.id=v.relation_type_id WHERE ${visible('v')} AND r.key LIKE 'code.%' AND EXISTS(SELECT 1 FROM node_version s WHERE s.node_id=v.src_id AND ${visible('s')}) AND EXISTS(SELECT 1 FROM node_version d WHERE d.node_id=v.dst_id AND ${visible('d')}) ORDER BY r.key COLLATE "C",v.edge_id,v.id LIMIT $5`,params)).rows;
    if(nodes.length>MAX_GRAPH_ROWS || edges.length>MAX_GRAPH_ROWS) throw new Error('guide preparation: complete node or edge membership exceeds its bound; no smaller graph was returned');
    return {nodes,edges};
  };
  return transaction === undefined ? await wiring.owner.transaction('snapshot', read) : await read(transaction);
}
/** Conservative parsed-config policy: literal configuration values are withheld, not guessed public defaults. */
function configurationValues(path: string, text: string): readonly string[] {
  if (!path.endsWith('.yaml') && !path.endsWith('.yml') && !path.endsWith('.json')) return [];
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (documents.some((document) => document.errors.length > 0)) throw new Error('guide config policy: a configuration document could not be parsed');
  const values: string[] = [];
  const visit = (node: unknown): void => {
    if (isMap(node)) { for (const pair of node.items) visit(pair.value); }
    else if (isSeq(node)) { for (const item of node.items) visit(item); }
    else if (isScalar(node) && typeof node.value === 'string' && node.value.length > 0) values.push(node.value);
  };
  for (const document of documents) visit(document.contents);
  return values;
}
export function guidePacketPolicy(evidence: GuidePreparedEvidence, knownValues: readonly string[] = []): { readonly evidence: GuidePreparedEvidence; readonly sensitiveValues: readonly string[] } {
  const values = new Set(knownValues.filter((value) => value.length > 0));
  const classifiedSources: string[] = [...evidence.policy.classifiedSources];
  for (const item of evidence.facts) {
    if (item === null || typeof item !== 'object') continue;
    const fact = item as Record<string, unknown>;
    if (fact['kind'] !== 'code.env-definition' && fact['kind'] !== 'code.env-read') continue;
    const properties = fact['properties'];
    if (properties === null || typeof properties !== 'object') continue;
    for (const field of ['value', 'default']) { const value = (properties as Record<string, unknown>)[field]; if (typeof value === 'string' && value.length > 0) values.add(value); }
    classifiedSources.push(`graph:${String(fact['id'])}`);
  }
  for (const value of evidence.configValues ?? []) if (value.length > 0) values.add(value);
  const sensitiveValues = [...values];
  const contains = (value: unknown): boolean => containsGuideSecret(JSON.stringify(value), sensitiveValues);
  const facts = evidence.facts.map((fact) => {
    if (fact === null || typeof fact !== 'object') return fact;
    const row = fact as Record<string, unknown>;
    // The whole original row stays in the private dependency membership, never the agent packet.
    return contains(row) ? { id: row['id'], kind: row['kind'], relation: row['relation'], withheld: 'configuration values withheld by source policy' } : row;
  });
  const spans = evidence.spans.filter((span) => !contains(span.text));
  const withheld = evidence.spans.length - spans.length;
  const gaps = [...evidence.gaps, ...(withheld === 0 ? [] : [`${withheld} source spans contain configuration values and were withheld; no public or development-default status was inferred.`])];
  const { configValues: _privateValues, ...publicEvidence } = evidence;
  return { evidence: { ...publicEvidence, facts, spans, gaps, policy: { version: 'withhold-config-values@1', withheldValues: values.size, classifiedSources: classifiedSources.sort(byCodePoint) } }, sensitiveValues };
}

function generatedGuideSource(text: string): boolean {
  if(!text.startsWith('---\n'))return false;
  const closed=text.indexOf('\n---',4);if(closed<0)return false;
  const first=parseAllDocuments(text.slice(4,closed))[0];
  if(first===undefined||first.errors.length>0||!isMap(first.contents))return false;
  const producer=first.contents.items.find((pair)=>isScalar(pair.key)&&pair.key.value==='producer')?.value;
  return isScalar(producer)&&producer.value==='agent';
}
async function productDocumentMembership(snapshot: import('../../fill/snapshot.js').SnapshotReader):Promise<string> {
  const documents=[];
  for(const entry of snapshot.files()){
    const path=String(entry.path);if(!guideProductDocument(path))continue;
    const text=await snapshot.readText(path);if(generatedGuideSource(text))continue;
    documents.push({path,digest:guideDigest(text)});
  }
  return guideDigest(documents);
}
async function sourceContextSnapshots(snapshots:SnapshotSource,context:GuideContext):Promise<SnapshotSource|undefined>{
  const pins=await snapshots.pins();
  if(pins.length!==context.repositories.length)return undefined;
  const rebound=[];
  for(const pin of pins){
    const expected=context.repositories.find((repository)=>repository.name===pin.id);if(expected===undefined)return undefined;
    const current=await snapshots.open(pin.id);
    if(current.commit===expected.commit){rebound.push({...pin,commit:expected.commit});continue;}
    if(pin.form!=='product')return undefined;
    const previous=createGitSnapshotSource([{...pin,commit:expected.commit}]);const old=await previous.open(pin.id);
    if(await productDocumentMembership(current)!==await productDocumentMembership(old))return undefined;
    rebound.push({...pin,commit:expected.commit});
  }
  return createGitSnapshotSource(rebound);
}

export function guideProductDocument(path:string):boolean {
  return (path.endsWith('.md')||path.endsWith('.markdown')) && !path.split('/').some((part)=>part.startsWith('.')) && !path.startsWith('repos/') && !path.startsWith('docs/guides/') && !path.startsWith('docs/guide-walks/') && !path.startsWith('docs/sources/') && path!=='AGENTS.md' && path!=='CLAUDE.md';
}
/** Each span belongs to this scope's one actual repository pin; no cross-repository path matching. */
export async function prepareGuideEvidence(wiring: Pick<GuideWriterWiring, 'owner' | 'scope' | 'snapshots'>, context: GuideContext): Promise<GuidePreparedEvidence> {
  const codePins=(await wiring.snapshots.pins()).filter((pin)=>pin.form==='code');
  if(codePins.length!==1)throw new Error('guide preparation: this legacy writer needs one actual code scope; no repository was omitted');
  const repository=context.repositories.find((pin)=>pin.name===codePins[0]!.id);
  if(repository===undefined)throw new Error('guide preparation: the actual code repository is absent from the context');
  const reader=await wiring.snapshots.open(repository.name);
  if(reader.commit!==repository.commit) throw new Error('guide preparation: repository pin changed');
  const membership=await readGuideGraph(wiring,context);
  const facts:readonly unknown[]=[...membership.nodes,...membership.edges];
  const spans:GuideEvidenceSpan[]=[];const seen=new Set<string>();const gaps:string[]=[];
  const configValues: string[] = [];const blockedConfigPaths=new Set<string>();const classifiedSources: string[] = [];
  for (const fact of membership.nodes) {
    if(fact['kind']!=='code.file'||fact['properties']===null||typeof fact['properties']!=='object')continue;
    const path=(fact['properties'] as Record<string,unknown>)['path'];
    if(typeof path!=='string'||(!path.endsWith('.yaml')&&!path.endsWith('.yml')&&!path.endsWith('.json')))continue;
    try {const text=await reader.readText(path);configValues.push(...configurationValues(path,text));classifiedSources.push(`${repository.name}/${path}`);}
    catch{gaps.push(`${repository.name}/${path}:1: configuration policy could not parse the complete pinned file; all its source spans were withheld`);blockedConfigPaths.add(path);}
  }
  // Document paragraphs/lists/code blocks retain parser source ranges. No heading-name heuristic selects roles.
  for (const fact of membership.nodes) {
    if (fact['kind'] !== 'code.file' || fact['properties'] === null || typeof fact['properties'] !== 'object') continue;
    const path = (fact['properties'] as Record<string,unknown>)['path'];
    if (typeof path !== 'string' || (!path.endsWith('.md') && !path.endsWith('.markdown'))) continue;
    let text: string;
    try { text = await reader.readText(path); } catch { gaps.push(`${repository.name}/${path}:1: pinned document is unavailable`); continue; }
    const document = unified().use(remarkParse).parse(text);
    const lines = text.split('\n');
    for (const node of document.children) {
      const start=node.position?.start.line;const end=node.position?.end.line;
      if(start===undefined||end===undefined){gaps.push(`${repository.name}/${path}:1: document node has no exact parser range`);continue;}
      if(end-start+1>MAX_SOURCE_LINES){gaps.push(`${repository.name}/${path}:${start}: document block exceeds ${MAX_SOURCE_LINES} lines; it was not cut`);continue;}
      const ground={repository:repository.name,commit:repository.commit,path,line:start,endLine:end};const key=guideDigest(ground);
      if(seen.has(key))continue;seen.add(key);
      const excerpt=lines.slice(start-1,end).join('\n');spans.push({ground,text:excerpt,digest:guideDigest({ground,text:excerpt})});
    }
  }
  for(const fact of membership.nodes){
    const properties=fact['properties'];
    if(properties===null||typeof properties!=='object') continue;
    const span=(properties as Record<string,unknown>)['span'];
    if(span===null||typeof span!=='object') continue;
    const place=span as Record<string,unknown>;
    if(typeof place['path']!=='string'||!Number.isInteger(place['lineStart'])||!Number.isInteger(place['lineEnd'])){gaps.push(`Graph node ${String(fact['id'])}: source span is malformed`);continue;}
    const ground={repository:repository.name,commit:repository.commit,path:place['path'],line:Number(place['lineStart']),endLine:Number(place['lineEnd'])};
    if(blockedConfigPaths.has(ground.path))continue;
    if(ground.endLine-ground.line+1>MAX_SOURCE_LINES){gaps.push(`${repository.name}/${ground.path}:${ground.line}: source span exceeds ${MAX_SOURCE_LINES} lines; it was not partially supplied`);continue;}
    const key=guideDigest(ground);if(seen.has(key))continue;seen.add(key);
    let text:string;
    try{const lines=(await reader.readText(ground.path)).split('\n');if(ground.line<1||ground.endLine>lines.length)throw new Error('span outside file');text=lines.slice(ground.line-1,ground.endLine).join('\n');}
    catch{gaps.push(`${repository.name}/${ground.path}:${ground.line}: exact pinned bytes are unavailable; no replacement source was supplied`);continue;}
    spans.push({ground,text,digest:guideDigest({ground,text})});
  }
  for(const productPin of (await wiring.snapshots.pins()).filter((pin)=>pin.form==='product')) {
    const product=await wiring.snapshots.open(productPin.id);
    const pinned=context.repositories.find((pin)=>pin.name===productPin.id);
    if(pinned===undefined||pinned.commit!==product.commit)throw new Error('guide product-document pin changed');
    for(const entry of product.files()){
      const path=String(entry.path);
      if(!guideProductDocument(path))continue;
      let text:string;
      try{text=await product.readText(path);}catch{gaps.push(`${productPin.id}/${path}:1: pinned product document is unavailable`);continue;}
      // Generated narrative/localized content is not new source authority.
      if(generatedGuideSource(text))continue;
      try{const current=await readFile(join(product.root,path),'utf8');if(current!==text){gaps.push(`${productPin.id}/${path}:1: uncommitted product-document changes are not included in pinned grounds`);continue;}}
      catch{gaps.push(`${productPin.id}/${path}:1: working document is unavailable; committed source only was not substituted`);continue;}
      const document=unified().use(remarkParse).parse(text);const lines=text.split('\n');
      for(const node of document.children){const start=node.position?.start.line;const end=node.position?.end.line;if(start===undefined||end===undefined){gaps.push(`${productPin.id}/${path}:1: document node has no parser range`);continue;}if(end-start+1>MAX_SOURCE_LINES){gaps.push(`${productPin.id}/${path}:${start}: document block exceeds ${MAX_SOURCE_LINES} lines; no shortened block was supplied`);continue;}const ground={repository:productPin.id,commit:product.commit,path,line:start,endLine:end};const excerpt=lines.slice(start-1,end).join('\n');spans.push({ground,text:excerpt,digest:guideDigest({ground,text:excerpt})});}
    }
  }
  gaps.push('Source evidence does not certify execution. Procedures without instruction and expected-result proof remain gaps.');
  const evidence:GuidePreparedEvidence={context,facts,spans,gaps,configValues,policy:{version:'withhold-config-values@1',withheldValues:configValues.length,classifiedSources}};
  if(Buffer.byteLength(JSON.stringify(evidence))>MAX_PREPARED_BYTES)throw new Error('guide preparation: complete source context exceeds its byte bound; no smaller input was returned');
  return evidence;
}

export function containsGuideSecret(text: string, sensitiveValues: readonly string[] | undefined): boolean {
  return (sensitiveValues ?? []).some((value) => value.length > 0 && text.includes(value));
}

/** A proposed semantic judgement is independent of the agent's guide payload and bound to exact source bytes. */
export async function verifyGuideStep(agent: UnitAgent, evidence: GuidePreparedEvidence, step: GuideStep, procedure: GuideProcedure, guide: GuideDocument): Promise<readonly string[]> {
  const spans: GuideEvidenceSpan[] = [];
  for (const ground of step.grounds) {
    const held = evidence.spans.find((candidate) => guideDigest(candidate.ground) === guideDigest(ground));
    if (held === undefined) return ['The complete exact pinned source span is not part of the prepared evidence.'];
    spans.push(held);
  }
  if(Buffer.byteLength(JSON.stringify({step,procedure,spans}))>64*1024)return ['The exact semantic verification input exceeds its bounded context; split the step and cite narrower prepared spans.'];
  const identity = guideDigest({ step, procedure: { id: procedure.id, prerequisites: procedure.prerequisites }, context: guide.context, spans });
  let verdict: { instruction: boolean; expected: boolean } | undefined;
  await agent.run({
    id: `guide-proof:${identity}`,
    prompt: ['Judge this proposed procedure step against the exact pinned source and graph facts. It is not a request to execute anything.',
      'Return verify_guide_step once. instructionSupported and expectedSupported are true ONLY if the supplied evidence establishes the exact instruction and its exact expected status AND observation. A resolving citation, plausible convention, nearby string or successful generation is not proof. Missing or contradictory evidence means false. Your judgement is an interpretation, not an extracted fact or an execution receipt.',
      JSON.stringify({ identity, step, procedure: { role: procedure.role, goal: procedure.goal, prerequisites: procedure.prerequisites }, spans, graphMembershipDigest:guideDigest(evidence.facts), coverage:evidence.policy }),
    ].join('\n\n'),
    tools: {
      definitions: [{ name: 'verify_guide_step', description: 'Record the evidence judgement for this exact step.', inputSchema: { type: 'object', additionalProperties: false, properties: { identity: { type: 'string' }, instructionSupported: { type: 'boolean' }, expectedSupported: { type: 'boolean' } }, required: ['identity', 'instructionSupported', 'expectedSupported'] } }],
      finished: () => verdict !== undefined,
      call: async (tool, value) => {
        if (verdict !== undefined || tool !== 'verify_guide_step' || value === null || typeof value !== 'object' || Array.isArray(value)) return { isError: true, answer: { error: 'one typed evidence judgement is required' } };
        const data = value as Record<string, unknown>;
        if (Object.keys(data).length !== 3 || data['identity'] !== identity || typeof data['instructionSupported'] !== 'boolean' || typeof data['expectedSupported'] !== 'boolean') return { isError: true, answer: { error: 'the judgement must bind the exact step and both proof fields' } };
        verdict = { instruction: data['instructionSupported'], expected: data['expectedSupported'] };
        return { isError: false, answer: { recorded: true } };
      },
    },
  });
  return verdict?.instruction === true && verdict.expected === true ? [] : ['The source judgement did not support both the exact instruction and expected result.'];
}

export async function createGuideWriter(wiring: GuideWriterWiring): Promise<GuideWriterHost> {
  let context = await resolveGuideContext(wiring);
  const previous = await wiring.owner.run(async (tx) => (await tx.query<{context:GuideContext;membership:string}>(`SELECT v.properties->'context' AS context,v.properties->>'readMembership' AS membership FROM node_version v JOIN node_kind k ON k.id=v.kind_id JOIN work_item w ON w.id=v.opened_by WHERE v.scope_id=$1::bigint AND k.key='guide-artifact' AND w.published_at IS NOT NULL AND w.published_digest IS NOT NULL ORDER BY w.generation DESC,v.id DESC LIMIT 1`,[wiring.scope])).rows[0]);
  if(previous!==undefined && previous.context.valid===context.valid && await sourceContextSnapshots(wiring.snapshots,previous.context)!==undefined) {
    const current=await readGuideGraph(wiring,previous.context,true);
    if(guideDigest([...current.nodes,...current.edges])===previous.membership)context=previous.context;
  }
  const sourceSnapshots=await sourceContextSnapshots(wiring.snapshots,context);
  if(sourceSnapshots===undefined)throw new Error('guide current source membership is incompatible with its prepared context');
  wiring={...wiring,snapshots:sourceSnapshots};
  const privateEvidence = await prepareGuideEvidence(wiring, context);
  const protectedInput = guidePacketPolicy(privateEvidence, wiring.sensitiveValues);
  const evidence = protectedInput.evidence;
  wiring = { ...wiring, sensitiveValues: protectedInput.sensitiveValues };
  return {
    async prepare(kind: GuideKind, locale: GuideLocale): Promise<GuidePreparedUnit> {
      const output = GUIDE_OUTPUTS[kind];
      const inputDigest = guideDigest({ kind, locale, version: GUIDE_UNIT_VERSION, evidence });
      const verified = new Set<string>();
      const validation: GuideValidationHost = {
        file: resolve(wiring.output, output.path), expectedContext: context, expectedInputDigest: inputDigest, expectedUnitVersion: GUIDE_UNIT_VERSION,
        containsSecret: (text) => containsGuideSecret(text, wiring.sensitiveValues),
        verifyStep: async (step, procedure, guide) => {
          const result = await verifyGuideStep(wiring.agent, evidence, step, procedure, guide);
          if (result.length === 0) verified.add(guideDigest({ document: guideDigest(guide), step: guideStepDigest(guide, procedure.id, step) }));
          return result;
        },
      };
      const publication: GuidePublicationOwner = { ...wiring, kind, locale, context, inputDigest, unitVersion: GUIDE_UNIT_VERSION, evidence, readMembership: guideDigest(privateEvidence.facts), verified };
      const publishChecked = await createGuidePublication(publication);
      const prepared: GuidePreparedUnit = {
        prompt: '',
        validation,
        publishChecked: async (request) => {
          if (!guidePagesComplete(prepared)) return { ok:false, diagnostics:[{file:validation.file,line:1,path:'$.context',code:'guide-context-incomplete',message:`${validation.file}:1: $.context: prepared input packets remain unread`}] };
          return await publishChecked(request);
        },
      };
      const entries:unknown[]=[{type:'coverage',context,policy:evidence.policy,facts:evidence.facts.length,spans:evidence.spans.length,gaps:evidence.gaps.length}];
      for(const fact of evidence.facts)entries.push({type:'fact',value:fact});
      for(const span of evidence.spans){
        const lines=span.text.split('\n');
        let offset=0;
        while(offset<lines.length){
          let end=offset+1;
          while(end<lines.length&&Buffer.byteLength(JSON.stringify(lines.slice(offset,end+1)))<8000)end+=1;
          const text=lines.slice(offset,end).join('\n');const ground={...span.ground,line:span.ground.line+offset,endLine:span.ground.line+end-1};
          entries.push({type:'source',ground,text,wholeSpanDigest:span.digest,part:offset===0&&end===lines.length?'whole':'bounded-part'});offset=end;
        }
      }
      for(const gap of evidence.gaps)entries.push({type:'gap',message:gap});
      registerGuidePages(prepared,inputDigest,entries);
      Object.defineProperty(prepared,'prompt',{value:JSON.stringify({schema:GUIDE_SCHEMA,id:output.id,kind,locale,unitVersion:GUIDE_UNIT_VERSION,inputDigest,context,firstCursor:firstGuideCursor(prepared),instruction:'Read every prepared context packet using read_prepared_context and follow next to null before write_guide. Source parts retain exact ranges; source verification requires their complete named prepared span. Missing evidence is a visible gap.',shape:{title:'localized title',prerequisites:[],gaps:[],procedures:[]}}),enumerable:true});
      return prepared;
    },
  };
}

/** Read the last actually published preparation and semantic judgements, not the artifact's assertions. */
export function createGuideReadFactories(wiring: {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly snapshots: SnapshotSource;
  readonly output: string;
  readonly scopeOf: (repository: string) => string | undefined;
  readonly sensitiveValues?: readonly string[];
}): { guideContextFor: import('./host.js').GuideContextFor; guideHostFor: import('./host.js').GuideHostFor } {
  const published = async (kind: GuideKind, locale: GuideLocale): Promise<Record<string, unknown> | undefined> => {
    const scopes = (await wiring.snapshots.pins()).filter((pin)=>pin.form==='code').map((pin) => wiring.scopeOf(pin.id));
    if (scopes.length !== 1 || scopes[0] === undefined) return undefined;
    const rows = await wiring.owner.run(async (tx) => (await tx.query<{ properties: Record<string, unknown> }>(
      `SELECT v.properties FROM node_version v JOIN node_kind k ON k.id=v.kind_id JOIN work_item w ON w.id=v.opened_by WHERE v.producer=$1 AND v.scope_id=$2::bigint AND k.key='guide-artifact' AND v.properties->>'locale'=$3 AND w.published_at IS NOT NULL AND w.published_digest IS NOT NULL ORDER BY w.generation DESC,v.id DESC LIMIT 1`, [`writer.${kind}`, scopes[0], locale],
    )).rows);
    return rows[0]?.properties;
  };
  return {
    guideContextFor: async (request) => {
      const held = await published(request.kind, request.locale);
      if (held === undefined) return undefined;
      const context = held['context'] as GuideContext | undefined;
      if (context === undefined || context.valid !== instantText(request.valid, 'guide read', 'valid')) return undefined;
      const actualPins=await wiring.snapshots.pins();
      if(guideDigest([...request.repositories].sort((a,b)=>byCodePoint(a.name,b.name)))!==guideDigest((await Promise.all(actualPins.map(async(pin)=>({name:pin.id,commit:(await wiring.snapshots.open(pin.id)).commit})))).sort((a,b)=>byCodePoint(a.name,b.name))))return undefined;
      if(await sourceContextSnapshots(wiring.snapshots,context)===undefined)return undefined;
      return context;
    },
    guideHostFor: async (request) => {
      const held = await published(request.kind, request.locale);
      if (held === undefined || !sameGuideContext(held['context'] as GuideContext, request.context)) throw new Error('guide source proof is unavailable');
      const evidence = held['evidence'] as GuidePreparedEvidence;
      if (evidence === undefined || guideDigest(evidence) !== held['evidenceDigest']) throw new Error('guide preparation digest is unavailable');
      const sourceSnapshots=await sourceContextSnapshots(wiring.snapshots,request.context);
      if(sourceSnapshots===undefined)throw new Error('guide relevant source membership changed');
      for (const span of evidence.spans) {
        const reader = await sourceSnapshots.open(span.ground.repository);
        if (reader.commit !== span.ground.commit) throw new Error('guide source pin changed');
        const text = (await reader.readText(span.ground.path)).split('\n').slice(span.ground.line-1,span.ground.endLine).join('\n');
        if (guideDigest({ground:span.ground,text}) !== span.digest || containsGuideSecret(text,wiring.sensitiveValues ?? [])) throw new Error('guide source proof changed or is sensitive');
      }
      const codePin = (await wiring.snapshots.pins()).find((pin)=>pin.form==='code');
      const repository = request.context.repositories.find((pin)=>pin.name===codePin?.id);
      if (repository === undefined) throw new Error('guide source scope is unavailable');
      const scope = wiring.scopeOf(repository.name);
      if (scope === undefined) throw new Error('guide source scope is unavailable');
      const privateMembership = await readGuideGraph({ owner: wiring.owner, scope }, request.context, true);
      if (guideDigest([...privateMembership.nodes,...privateMembership.edges]) !== held['readMembership']) throw new Error('guide relevant graph membership changed');
      const privateEvidence = await prepareGuideEvidence({ owner: wiring.owner, scope, snapshots: sourceSnapshots }, request.context);
      const policy = guidePacketPolicy(privateEvidence, wiring.sensitiveValues);
      if (guideDigest(policy.evidence) !== guideDigest(evidence) || guideDigest({kind:request.kind,locale:request.locale,version:GUIDE_UNIT_VERSION,evidence}) !== held['inputDigest'] || held['unitVersion'] !== GUIDE_UNIT_VERSION) throw new Error('guide prepared input policy, version or evidence changed');
      const sensitiveValues = policy.sensitiveValues;
      const verified = new Set(Array.isArray(held['verifiedSteps']) ? held['verifiedSteps'] as string[] : []);
      const file = resolve(wiring.output, GUIDE_OUTPUTS[request.kind].path);
      const productSource=(await sourceSnapshots.pins()).find((pin)=>pin.form==='product');
      return {
        ...(productSource===undefined?{}:{productRepositoryId:productSource.id}),
        validation: {
          expectedContext: request.context, expectedInputDigest: String(held['inputDigest']), expectedUnitVersion: String(held['unitVersion']),
          containsSecret: (text) => containsGuideSecret(text,sensitiveValues),
          verifyStep: async (step,procedure,guide) => verified.has(guideDigest({ document: guideDigest(guide), step: guideStepDigest(guide,procedure.id,step) })) ? [] : ['The exact proposed semantic proof is not published for this step.'],
        },
        execution: {
          file, containsSecret: (text) => containsGuideSecret(text,sensitiveValues),
          verifyExecution: async () => ({ kind: 'unverified', reason: 'No independently enrolled operator execution evidence authority is available.' }),
        },
        readReceipts: async () => await readGuideReceipts(wiring.output,request.kind),
      };
    },
  };
}

/** Product source pin uses the actual repository identity namespace, never a code repository alias. */
export function guideProductPin(output:string,codeNames:readonly string[]):import('../../fill/snapshot.js').RepositoryPin {
  const id='product';
  if(codeNames.includes(id))throw new Error('guide product source: reserved product pin collides with a code repository name');
  const head=runGit(output,['rev-parse','--verify','HEAD^{commit}']);
  if(!head.ok)throw new Error('guide product source: product repository has no readable committed HEAD');
  return {id,form:'product',root:output,commit:head.output.trim()};
}

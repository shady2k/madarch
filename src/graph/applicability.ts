/** Per-product kind assertions and explicit absence propagation (0039 item 35). */
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract, EvidenceDraft, EntityRefDraft, VertexDraft } from './contract.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { byCodePoint } from '../model/order.js';
import { withSpan } from '../obs/trace.js';
import { readKindAssertions } from './records.js';
import { publishGraphDrafts, requireWriteCapability, writeAssertion } from './write.js';
import { selectAssertions } from './assertion-selection.js';

export type ApplicabilityState = 'not-searched' | 'applicable' | 'empty' | 'failed' | 'inapplicable';
export interface KindApplicability { readonly kind: string; readonly state: ApplicabilityState; readonly reason: string; readonly evidence: readonly string[]; readonly contested: boolean; readonly ancestor?: string; }
const KIND = 'system.kind-applicability';

export async function readApplicability(tx: SqlExecutor, contract: GraphContract): Promise<KindApplicability[]> {
  return await withSpan('graph.applicability.read', {}, async () => {
    const now = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    const kinds = await readKindAssertions(tx, 'vertex', 'manifest.kind', ['name']);
    const links = await readKindAssertions(tx, 'edge', 'system.applicability-kind', [], {validAt:now,recordedAt:now});
    const marks = await readKindAssertions(tx, 'vertex', KIND, ['state', 'reason'], { contract,validAt:now,recordedAt:now });
    return marks.map(mark => {
      const kind = kinds.find(kind => kind.id === links.find(link => link.from === mark.id)?.to);
      if (kind === undefined) throw new Error(`${import.meta.path}:24: applicability mark ${mark.uid} has no declared kind`);
      const selection = selectAssertions(mark.assertions.filter(row => row.property === 'state'), { validAt: now, recordedAt: now, contexts: [1] });
      const parent = marks.find(other => other.uid !== mark.uid && other.assertions.some(assertion => mark.assertions.find(row => row.id === selection.selected?.id)?.evidence.includes(assertion.id)));
      const ancestor = parent === undefined ? undefined : kinds.find(candidate => candidate.id === links.find(link => link.from === parent.id)?.to)?.values['name'];
      return { ...(typeof ancestor === 'string' ? {ancestor} : {}), kind: String(kind.values['name']), state: (mark.values['state'] ?? 'not-searched') as ApplicabilityState, reason: String(selectAssertions(mark.assertions.filter(row => row.property === 'reason' && row.source === selection.selected?.source), {validAt:now,recordedAt:now,contexts:[1]}).selected?.value ?? mark.values['reason']), evidence: mark.selectedAssertions.filter(row => row.property === 'state').flatMap(row => row.evidence), contested: selection.contested };
    }).sort((a,b) => byCodePoint(a.kind,b.kind));
  });
}

/** Uses the authenticated source. A different producer adds a rival assertion, never overwrites it. */
export async function assertApplicability(tx: SqlExecutor, contract: GraphContract, kind: string, state: Exclude<ApplicabilityState,'not-searched'>, reason: string, evidence: readonly EvidenceDraft[]): Promise<string> {
  return await withSpan('graph.applicability.assert', {'graph.kind':kind}, async () => {
    let now = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    if (reason.trim() === '' || evidence.length === 0) throw new Error(`${import.meta.path}:35: EVIDENCE_INVALID applicability requires what was searched and graph evidence`);
    const binding = requireWriteCapability(tx);
    const product: EntityRefDraft = { kind:'system.product',uid:binding.productUid,key:{} };
    const target: EntityRefDraft = { kind:'manifest.kind',key:{name:kind} };
    const draft: VertexDraft = { kind:KIND,key:{},keyEdges:{[product.kind]:product,kind:target},values:{reason},producer:binding.sourceUid,producerVersion:binding.contractVersion,evidence };
    await publishGraphDrafts(tx,contract,{vertices:[draft],edges:[],removals:[]});
    now = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    const kinds = await readKindAssertions(tx,'vertex','manifest.kind',['name']);
    const targetId = kinds.find(row => row.values['name'] === kind)?.id;
    const links = await readKindAssertions(tx,'edge','system.applicability-kind',[],{validAt:now,recordedAt:now});
    const marks = await readKindAssertions(tx,'vertex',KIND,[],{contract,validAt:now,recordedAt:now});
    const mark = marks.find(row => links.some(link => link.from === row.id && link.to === targetId));
    if (!mark) throw new Error(`${import.meta.path}:46: TARGET_MISSING applicability ${kind}`);
    return await writeAssertion(tx,contract,{sort:'vertex',kind:KIND,subjectId:String(mark.id),property:'state',operation:'assert',value:state,evidence});
  });
}

/** Derived assertions cite the exact ancestor assertion, never just a structural prerequisite. */
export async function cascadeApplicability(tx: SqlExecutor, contract: GraphContract, manifest: KindsManifest): Promise<void> {
  await withSpan('graph.applicability.cascade',{},async () => {
    const now = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    const binding = requireWriteCapability(tx);
    const marks = await readKindAssertions(tx,'vertex',KIND,['state','reason'],{contract,validAt:now,recordedAt:now});
    const kinds = await readKindAssertions(tx,'vertex','manifest.kind',['name']);
    const links = await readKindAssertions(tx,'edge','system.applicability-kind',[],{validAt:now,recordedAt:now});
    const byKind = new Map(marks.map(mark => [String(kinds.find(kind => kind.id === links.find(link => link.from === mark.id)?.to)?.values['name']),mark]));
    const absent = new Map<string,{id:string;reason:string}>();
    for (const [name,mark] of byKind) {
      const chosen = selectAssertions(mark.assertions.filter(row => row.property === 'state'),{validAt:now,recordedAt:now,contexts:[1]}).selected;
      // Derived marks are recalculated, not seeds of their own continuation.
      if (chosen?.value === 'inapplicable' && !mark.assertions.find(row => row.id === chosen.id)!.evidence.some(uid => marks.some(other => other.assertions.some(assertion => assertion.id === uid)))) absent.set(name,{id:chosen.id,reason:String(mark.values['reason'])});
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const kind of [...manifest.kinds.values()].sort((a,b) => byCodePoint(a.name,b.name))) {
        if (absent.has(kind.name)) continue;
        const parent = [...(kind.applicability?.dependencies ?? [])].sort(byCodePoint).find(name => absent.has(name));
        if (parent === undefined) continue;
        const ancestor = absent.get(parent)!;
        const reason = `Inapplicable because ${parent} is inapplicable: ${ancestor.reason}`;
        const id = await assertApplicability(tx,contract,kind.name,'inapplicable',reason,[{target:{kind:'system.assertion',uid:ancestor.id,key:{}}}]);
        absent.set(kind.name,{id,reason}); changed = true;
      }
    }
    for (const [kind,mark] of byKind) {
      if (absent.has(kind)) continue;
      for (const assertion of mark.assertions.filter(row => row.property === 'state' && row.source === binding.sourceUid && row.value === 'inapplicable' && row.evidence.some(uid => marks.some(other => other.assertions.some(a => a.id === uid))))) {
        await writeAssertion(tx,contract,{sort:'vertex',kind:KIND,subjectId:String(mark.id),property:'state',operation:'retract',evidence:assertion.evidence.map(uid => ({target:{kind:'system.assertion',uid,key:{}}}))});
        break;
      }
    }
  });
}

export async function storedApplicability(owner: import('../adapters/database-owner.js').DatabaseOwner, contract: GraphContract): Promise<KindApplicability[]> {
  return await withSpan('graph.applicability.stored',{},async () => await owner.run(tx => readApplicability(tx,contract)));
}

/** A positive observation cites the immutable existence assertion, not a mutable entity. */
export async function assertProducedApplicability(tx: SqlExecutor, contract: GraphContract, kind: string): Promise<void> {
  await withSpan('graph.applicability.instances',{},async () => {
    const now = (await tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
    const source = requireWriteCapability(tx).sourceUid;
    const records = await readKindAssertions(tx,'vertex',kind,[],{contract,validAt:now,recordedAt:now});
    const assertion = records.flatMap(record => record.selectedAssertions).find(row => row.property === '$exists' && row.source === source && row.value === true);
    if (assertion !== undefined) await assertApplicability(tx,contract,kind,'applicable','Producer found instances',[{target:{kind:'system.assertion',key:{},uid:assertion.id}}]);
  });
}

/** Terminal producer status cites its immutable outcome assertion as the searched scope. */
export async function assertOutcomeApplicability(tx: SqlExecutor, contract: GraphContract, outcome: import('../fill/producer-outcomes.js').ProducerOutcomeDraft, evidenceUid: string, scope: string): Promise<void> {
  // A completion never restates what the turn already stated: an inapplicable answer asserted its own mark with the
  // places it searched and the agent's evidence, and a stored inapplicable mark stays as the turn found it.
  if (outcome.outcome === 'inapplicable') return;
  await withSpan('graph.applicability.outcome', {}, async () => {
    const {readPublishedManifest} = await import('./manifest-publication.js');
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined || !manifest.kinds.has(outcome.kind)) return;
    const state = outcome.outcome === 'failed' || outcome.outcome === 'abstained' ? 'failed'
      : outcome.produced > 0 ? 'applicable' : 'empty';
    const reason = `Producer ${outcome.plugin}; searched ${scope}; outcome ${outcome.outcome}; ${outcome.produced} instances${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`;
    await assertApplicability(tx,contract,outcome.kind,state,reason,[{target:{kind:'system.assertion',uid:evidenceUid,key:{}}}]);
    await cascadeApplicability(tx,contract,manifest);
  });
}

export async function declareProducerScope(tx: SqlExecutor, contract: GraphContract, kind: string, plugin: string): Promise<void> {
  await withSpan('graph.applicability.scope', {}, async () => {
    const binding = requireWriteCapability(tx);
    const subject = (await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid',[binding.unitUid])).rows[0];
    if (subject === undefined) throw new Error(`${import.meta.path}:133: producer unit identity is missing`);
    for (const [property,value] of Object.entries({produced_kind:kind,producer:plugin})) await writeAssertion(tx,contract,{sort:'vertex',kind:'system.unit',subjectId:subject.id,property,operation:'assert',value});
  });
}

/** Guide-only adapter over the temporal graph's existing leased publication and durable outbox. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { GuideContext, GuideDiagnostic, GuideKind, GuideLocale } from './model.js';
import { GUIDE_OUTPUTS, type GuidePublicationRequest, type GuidePublicationResult } from './host-contract.js';
import { isCheckedGuide } from './validate.js';
import { renderGuideArtifact } from './artifact.js';
import { guideDigest, guideStepDigest, sameGuideContext } from './digest.js';
import { readGuideGraph, type GuidePreparedEvidence, type GuideWriterWiring } from './writer.js';
import { byCodePoint } from '../../model/order.js';

export interface GuidePublicationOwner extends GuideWriterWiring {
  readonly kind: GuideKind;
  readonly locale: GuideLocale;
  readonly context: GuideContext;
  readonly inputDigest: string;
  readonly unitVersion: string;
  readonly evidence: GuidePreparedEvidence;
  readonly verified: ReadonlySet<string>;
  readonly readMembership: string;
}
const ARTIFACT_KIND = 'guide-artifact';
const producerOf = (kind: GuideKind): string => `writer.${kind}`;
export async function createGuidePublication(owner: GuidePublicationOwner): Promise<(request: GuidePublicationRequest) => Promise<GuidePublicationResult>> {
  const output = GUIDE_OUTPUTS[owner.kind];
  const full = resolve(owner.output, output.path);
  const error = (code: string): GuidePublicationResult => {
    const diagnostic: GuideDiagnostic = { file: full, line: 1, path: '$.publication', code, message: `${full}:1: $.publication: checked publication refused (${code}); no generated ownership is inferred from front matter` };
    return { ok: false, diagnostics: [diagnostic] };
  };
  await owner.store.registerVocabulary({ kinds: [ARTIFACT_KIND], relations: [] });
  return async (request) => {
    const guide = request.guide;
    if (!isCheckedGuide(guide) || guide.id !== output.id || guide.kind !== owner.kind || guide.locale !== owner.locale || guide.inputDigest !== owner.inputDigest || guide.unitVersion !== owner.unitVersion || !sameGuideContext(guide.context, owner.context) || request.expectedInputDigest !== owner.inputDigest || request.expectedUnitVersion !== owner.unitVersion || !sameGuideContext(request.expectedContext, owner.context)) return error('authority-mismatch');
    if (request.artifact !== renderGuideArtifact(guide)) return error('canonical-artifact');
    for (const procedure of guide.procedures) for (const step of procedure.steps) if (!owner.verified.has(guideDigest({ document: guideDigest(guide), step: guideStepDigest(guide, procedure.id, step) }))) return error('semantic-proof');
    const producer = producerOf(owner.kind);
    const payload = { path: output.path, artifact: request.artifact, context: owner.context, inputDigest: owner.inputDigest, unitVersion: owner.unitVersion, locale: owner.locale, evidenceDigest: guideDigest(owner.evidence), evidence: owner.evidence, readMembership: owner.readMembership, verifiedSteps: [...owner.verified].sort(byCodePoint), status: 'proposed' };
    const digest = guideDigest(payload);
    const previous = await owner.owner.run(async (tx) => (await tx.query<{ artifact: string; payload: string; generation: string }>(
      `SELECT v.properties->>'artifact' AS artifact, v.properties->>'guidePayload' AS payload, w.generation::text AS generation FROM node_version v JOIN node_kind k ON k.id=v.kind_id JOIN work_item w ON w.id=v.opened_by WHERE v.producer=$1 AND v.scope_id=$2::bigint AND k.key=$3 AND w.published_at IS NOT NULL AND w.published_digest IS NOT NULL ORDER BY w.generation DESC, v.id DESC LIMIT 1`, [producer, owner.scope, ARTIFACT_KIND],
    )).rows[0]);
    // A generated marker is never ownership. Only prior actually published bytes authorize replacement.
    let before: string | undefined;
    try { const stat = await lstat(full); if (!stat.isFile() || stat.isSymbolicLink()) return error('unsafe-target'); before = await readFile(full,'utf8'); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
    if (before !== undefined && before !== previous?.artifact) return error('authored-conflict');
    let generation: number;
    let replay = previous?.payload === digest;
    if (replay) generation = Number(previous!.generation);
    else {
      const lease = randomUUID();
      const row = await owner.owner.run(async (tx) => (await tx.query<{ generation: string }>('SELECT COALESCE(max(generation),0)::text AS generation FROM work_item WHERE producer=$1 AND scope_id=$2::bigint', [producer, owner.scope])).rows[0]);
      generation = Number(row?.generation ?? 0) + 1;
      await owner.store.openWorkItem({ producer, scope: owner.scope, generation, inputDigest: owner.inputDigest, leaseToken: lease, leaseUntil: new Date(Date.now() + 10 * 60 * 1000) });
      // Re-read every exact pinned span before publication. New commits cannot replace these bytes.
      for (const span of owner.evidence.spans) {
        const reader = await owner.snapshots.open(span.ground.repository);
        if (reader.commit !== span.ground.commit) return error('source-pin-moved');
        const text = (await reader.readText(span.ground.path)).split('\n').slice(span.ground.line - 1, span.ground.endLine).join('\n');
        if (guideDigest({ ground: span.ground, text }) !== span.digest) return error('source-read-moved');
      }
      // The source graph is also rechecked at the exact prepared coordinates, empty rows included.
      const published = await owner.owner.transaction('write', async (tx) => {
        // Block a new knowledge publication between membership recheck and this publication.
        await tx.query('LOCK TABLE node_version, edge_version IN SHARE ROW EXCLUSIVE MODE');
        const membership = await readGuideGraph(owner, owner.context, true, tx);
        if (guideDigest([...membership.nodes, ...membership.edges]) !== owner.readMembership) return false;
        await owner.store.publish({ producer, scope: owner.scope, generation, inputDigest: owner.inputDigest, leaseToken: lease, nodes: [{ kind: ARTIFACT_KIND, label: output.id, validFrom: owner.context.valid, properties: { ...payload, guidePayload: digest } }] }, tx);
        return true;
      });
      if (!published) return error('graph-read-moved');
    }
    // Materialize only an actually published generation. A crash leaves a retryable outbox, not forged ownership.
    const root = resolve(owner.output);
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !full.startsWith(`${root}${sep}`)) return error('unsafe-root');
    let cursor = root;
    for (const part of output.path.split('/').slice(0, -1)) {
      cursor = join(cursor, part);
      try { await mkdir(cursor); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return error('unsafe-parent');
    }
    let working: string | undefined;
    try {
      if (!(await lstat(full)).isFile() || (await lstat(full)).isSymbolicLink()) return error('unsafe-target');
      working = await readFile(full, 'utf8');
    } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
    if (working !== undefined && working !== request.artifact && working !== previous?.artifact) return error('authored-conflict');
    if (working === request.artifact) return { ok: true, path: output.path, unchanged: true };
    const temporary = join(dirname(full), `.guide-${randomUUID()}.writing`);
    await writeFile(temporary, request.artifact, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      const materialized = await owner.owner.transaction('write', async (tx) => {
        await tx.query('LOCK TABLE work_item IN SHARE ROW EXCLUSIVE MODE');
        const latest = (await tx.query<{ generation: string }>('SELECT generation::text AS generation FROM work_item WHERE producer=$1 AND scope_id=$2::bigint AND published_at IS NOT NULL AND published_digest IS NOT NULL ORDER BY generation DESC LIMIT 1', [producer, owner.scope])).rows[0];
        if (Number(latest?.generation) !== generation) return false;
        let now: string | undefined;
        try { now = await readFile(full, 'utf8'); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
        if (now !== working) return false;
        await rename(temporary, full);
        return true;
      });
      if (!materialized) return error('outbox-superseded-or-edited');
      await owner.afterWrite?.(output.path);
      return { ok: true, path: output.path, unchanged: replay };
    } finally { await unlink(temporary).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== 'ENOENT') throw failure; }); }
  };
}

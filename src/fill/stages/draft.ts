/**
 * What the deterministic stages here do the same way: what a write cites as the
 * bytes it stands on, the provenance of a fact read from a pinned repository,
 * and the reading of a draft back against the schema before it is published.
 *
 * A `fact` write's value is a whole fact envelope (`makeNodeFact` /
 * `makeEdgeFact` of `src/fill/facts.ts`): the kind, the schema version, the id
 * its identity digests to, the provenance, the layer, the status and the
 * kind's own value. The write path of decision 0026 checks exactly that with
 * `checkFact`, and the id it checks is the one the fact store will hold, so a
 * stage writes nothing the schema has not read.
 */
import { checkFact, type FactProvenance } from '../facts.js';
import type { SnapshotReader } from '../snapshot.js';
import type { StageDraftSet, StageDraftWrite, StageValidation } from '../stage.js';

/** The provenance of a fact read from a pinned repository: git, the version it runs, and the commit. */
export function provenanceOf(reader: SnapshotReader): FactProvenance {
  return {
    source: { system: reader.source.system, version: reader.source.version },
    repository: { id: reader.repository, commit: reader.commit },
  };
}

/**
 * What one write stands on: the repository, the commit and, where the write is
 * about a place, that repository path — `orders-api@1f0c…:src/order.ts`. Never
 * a machine path and never a run: a reader of the draft can find the bytes the
 * write was read from at the commit it names.
 */
export function evidenceAt(reader: SnapshotReader, path?: string): string {
  const at = `${reader.repository}@${reader.commit}`;
  return path === undefined ? at : `${at}:${path}`;
}

/**
 * Reads a stage's draft back: every write is a fact the schema reads, of a kind
 * the stage declares it produces. Every error names the write it is about —
 * its place in the draft, what it cites, and the fact's own path and place —
 * so a refusal is one line a reader can act on. A draft that holds no write
 * passes: an empty fact set is how a stage retracts what an earlier run wrote
 * for a path the pinned commit no longer holds.
 */
export function checkFactDraft(
  stageId: string,
  kinds: readonly string[],
  draft: StageDraftSet,
  writeKinds: readonly StageDraftWrite['kind'][] = ['fact'],
): StageValidation {
  const errors: string[] = [];
  // How the refusal names what the stage writes: the deterministic stages write `fact` writes alone, and a stage
  // whose tools write entities, links and questions says so (madarch-tzte.22.3).
  const writesWord = writeKinds.length === 1 && writeKinds[0] === 'fact' ? 'facts' : `${writeKinds.join(', ')} writes`;
  draft.writes.forEach((write: StageDraftWrite, index: number) => {
    const at = `write ${index + 1} (${write.evidence})`;
    if (!writeKinds.includes(write.kind)) {
      errors.push(`${at}: the ${stageId} stage writes ${writesWord}, and a "${write.kind}" write is not one`);
      return;
    }
    const problems = checkFact(write.value);
    const kind = write.value !== null && typeof write.value === 'object' ? (write.value as { kind?: unknown }).kind : undefined;
    if (typeof kind === 'string' && !kinds.includes(kind)) {
      errors.push(`${at}: the ${stageId} stage does not produce a "${kind}" fact: it produces ${kinds.join(', ')}`);
    }
    if (kind === undefined) {
      errors.push(`${at}: the ${stageId} stage writes facts, and this write names no kind: a fact's value is its whole envelope, kind and id included`);
    }
    for (const problem of problems) {
      const from = problem.path === '' ? '' : `${problem.path}: `;
      const where = problem.file === undefined ? '' : `${problem.file}:${problem.line ?? 1} `;
      errors.push(`${at}: ${where}${from}${problem.message}`);
    }
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Stage 0 of the fill (decision 0026): the snapshot stage pins the code
 * repositories and the product repository the run fills, and writes what it
 * pinned as facts — one `snapshot` node per repository at the commit it was
 * read at, one `repository` node per repository, and one `coverage` node per
 * repository saying what the tree of that commit did not let the reader read.
 *
 * A unit is one repository: the stage plans one unit per pinned repository, in
 * code point order of their ids (the source reads the pins, so where the pins
 * come from — the product's manifest, its `repos/` — is the wiring's business
 * and not this stage's). A unit writes three facts and no more, and the tree it
 * read is read once, when the reader opens.
 *
 * Ids come from `src/fill/facts.ts`: the same repository at the same commit has
 * one `snapshot` id on every machine and in every run, and the coverage node
 * stands for the reader (`git`), so two readers of one repository are two
 * coverages that add up rather than overwrite one another.
 */
import { Type } from 'typebox';
import { FACT_KINDS, makeNodeFact, type Fact, type FactProvenance } from '../facts.js';
import type { SnapshotReader, SnapshotSource } from '../snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageContext, type StageExecutionResult, type StagePlan, type StageUnit } from '../stage.js';
import { checkFactDraft, evidenceAt, provenanceOf } from './draft.js';

/** The stage's id, as it is registered and as its units are named. */
export const SNAPSHOT_STAGE_ID = 'snapshot';

/** The stage's own version, bumped when what it writes changes. */
export const SNAPSHOT_STAGE_VERSION = 1;

/**
 * The fact kinds the stage produces, in code point order: the pinned tree, the
 * repository it belongs to, and the coverage of that reading.
 */
export const SNAPSHOT_STAGE_KINDS: readonly string[] = ['coverage', 'repository', 'snapshot'];

/**
 * The stage, built over the source that holds the run's pins. `plan` reads the
 * pins (a run that pins nothing plans nothing, and says so with
 * `nothing-found`), and each unit writes the facts of the repository it names.
 */
export function createSnapshotStage(sources: SnapshotSource): FillStage {
  return {
    id: SNAPSHOT_STAGE_ID,
    version: SNAPSHOT_STAGE_VERSION,
    // Stage 0 reads no other stage's facts: the pins come from the run, and
    // what the tree says is read from the repository itself.
    consumes: { required: [], optional: [] },
    produces: [
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'repository' },
      { kind: 'repository', schemaVersion: FACT_KINDS['repository'].version, scope: 'repository' },
      { kind: 'snapshot', schemaVersion: FACT_KINDS['snapshot'].version, scope: 'repository' },
    ],
    // The pins are the run's, not the product's configuration: a product cannot
    // configure which commit it stands on.
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (): Promise<StagePlan> => {
      const pins = await sources.pins();
      if (pins.length === 0) {
        // The run pinned no repository at all: "no producer" from "producer
        // found nothing" — nothing was there to pin.
        return { units: [], coverage: 'nothing-found' };
      }
      return { units: pins.map((pin) => ({ id: pin.id, scope: pin.id })), coverage: 'planned' };
    },
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => {
      refuseWhenCancelled(unit, context);
      const reader = await sources.open(unit.scope);
      refuseWhenCancelled(unit, context);
      const provenance = provenanceOf(reader);
      for (const fact of factsFor(reader, provenance)) {
        // The evidence of a fact about a whole repository is the repository at
        // the commit: the tree it was read from, no path of the tree in it.
        context.draft.write({ kind: 'fact', evidence: evidenceAt(reader), value: fact });
      }
      context.progress(
        `read the tree of ${reader.repository} at ${reader.commit}: ${reader.fileCount} ${reader.fileCount === 1 ? 'file' : 'files'}, ${reader.byteCount} bytes`,
        1,
      );
      return { outcome: 'draft' };
    },
    validate: (draft) => checkFactDraft(SNAPSHOT_STAGE_ID, SNAPSHOT_STAGE_KINDS, draft),
  };
}

/**
 * What one pinned repository's reading writes, in code point order of the
 * kinds: the coverage of the reading, the repository node and the snapshot
 * node. The coverage names the repository node as the scope it read, so a
 * reader of the graph finds the coverage and what it covers without a second
 * lookup; a tree the reader read whole carries no gap, and a submodule's commit
 * (whose tree stands in the repository it names) is named as what could not be
 * read here.
 */
function factsFor(reader: SnapshotReader, provenance: FactProvenance): readonly Fact[] {
  const repository = reader.repository;
  const repositoryFact = makeNodeFact({
    kind: 'repository',
    value: { repository, form: reader.form, ...(reader.defaultBranch === undefined ? {} : { defaultBranch: reader.defaultBranch }) },
    provenance,
    layer: 'extracted',
  });
  const snapshotFact = makeNodeFact({
    kind: 'snapshot',
    value: {
      repository,
      commit: reader.commit,
      tree: reader.tree,
      fileCount: reader.fileCount,
      byteCount: reader.byteCount,
    },
    provenance,
    layer: 'extracted',
  });
  const entries = reader.entries();
  const read = [...new Set(entries.filter((entry) => entry.form !== 'commit').map((entry) => entry.form))].sort();
  const unread = entries
    .filter((entry) => entry.form === 'commit')
    .map((entry) => ({ what: entry.path, reason: 'unsupported' as const }));
  const coverageFact = makeNodeFact({
    kind: 'coverage',
    value: {
      repository,
      scope: repositoryFact.id,
      complete: unread.length === 0,
      read: read.length === 0 ? [] : read,
      unread,
    },
    provenance,
    layer: 'extracted',
  });
  return [coverageFact, repositoryFact, snapshotFact];
}

/**
 * A cancelled unit stops where it stands, and a unit that has read nothing is
 * no draft: the publication of an empty fact set retracts what the unit wrote
 * before, which a cancellation must never do in silence. So the unit raises,
 * and the run's own cancellation is what accounts for it.
 */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned repository: a cancelled unit publishes nothing`);
  }
}

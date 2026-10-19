/**
 * What the fact store must answer, taken from the task (madarch-tzte.20.2) and
 * from the decisions it stands on — 0026 ("Every write is checked at once … and
 * lands in the unit's draft set, visible to other units as draft. A unit that
 * ends well is published in one transaction; a failed or rerun unit's set is
 * retracted"), and 0027 ("a unit's publication replaces only that unit's facts,
 * never a whole source's"). One list, held by both engines' tests
 * (`test/fill-fact-store.test.ts` on PGlite and
 * `test/fill-fact-store-postgres.test.ts` on PostgreSQL): the scenario reports
 * what it saw and this judges it, so the two engines cannot drift apart.
 */
import { expect } from 'bun:test';
import type { Fact } from '../src/fill/facts.js';
import { byCodePoint } from '../src/model/order.js';
import type { FactStoreScenarioReport, ScenarioFacts } from './fill-fact-store-scenario.js';

/** One check: what it is called, and what it holds the store to. */
export interface FactStoreCheck {
  readonly name: string;
  readonly check: (report: FactStoreScenarioReport) => void;
}

/** The checks, in the order the task's DONE WHEN states them. */
export function factStoreChecks(facts: ScenarioFacts): readonly FactStoreCheck[] {
  const ids = (...named: readonly Fact[]): string[] => named.map((fact) => fact.id).sort(byCodePoint);
  // The edge both units write is one fact: its count is not an identity part, so the two writers compute one id.
  const call = facts.callEdgeOfA.id;
  const bCount = (facts.callEdgeOfB.value as { readonly count?: number }).count ?? -1;
  return [
    {
      name: 'a unit holds exactly the facts its publication wrote, in code point order of their ids',
      check: (report) => expect(report.aHoldsAfterFirst).toEqual(ids(facts.symbolOne, facts.symbolTwo, facts.callEdgeOfA)),
    },
    {
      name: 'a fact two units publish keeps one row, with both publishers named in code point order',
      check: (report) => {
        expect(report.aHoldsAfterFirst).toContain(call);
        expect(report.bHoldsAfterFirst).toContain(call);
        expect(report.sharedRows).toBe(1);
        expect(report.sharedPublishers).toEqual(['unit-a', 'unit-b']);
      },
    },
    {
      name: 'the row of a fact two units publish keeps the envelope of the publication that stored it first',
      check: (report) => expect(report.sharedCountStored).toBe(bCount),
    },
    {
      name: 'a measured field is what a later publication replaces, and every other field keeps the first publication\'s row',
      check: (report) => {
        expect(report.rankAfterFirst).toBe(0.5);
        // The second publication of one id carries another rank and another member count: both are stage 5's
        // measurements of the cluster over the whole repository (0026's "importance by PageRank"), so a
        // re-clustering must move them, and every field that is no measurement keeps the first row's
        // (madarch-tzte.20.2's rule for what an identity does not read).
        expect(report.rankAfterSecond).toBe(0.25);
        expect(report.membersAfterSecond).toBe(5);
        // A publication that carries no rank changes nothing it did not measure: the rank the row holds
        // stands, and the size the publication does carry moves.
        expect(report.rankAfterUnranked).toBe(0.25);
        expect(report.membersAfterUnranked).toBe(3);
      },
    },
    {
      name: 'a rank a second stage measures lands on the fact the first stage published, and the row keeps that reader',
      check: (report) => {
        // Stage 1's unit published the file fact; a modules unit then wrote stage 5's rank onto the same
        // id, and a later generation of that unit carried no rank at all. The rank the second stage measured
        // lands, the rank it did not name stands, and the row still cites the reader that read the bytes.
        expect(report.fileRankBeforeRanked).toBe(-1);
        expect(report.fileRankAfterRanked).toBe(0.75);
        expect(report.fileRankAfterPlain).toBe(0.75);
        // The modules publication carries the stage's own reader (`fill-stage-5`), so the CASE that moves a
        // row's provenance for the reader that already cites it does not fire here: the file row keeps the
        // reader that read the bytes.
        expect(report.fileProvenanceReader).toBe('tree-sitter');
      },
    },
    {
      name: 'a stage that measures a row again at a later commit moves the commit the row cites with it',
      check: (report) => expect(report.commitAfterReread).toBe('b'.repeat(40)),
    },
    {
      name: 'republishing two of a unit\'s three facts leaves exactly those two for that unit',
      check: (report) => {
        expect(report.aHoldsAfterFirst).toHaveLength(3);
        expect(report.aHoldsAfterSecond).toEqual(ids(facts.symbolOne, facts.symbolTwo));
      },
    },
    {
      name: 'a unit\'s publication replaces only its own facts: another unit\'s are untouched',
      check: (report) => expect(report.bHoldsAfterASecond).toEqual(ids(facts.callEdgeOfB, facts.moduleB)),
    },
    {
      name: 'a fact another unit still holds keeps its row and loses only the publisher that dropped it',
      check: (report) => {
        expect(report.sharedRowsAfterADroppedIt).toBe(1);
        expect(report.sharedPublishersAfterADroppedIt).toEqual(['unit-b']);
      },
    },
    {
      name: 'a fact is removed once neither unit holds it',
      check: (report) => {
        expect(report.droppedFact).toBeNull();
        expect(report.factRows).toBe(3);
      },
    },
    {
      name: 'a draft set is readable as draft, with the facts it would publish',
      check: (report) => {
        expect(report.draftWrites).toBe(1);
        expect(report.draftFacts).toEqual([facts.draftFact.id]);
      },
    },
    {
      name: 'a draft\'s facts are not published facts',
      check: (report) => {
        expect(report.draftUnitHolds).toEqual([]);
        expect(report.draftFactPublished).toBe(false);
      },
    },
    {
      name: 'a retracted draft leaves nothing: nothing to read as draft, and nothing published',
      check: (report) => {
        expect(report.retractedDraft).toBe(true);
        expect(report.retractedPublicationCode).toBe('fill-publication/no-draft');
        expect(report.retractedUnitHolds).toEqual([]);
      },
    },
    {
      name: 'a published generation\'s draft set is not readable as draft, and its facts are published',
      check: (report) => {
        expect(report.publishedDraftReadable).toBe(false);
        expect(report.publishedDraftUnitHolds).toEqual([facts.publishedDraftFact.id]);
      },
    },
    {
      name: 'a write the schema does not read refuses the publication, naming the write, the file, the line and the path',
      check: (report) => {
        expect(report.invalidWriteRefusal).toContain('src/fill/fact-store.ts:');
        expect(report.invalidWriteRefusal).toContain('the draft set of unit "unit-invalid-write" generation 1 holds 1 write that is not a fact of the schema');
        expect(report.invalidWriteRefusal).toContain('write 2 (kind "fact") at src/cart.ts:1 id:');
        expect(report.invalidWriteRefusal).toContain('is not the id of this fact');
      },
    },
    {
      name: 'nothing of a refused publication stands: no fact, no record, and the generation is still validating',
      check: (report) => {
        expect(report.invalidWriteUnitHolds).toEqual([]);
        expect(report.invalidWritePublication).toBe(false);
        expect(report.invalidWriteState).toBe('validating');
        expect(report.invalidWriteStillDraft).toBe(2);
      },
    },
    {
      name: 'every write kind publishes the fact it carries',
      check: (report) => expect([...report.storedKinds]).toEqual(['call', 'entity-proposal', 'question', 'symbol']),
    },
    {
      name: 'the publishers of one fact come back in code point order, whatever the database collates',
      check: (report) => {
        // `Unit-case` sorts before `unit-case` in code point order, and after it under the collation of
        // CI's PostgreSQL; both reads answer this store's own order.
        expect(report.casePublishersOfTheUnit).toEqual(['Unit-case', 'unit-case']);
        expect(report.casePublishersOfTheFact).toEqual(['Unit-case', 'unit-case']);
      },
    },
    {
      name: 'the refusal counts the writes it refuses, and names the problems behind them',
      check: (report) => {
        // One write, three refusals of the schema: it is one write that is not a fact, with three problems.
        expect(report.manyProblemsRefusal).toContain('the draft set of unit "unit-many-problems" generation 1 holds 1 write that is not a fact of the schema (3 problems)');
        expect(report.manyProblemsRefusal).toContain('id:');
        expect(report.manyProblemsRefusal).toContain('value.repository:');
        expect(report.manyProblemsRefusal).toContain('value.name:');
      },
    },
    {
      name: 'a write whose kind is none of the four is refused by name, whatever the string names',
      check: (report) => {
        for (const refusal of report.unknownKindRefusals) {
          expect(refusal).toContain('is no write kind: a draft write is a fact, an entity, a link or a question');
          expect(refusal).not.toContain('TypeError');
        }
      },
    },
    {
      name: 'a write whose fact is not the kind that write writes is refused by name',
      check: (report) => {
        expect(report.wrongKindRefusal).toContain('an "entity" write writes an "entity-proposal" fact, and this one is a "module" fact');
        expect(report.wrongKindUnitHolds).toEqual([]);
      },
    },
    {
      name: 'a publication whose draft set is empty stores nothing and holds nothing',
      check: (report) => {
        expect(report.emptyPublicationHolds).toEqual([]);
        expect(report.emptyPublicationFacts).toBe(0);
      },
    },
    {
      name: 'a unit that publishes nothing replaces its own earlier facts with none',
      check: (report) => {
        expect(report.emptiedUnitHolds).toEqual([]);
        expect(report.emptiedFactGone).toBe(true);
        expect(report.emptiedPublicationFacts).toBe(0);
      },
    },
    {
      name: 'a folder unit\'s publication replaces its own facts and no other folder\'s directory or contains facts',
      check: (report) => {
        expect(report.folderAfterItsSecond).toEqual(ids(facts.folderDirectory));
        expect(report.otherFolderAfterTheFirstsSecond).toEqual(ids(facts.otherFolderDirectory, facts.otherFolderFile, facts.otherFolderContains));
        expect(report.otherFolderFactsStillThere).toEqual([true, true]);
      },
    },
  ];
}

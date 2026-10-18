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
  ];
}

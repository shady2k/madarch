import { describe, expect, test } from 'bun:test';
import { canonicalAssertionValue, applySemanticResolution, candidateFingerprint, resolutionMatches, selectAssertions, type AssertionRow } from '../src/graph/assertion-selection.js';

const at = '2026-11-15T00:00:00.000Z';
const before = '2026-11-14T00:00:00.000Z';
const after = '2026-11-16T00:00:00.000Z';
const row = (changes: Partial<AssertionRow> = {}): AssertionRow => ({
  id: 'a', subject: { type: 'vertex', uid: 'subject' }, property: 'name', context: 1, language: 'en', source: 'source-a',
  value: 'one', operation: 'assert', validFrom: before, validTo: null, recordedAt: before, recordedSequence: 1n, ...changes,
});
const options = { validAt: at, recordedAt: at, contexts: [2, 1] };

describe('source assertions (0039 items 25–27)', () => {
  test('recorded cutoff preserves knowledge and valid intervals are half open', () => {
    const initial = row();
    const correction = row({ id: 'b', value: 'two', recordedAt: after, recordedSequence: 2n });
    expect(selectAssertions([initial, correction], options).selected?.value).toBe('one');
    expect(selectAssertions([initial, correction], { ...options, recordedAt: after }).selected?.value).toBe('two');
    expect(selectAssertions([row({ validTo: at })], options).selected).toBeNull();
    expect(selectAssertions([row({ validFrom: at })], options).selected?.value).toBe('one');
    expect(selectAssertions([row({ validTo: after })], options).selected?.value).toBe('one');
    expect(selectAssertions([row({ validFrom: after })], options).selected).toBeNull();
  });
  test('an inherited layer stops at its branch snapshot without limiting local history', () => {
    const inherited = row({ recordedAt: before });
    const newerParent = row({ id: 'parent-new', recordedAt: before, recordedSequence: 2n, value: 'parent-new' });
    const local = row({ id: 'local', source: 'source-b', context: 2, recordedAt: at, recordedSequence: 3n, value: 'local' });
    const selected = selectAssertions([inherited, newerParent, local], { ...options, recordedAt: after, contextRecordedThrough: { 1: '1', 2: null } });
    expect(selected.candidates.map((one) => one.id)).toEqual(['local', 'a']);
    expect(selected.contested).toBe(true);
  });
  test('a branch cutoff cannot extend the query recorded cutoff', () => {
    const old = row();
    const later = row({ id: 'later', recordedAt: after, recordedSequence: 2n, value: 'later' });
    expect(selectAssertions([old, later], { ...options, contextRecordedThrough: { 1: '999' } }).selected?.id).toBe('a');
    expect(() => selectAssertions([old], { ...options, contextRecordedThrough: { 1: 'not-a-sequence' } })).toThrow();
  });
  test('latest source history replaces rather than disputes its older value', () => {
    const result = selectAssertions([row(), row({ id: 'b', value: 'two', recordedSequence: 2n })], options);
    expect(result.selected?.value).toBe('two');
    expect(result.candidates).toHaveLength(1);
    expect(result.contested).toBe(false);
    expect(selectAssertions([row({ id: 'new', value: 'new', recordedSequence: 3n }), row()], options).selected?.value).toBe('new');
  });
  test('a retraction removes only its own source stream', () => {
    const result = selectAssertions([row(), row({ id: 'b', operation: 'retract', value: undefined, recordedSequence: 2n }), row({ source: 'source-b', value: 'other' })], options);
    expect(result.selected?.value).toBe('other');
    expect(result.candidates).toHaveLength(1);
  });
  test('nearest context retraction masks the inherited stream without touching another source', () => {
    const result = selectAssertions([row(), row({ context: 2, operation: 'retract', value: undefined }), row({ source: 'source-b', value: 'other' })], options);
    expect(result.selected?.value).toBe('other');
    expect(result.candidates).toHaveLength(1);
    expect(selectAssertions([row(), row({ context: 2, value: 'future', validFrom: after })], options).selected).toBeNull();
  });
  test('newest valid start wins before recorded sequence, disagreement remains visible', () => {
    const result = selectAssertions([row({ value: 'older-valid', recordedSequence: 99n }), row({ id: 'z', source: 'source-b', validFrom: at, value: 'current-valid', recordedSequence: 2n })], options);
    expect(result.selected?.value).toBe('current-valid');
    expect(result.contested).toBe(true);
    expect(selectAssertions([row({ source:'b',validFrom:at,value:'new' }), row({ source:'a',value:'old' })], options).selected?.value).toBe('new');
    expect(selectAssertions([row({ source: 'source-a', id: 'z', value: 'old', recordedSequence: 99n }), row({ source: 'source-b', id: 'a', value: 'new', validFrom: at })], options).selected?.value).toBe('new');
    expect(selectAssertions([row(), row({ id: 'b', source: 'source-b' })], options).contested).toBe(false);
  });
  test('sequence and uid break ties without source authority', () => {
    expect(selectAssertions([row({ id: 'z' }), row({ id: 'a', source: 'person', recordedSequence: 2n })], options).selected?.id).toBe('a');
    expect(selectAssertions([row({ id: 'a' }), row({ id: 'z', source: 'other' })], options).selected?.id).toBe('z');
  });
  test('candidate matching ignores execution ids but notices semantic changes and evidence invalidation', () => {
    const segment = { from: before, to: at };
    const pin = candidateFingerprint(row(), segment);
    const repeat = candidateFingerprint(row({ id: 'new-pass', recordedSequence: 999n }), segment);
    expect(resolutionMatches([pin], [repeat], true)).toBe(true);
    for (const changed of [row({ source: 'new-source' }), row({ value: 'changed' }), row({ operation: 'retract', value: undefined })]) {
      expect(resolutionMatches([pin], [candidateFingerprint(changed, segment)], true)).toBe(false);
    }
    expect(resolutionMatches([pin], [candidateFingerprint(row(), { from: before, to: null })], true)).toBe(false);
    expect(resolutionMatches([pin], [repeat], false)).toBe(false);
    expect(resolutionMatches([pin], [{ tuple: 'different', digest: pin.digest }], true)).toBe(false);
    expect(resolutionMatches([pin], [], true)).toBe(false);
    expect(resolutionMatches([], [pin], true)).toBe(false);
    const second = candidateFingerprint(row({ source: 'second', value: 'two' }), segment);
    expect(resolutionMatches([pin, second], [pin, { ...second, tuple: 'zzzz' }], true)).toBe(false);
    expect(resolutionMatches([pin, second], [second, pin], true)).toBe(true);
    expect(resolutionMatches([{tuple:'a',digest:'a'}, {tuple:'b',digest:'a'}], [{tuple:'b',digest:'a'}, {tuple:'a',digest:'a'}], true)).toBe(true);
    expect(resolutionMatches([pin, second], [pin, { ...second, tuple: 'different' }], true)).toBe(false);
    expect(resolutionMatches([pin], [{ ...pin, digest: 'different' }], true)).toBe(false);
    expect(resolutionMatches([{tuple:'a',digest:'a'}, {tuple:'z',digest:'z'}], [{tuple:'a',digest:'a'}, {tuple:'zz',digest:'z'}], true)).toBe(false);
    expect(resolutionMatches([{tuple:'a',digest:'z'}, {tuple:'b',digest:'a'}], [{tuple:'a',digest:'z'}, {tuple:'b',digest:'a'}], true)).toBe(true);
  });
});

describe('RFC 8785 typed candidates', () => {
  test('property names use UTF-16 ordering and ECMAScript finite number serialization', () => {
    expect(canonicalAssertionValue({ '\ue000': 1, '😀': 2 })).toBe('{"😀":2,"\ue000":1}');
    expect(canonicalAssertionValue([1e30, 4.5, -0, 2e-3])).toBe('[1e+30,4.5,0,0.002]');
    expect(canonicalAssertionValue({ b: true, a: null })).toBe('{"a":null,"b":true}');
  });
  test('rejects non-JSON and invalid Unicode rather than silently canonicalizing smaller input', () => {
    for (const value of [NaN, Infinity, undefined, '\ud800', '\udfff', new Date(), new Array(1), { missing: undefined }]) {
      expect(() => canonicalAssertionValue(value)).toThrow();
    }
    expect(canonicalAssertionValue('😀')).toBe('"😀"');
  });
});

test('semantic resolution changes effective selection only while all pins and justification match',()=>{
 const older=row({id:'older',source:'a',value:'chosen'}),newer=row({id:'newer',source:'b',value:'newest',recordedSequence:2n});
 const selection=selectAssertions([older,newer],options),segment={from:before,to:null};
 const resolution={pins:selection.candidates.map(value=>candidateFingerprint(value,segment)),segment,chosenSource:'a',chosenValue:'chosen',evidenceValid:true};
 expect(applySemanticResolution(selection,resolution).selected?.id).toBe('older');expect(applySemanticResolution(selection,resolution).contested).toBe(false);
 for(const invalid of [null,{...resolution,evidenceValid:false},{...resolution,chosenSource:'missing'},{...resolution,chosenValue:'changed'},{...resolution,pins:[]}]){
  expect(applySemanticResolution(selection,invalid)).toEqual(selection);
 }
});

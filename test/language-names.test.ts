/**
 * A language's name comes from the classifier's own declaration (madarch-u3vw.15): the dataset the tree pass
 * classifies with states each language and its group, and the page reads that name, never a list of ours.
 */
import { describe, expect, test } from 'bun:test';
import * as languages from 'linguist-languages';
import { languageDisplayName, languageWords, opinionLanguageCandidates } from '../src/knowledge/language-names.js';

const declared = (name: string): string => (languages as unknown as Record<string, { readonly name: string }>)[name]!.name;

describe('a language name as the classifier declares it', () => {
  test('a variant reads as the umbrella name its declaration groups it under', () => {
    expect(languageDisplayName('OASv2-json')).toBe(declared('OpenAPI Specification v2'));
    expect(languageDisplayName('OASv3-json')).toBe(declared('OpenAPI Specification v3'));
  });

  test('a language whose group is itself detected keeps its own name', () => {
    expect(languageDisplayName('TSX')).toBe(declared('TSX'));
    expect(languageDisplayName('JSON with Comments')).toBe(declared('JSON with Comments'));
    expect(languageDisplayName('TypeScript')).toBe(declared('TypeScript'));
  });

  test('a name the dataset does not declare reads as it stands', () => {
    expect(languageDisplayName('a language no dataset holds')).toBe('a language no dataset holds');
  });
});

describe('one file language claim in words', () => {
  test('an undetermined answer lists its candidates by their declared names', () => {
    expect(languageWords('ambiguous', ['JSON', 'OASv2-json', 'OASv3-json'])).toEqual({
      name: null,
      candidates: ['JSON', declared('OpenAPI Specification v2'), declared('OpenAPI Specification v3')],
      undetermined: true,
    });
  });

  test('a resolved language reads as its one name', () => {
    expect(languageWords('TypeScript', ['TypeScript'])).toEqual({ name: 'TypeScript', candidates: ['TypeScript'], undetermined: false });
  });

  test('a name no rule matched reads as no language at all', () => {
    expect(languageWords('unknown', ['unknown'])).toEqual({ name: null, candidates: [], undetermined: false });
    expect(languageWords(null, [])).toEqual({ name: null, candidates: [], undetermined: false });
  });

  test('several open opinions name every candidate, never one of them picked', () => {
    expect(opinionLanguageCandidates([
      { values: { lang: 'TypeScript', languages: ['TypeScript'] } },
      { values: { lang: 'JavaScript', languages: ['JavaScript'] } },
    ])).toEqual(['JavaScript', 'TypeScript']);
    expect(languageWords(null, opinionLanguageCandidates([{ values: { lang: null, languages: ['TypeScript', 'XML'] } }])))
      .toEqual({ name: null, candidates: ['TypeScript', 'XML'], undetermined: true });
  });
});

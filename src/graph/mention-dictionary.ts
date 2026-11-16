/** Decision 0039 items 6 and 29: the dictionary a plain name is answered with, names plus their synonyms. */
import { SYNONYMS_FIELD, type GraphContract } from './contract.js';
import type { KindsManifest, KindDecl } from '../product/manifest/kinds.js';
import { readKindAssertions } from './records.js';
import type { MentionCandidate, MentionName } from './mention-text.js';
import type { SqlExecutor } from '../sql-driver.js';

/**
 * Decision 0039 item 6: the hint dictionary is every entity's name and its synonyms, where a name is the field the kind
 * names as its label. A same-named entity of another kind stays another candidate, and a candidate carries its kind's
 * label beside its kind's name so a person sees «Payments — domain», not two bare words.
 */
export async function mentionDictionary(tx: SqlExecutor, manifest: KindsManifest, contract: GraphContract, cutoff: string): Promise<MentionName[]> {
  const dictionary = new Map<string, MentionCandidate[]>();
  for (const kind of manifest.kinds.values()) {
    const vertex = contract.vertex.find(candidate => candidate.name === kind.name);
    const labelField = kind.naming === undefined ? kind.title : kind.naming.label;
    if (vertex === undefined || !vertex.fields.some(field => field.name === labelField && field.type === 'text')) continue;
    const kindLabel = kindLabelOf(manifest, kind);
    const namingFields = [...new Set([labelField, SYNONYMS_FIELD, kind.naming?.domain].filter((field): field is string => field !== undefined))];
    const records = await readKindAssertions(tx, 'vertex', kind.name, namingFields, { contract, validAt: cutoff, recordedAt: cutoff });
    for (const record of records) {
      const values = record.values;
      const label = values[labelField];
      if (typeof label !== 'string' || label.length === 0) continue;
      const domain = kind.naming?.domain === undefined ? '' : values[kind.naming.domain];
      const synonyms = values[SYNONYMS_FIELD];
      const candidate = { uid: record.uid, kind: kind.name, kindLabel, label, domain: typeof domain === 'string' ? domain : '' };
      for (const name of new Set([label, ...(Array.isArray(synonyms) ? synonyms.filter((one): one is string => typeof one === 'string') : [])])) {
        if (name.length === 0) continue;
        const candidates = dictionary.get(name) ?? [];
        candidates.push(candidate);
        dictionary.set(name, candidates);
      }
    }
  }
  for (const candidates of dictionary.values()) candidates.sort((left, right) => compareCodePoints(`${left.uid}`, `${right.uid}`)
    || compareCodePoints(left.kind, right.kind) || compareCodePoints(left.label, right.label) || compareCodePoints(left.domain ?? '', right.domain ?? ''));
  return [...dictionary].map(([name, candidates]) => ({ name, candidates }));
}

/** The kind's own name for a reader, in the product's language, else English, else the kind's key. */
export function kindLabelOf(manifest: KindsManifest, kind: KindDecl): string {
  const labels = kind.labels;
  if (labels === undefined) return kind.name;
  const language = manifest.language ?? 'en';
  return labels[language]?.one ?? labels['en']?.one ?? [...Object.keys(labels)].sort(compareCodePoints).map((one) => labels[one]!.one)[0] ?? kind.name;
}

export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, char => char.codePointAt(0)!);
  const b = Array.from(right, char => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

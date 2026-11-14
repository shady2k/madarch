/** Compatibility views of the repository-owned YAML catalogue. */
import { stringify } from 'yaml';
import { parseCatalogYaml } from '../product/manifest/kinds.js';
import { CATALOG_FILES } from './catalog-assets.js';
import { byCodePoint } from '../model/order.js';
import type { DefinitionForm, ErForm, HistoryShape, KindView, ListingForm, NavTrait, SequenceForm, SystemPart } from '../product/manifest/kinds.js';

/** The two levels of the catalog: an area, and a subgroup of an area. */
export interface CatalogGroupData {
  readonly name: string;
  /** The group's full name per interface language: what a page and the catalogue call it. */
  readonly en: string;
  readonly ru: string;
  /** The navigation's short label per interface language: one or two words, inside the sidebar's column. */
  readonly shortEn: string;
  readonly shortRu: string;
  /** The area the subgroup belongs to; absent for an area. */
  readonly parent?: string;
  /** Whether the navigation opens the area by itself (an area only). */
  readonly open?: boolean;
}

/** One kind of the catalog: the row every catalog kind declares, and the page fields a shown kind adds. */
export interface CatalogKindData {
  readonly name: string;
  /** The canonical concept id: one concept has one kind. */
  readonly id: string;
  /** The subgroup the kind belongs to. */
  readonly group: string;
  readonly definition: string;
  /** The addresses of the standards or documents the kind was taken from. */
  readonly sources: readonly string[];
  /** `extractor <id>`, or one of the catalog's origin marks. */
  readonly acquisition: readonly string[];
  readonly status: 'implemented' | 'partial' | 'not-implemented';
  readonly out: readonly string[];
  readonly into: readonly string[];
  readonly policy: 'page' | 'member' | 'none';
  readonly source?: 'graph' | 'markdown' | 'document';
  readonly origin?: 'agent' | 'person' | 'code' | 'history';
  readonly en?: readonly [string, string];
  readonly ru?: readonly [string, string];
  readonly describe?: readonly [string, string];
  readonly extra?: readonly string[];
  readonly details?: readonly string[];
  /** A ground on one of the kind's entities shows its card, not its code (`card: true` of the kind's declaration). */
  readonly card?: true;
  /** The shape of the story the history block tells of the kind (`history:` of the kind's declaration). */
  readonly history?: HistoryShape;
  /** The views a page of the kind may draw of its entities (`views:` of the kind's declaration). */
  readonly views?: readonly KindView[];
  /** How the ER view reads the kind's entities (`er:` of the kind's declaration). */
  readonly er?: ErForm;
  /** How the chain a page draws starts at the kind's entities (`sequence:` of the kind's declaration). */
  readonly sequence?: SequenceForm;
  /** The part the kind's entities play in the system view (`system:` of the kind's declaration). */
  readonly system?: SystemPart;
  /** What the definition block finds in the kind's entities (`definition-block:` of the kind's declaration). */
  readonly definitionBlock?: DefinitionForm;
  /** The form the kind's listing page takes (`listing:` of the kind's declaration). */
  readonly listing?: ListingForm;
  /** Where the kind stands in the navigation (`nav:` of the kind's declaration). */
  readonly nav?: NavTrait;
  /** The capability that fills the kind (`capability:` of the kind's declaration). */
  readonly capability?: 'git';
  /** The kind's contract: its typed fields, its natural key and the kinds its discovery depends on. */
  readonly fields?: readonly ContractFieldData[];
  readonly key?: readonly string[];
  readonly derivesFrom?: readonly string[];
}

/** One typed field of a starter kind's contract. */
export interface ContractFieldData {
  readonly name: string;
  readonly type: 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json';
  readonly nullable?: boolean;
  readonly producers?: readonly string[];
  readonly reference?: string;
  /**
   * The producer the field is bound to (decision 0035, item 17): a plugin field
   * (`glossary@1.definition`) or `agent` with a description. A field a plugin
   * fills is written as the manifest's `binding`, and its type is the plugin's.
   */
  readonly binding?: string | { readonly agent: string };
}


interface CatalogMetadata {
  groups: Record<string, { en: string; ru: string; short: { en: string; ru: string }; parent?: string; open?: boolean }>;
  catalog: {
    'subgroup-kind-bound': number;
    attributes: string[];
    'origin-marks': string[];
    'extractor-mark': string;
    statuses: string[];
    'template-policies': string[];
    relations: Record<string, string | null>;
  };
}
const metadata = parseCatalogYaml(CATALOG_FILES['catalog.yaml']!) as CatalogMetadata;
export const CATALOG_GROUPS: readonly CatalogGroupData[] = Object.entries(metadata.groups).map(([name, group]) => ({
  name, en: group.en, ru: group.ru, shortEn: group.short.en, shortRu: group.short.ru,
  ...(group.parent === undefined ? {} : { parent: group.parent }),
  ...(group.open === undefined ? {} : { open: group.open }),
}));

const kindFiles: Record<string, string> = {};
export const CATALOG_RAW_KINDS: Record<string, Record<string, unknown>> = {};
for (const path of Object.keys(CATALOG_FILES).sort(byCodePoint)) {
  if (path === 'catalog.yaml' || path.startsWith('templates/')) continue;
  const parts = path.split('/');
  if (parts.length !== 3) throw new Error(`${import.meta.dir}/../../catalog/${path}:1: a kind declaration belongs in <group>/<subgroup>/<kind>.yaml`);
  const [parent, subgroup, leaf] = parts as [string, string, string];
  const name = leaf.slice(0, -'.yaml'.length);
  const group = CATALOG_GROUPS.find((group) => group.parent === parent && (group.name === subgroup || group.name === `${parent}.${subgroup}`));
  if (group === undefined) throw new Error(`${import.meta.dir}/../../catalog/${path}:1: no catalogue subgroup matches the folder`);
  if (Object.hasOwn(CATALOG_RAW_KINDS, name)) throw new Error(`${import.meta.dir}/../../catalog/${path}:1: kind "${name}" is already declared in ${kindFiles[name]}`);
  kindFiles[name] = path;
  CATALOG_RAW_KINDS[name] = { ...parseCatalogYaml(CATALOG_FILES[path]!) as Record<string, unknown>, group: group.name };
}
export const CATALOG_KIND_FILES: Readonly<Record<string, string>> = kindFiles;

/** Reverse the manifest spelling for the seed helpers. */
function kindData(name: string, raw: Record<string, unknown>): CatalogKindData {
  const {
    group, id, definition, sources, acquisition, status, 'relation-constraints': constraints,
    'template-policy': policy, source, origin, labels, description, fields, key,
    'derives-from': derivesFrom, 'definition-block': definitionBlock, details,
    card, history, views, er, sequence, system, listing, nav, capability, ...remaining
  } = raw;
  const names = labels as Record<string, { one: string; many: string }> | undefined;
  const descriptions = description as Record<string, string> | undefined;
  const relations = constraints as { out: string[]; in: string[] };
  return {
    name, id, group, definition, sources, acquisition, status, out: relations.out, into: relations.in, policy,
    ...(source === undefined ? {} : { source }), ...(origin === undefined ? {} : { origin }),
    ...(names?.en === undefined ? {} : { en: [names.en.one, names.en.many] }),
    ...(names?.ru === undefined ? {} : { ru: [names.ru.one, names.ru.many] }),
    ...(descriptions?.en === undefined || descriptions.ru === undefined ? {} : { describe: [descriptions.en, descriptions.ru] }),
    ...(fields === undefined ? {} : { fields }), ...(key === undefined ? {} : { key }),
    ...(derivesFrom === undefined ? {} : { derivesFrom }), ...(definitionBlock === undefined ? {} : { definitionBlock }),
    ...(details === undefined ? {} : { details }), ...(card === undefined ? {} : { card }),
    ...(history === undefined ? {} : { history }), ...(views === undefined ? {} : { views }),
    ...(er === undefined ? {} : { er }), ...(sequence === undefined ? {} : { sequence }),
    ...(system === undefined ? {} : { system }), ...(listing === undefined ? {} : { listing }),
    ...(nav === undefined ? {} : { nav }), ...(capability === undefined ? {} : { capability }),
    ...(Object.keys(remaining).length === 0 ? {} : { extra: stringify(remaining).trimEnd().split('\n') }),
  } as CatalogKindData;
}
export const CATALOG_KINDS: readonly CatalogKindData[] = Object.entries(CATALOG_RAW_KINDS).map(([name, raw]) => kindData(name, raw));

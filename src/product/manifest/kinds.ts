/**
 * The product's entity kinds (decision 0029, "Manifests and templates live in
 * the product repository"): `madarch/kinds.yaml` in the product repository
 * is the retired layout. `madarch/catalog.yaml` holds metadata and
 * `madarch/kinds/<group>/<subgroup>/<kind>.yaml` declares each kind,
 * including where its entities come from
 * (the graph, or Markdown files in the product repository) and the template
 * that shows them. The engine holds no kind of its own: nothing here names a
 * kind, a folder or a template, and a product without the file has no pages.
 *
 * ```yaml
 * kinds:
 *   domain:  { template: templates/domain.md, source: markdown, folder: docs/domains }
 *   product: { template: templates/product.md, source: markdown, file: docs/product.md }
 *   code.service:
 *     template: templates/service.md
 *     source: graph
 *     title: label                 # the attribute that names a page; `label` by default
 *     attributes: [language]       # optional: the attributes a template may name
 *     card: true                   # optional: a ground on one of these entities shows its card, not its code
 *     history: membership          # optional: the shape of the story the history block tells of its entities
 *     views: [c4-component, state] # optional: the views a page of the kind may draw of its entities
 *     er: tables                   # optional: how the ER view reads the kind's entities
 *     system: container            # optional: the part its entities play in the system view
 *     labels:                      # optional: the kind's name per interface language
 *       en: { one: Service, many: Services }
 *       ru: { one: Сервис, many: Сервисы }
 *     relations:                   # optional: edges the product declares between kinds
 *       - { type: code.contains, to: "code.package:services/{label}" }
 * ```
 *
 * Every problem is a finding with the file and the line; a kind with a
 * problem is left out and the others still stand, so one bad line never blanks
 * the wiki and never passes unseen.
 */
import { TEMPLATE_CONTRACT } from '../../plugin/template-declarations.js';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { LineCounter, parse, parseDocument, stringify, type Document } from 'yaml';

/** Decode repository-owned catalogue YAML in the manifest layer. */
export function parseCatalogYaml(text: string): unknown { return parse(text); }
import { lineForPath } from '../../model/yaml-position.js';
import { catalogFindings, CATALOG_ONLY_FIELDS, readCatalogKind, readCatalogSchema, type CatalogEntry, type CatalogSchema } from '../../knowledge/catalog.js';
import { WORKFLOWS_FILE, parseWorkflows, type WorkflowEntry, type WorkflowFinding } from './workflows.js';
import { isSemanticKind, SEMANTIC_KINDS, type SemanticKind } from '../../knowledge/semantics.js';
import { BLOCK_NAMES } from '../../knowledge/template.js';
import { PREDICATES } from '../../problems/rules.js';
import { DEFAULT_THRESHOLDS, PROBLEM_SEVERITIES, SONAR_KINDS, type ProblemSettings, type RuleParams, type RuleSetting } from '../../problems/types.js';
import { Value } from 'typebox/value';
import { PluginContractFile, type PluginContractDeclaration } from '../../plugin/protocol.js';
import { majorOf, PLUGINS_LOCK_FILE, parsePluginLock } from '../../plugin/lock.js';
import { workingTreeFiles, type ProductFileRead, type ProductFileSource } from '../../plugin/product-files.js';
import { PluginManifest } from '../../plugin/closure.js';
import { byCodePoint } from '../../model/order.js';

/** The manifest's place in the product repository. */
export const KINDS_FILE = 'madarch/catalog.yaml';
export const KINDS_FOLDER = 'madarch/kinds';
const LEGACY_KINDS_FILE = 'madarch/kinds.yaml';

export type KindsFileSource = ProductFileRead & Pick<ProductFileSource, 'filesBelow'>;

/** One problem in a product file the wiki reads: where it is and what it is. */
/** What kind of problem a finding is, for the Problems page: a file that cannot be read. */
export type FindingKind = 'unreadable-file';

export interface Finding {
  /** Where the problem stands, as the reader knows it: the product's path, or `repos/<repository>/<path>` in a code repository. */
  file: string;
  line: number;
  message: string;
  /** The kind of problem; a file that cannot be read when the finding does not say. */
  kind?: FindingKind;
  /**
   * The message as a key and its values, when the engine writes it in English words the interface words itself: the
   * app says `loop.problemText.<textKey>` with `textArgs`, and `message` is the fallback for a reader that knows no
   * such key (madarch-8bdc.2.5).
   */
  textKey?: string;
  textArgs?: Record<string, string | number>;
  /**
   * The file's place on disk, when the reader knows it: a diagnostic names both the identity a reader navigates by
   * (`file`) and the absolute path a person opens (madarch-ztyq.3, the review of finding 8). A finding whose place is
   * not a file of this machine — a manifest's entry, say — has none.
   */
  source?: string;
  /**
   * The page this finding stands for, while that page waits for the agent to write it (madarch-m38l.23): the page id the
   * wiki addresses it by. A finding that names one is not shown while the writer is taking the page up, because the page
   * is not missing: it is being written. Absent for every problem a reader sees at once.
   */
  pending?: string;
}

/** An edge the product declares between an entity of a kind and the entity at a key (decision 0029: the manifests hold the relations). */
interface DeclaredRelation {
  /** The relation type the edge is shown as. */
  type: string;
  /** The key of the other end, with `{attribute}` standing for the entity's own attribute. */
  to: string;
  line: number;
}

/** How a kind's entities came to be: written by the agent, written by a person, read from the code, read from the history. */
export type Origin = 'agent' | 'person' | 'code' | 'history';
const ORIGINS: readonly Origin[] = ['agent', 'person', 'code', 'history'];

/**
 * How one field of a manifest kind is filled (decision 0035, item 17): by a
 * field a plugin declares (`glossary@1.definition`: the plugin, the major
 * version the manifest binds, and the field's name in the plugin's contract),
 * or by the agent from a description of what the field is and how to extract it.
 */
export type FieldBinding =
  | { readonly kind: 'plugin'; readonly plugin: string; readonly major: string; readonly field: string }
  | { readonly kind: 'agent'; readonly description: string };

/** One typed field a kind's contract declares. */
export interface FieldDecl {
  readonly name: string;
  readonly type: 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json';
  readonly nullable?: boolean;
  /** An agent must ground a stated value in a file and line range. */
  readonly evidence?: boolean;
  /** The producers the manifest names for the field; a field with no binding names at least one. */
  readonly producers?: readonly string[];
  /** The kind a reference field names; a reference field may stand in the natural key. */
  readonly reference?: string;
  /**
   * The producer the manifest binds the field to (decision 0035, item 17). A
   * field with a binding takes its type from the plugin's own declaration when
   * it names one, so the manifest and the plugin cannot disagree without the
   * check saying so.
   */
  readonly binding?: FieldBinding;
  /** The line the field stands at, for a finding the whole contract's check makes. */
  readonly line?: number;
}

/** One field a plugin declares for one of its output kinds (decision 0035, item 18). */
export interface PluginFieldDecl {
  readonly name: string;
  readonly type: FieldDecl['type'];
  readonly meaning: string;
  readonly example: unknown;
  readonly required: boolean;
  readonly reference?: string;
  /** Whether an opinion of this field must carry evidence (madarch-stm0.7.1, piece 4). */
  readonly evidence?: boolean;
}

/** One output kind a plugin's own contract declares, with its key and fields. */
export interface PluginOutputKind {
  readonly kind: string;
  readonly key: readonly string[];
  readonly fields: readonly PluginFieldDecl[];
}

/** One edge kind a plugin's own contract declares, with the kinds of its ends and its fields. */
export interface PluginOutputEdge {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly fields: readonly PluginFieldDecl[];
}

/** What a plugin's own contract holds: the outputs its introduction sends and the fields they declare. */
export interface PluginContract {
  readonly agent?: NonNullable<import('../../plugin/closure.js').PluginManifest['agent']>;
  readonly id: string;
  readonly version: string;
  /** What the plugin reads: one unit at a time, or the whole graph once after every other plugin turn. */
  readonly reads: 'unit' | 'whole-graph';
  readonly vertices: readonly PluginOutputKind[];
  /** The edge kinds it produces, with their fields: the ones whose capability it fills at a manifest declaration's ends. */
  readonly edges: readonly PluginOutputEdge[];
  readonly file: string;
}

/**
 * The bounds one run of a plugin's agent part is held to (decision 0035, item 22): what the product's manifest declares,
 * never a number the engine picks. A plugin declares none by leaving `bounds:` out; a bound declared here bounds one
 * run of that plugin, the way the catalogue's token cap bounds one whole fill.
 */
export interface PluginBounds {
  /** The most tokens one run may spend, input and output together; absent declares no token bound. */
  readonly tokens?: number;
  /** The most one run may cost, in the currency the agent itself reports; absent declares no cost bound. */
  readonly cost?: { readonly amount: number; readonly currency: string };
}

/** One plugin the product holds, as its manifest declares it (decision 0035, item 11). */
export interface PluginDecl {
  readonly id: string;
  /** The major version the manifest binds (`glossary@1.…` names major 1). */
  readonly version: string;
  /** The plugin's folder in the product repository, `/`-separated. */
  readonly path?: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly closure: readonly string[];
  /** The plugin's own contract, read from its folder (`contract.json`); absent when the folder holds none. */
  readonly contract?: PluginContract;
  /** The bounds one run of its agent part is held to (decision 0035, item 22); absent declares none. */
  readonly bounds?: PluginBounds;
  readonly line: number;
}

/** One edge kind the manifest declares: its ends, its repeat rule and its typed attributes. */
export interface EdgeDecl {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly repeats: boolean;
  readonly discriminator?: string;
  readonly fields: readonly FieldDecl[];
  readonly capability?: string;
  readonly line: number;
}

/** A group of kinds in the navigation and the catalogue (`groups:` in the manifest). */
interface GroupDecl {
  name: string;
  /** The group's name per interface language. */
  labels: Readonly<Record<string, string>>;
  /**
   * The group this one is a sub-area of, when it is one: the navigation and the
   * catalogue draw it under that group, one level deep. A group without a
   * parent is a top-level group.
   */
  parent?: string;
  /**
   * Whether the navigation opens this group by itself, before a reader touches
   * it (`open: true`). A group without the field is closed until opened.
   */
  open?: boolean;
  /**
   * The navigation's short label per interface language (`short: { en, ru }`): one or two words that fit the
   * sidebar's column, where `labels` holds the group's full name for a page and the catalogue. A catalogued
   * manifest names one for every group.
   */
  short?: Readonly<Record<string, string>>;
  line: number;
}

/**
 * The most code points a group's short label holds: the sidebar is a 240 px column (260 px wide), its group
 * labels are set at 12 px uppercase with 0.08em tracking beside the chevron and the count, and a label longer
 * than this is cut off ("Requirements and …"). The wiki app's navigation draws the short label; the catalogue
 * keeps the full one.
 */
export const GROUP_SHORT_LABEL_LIMIT = 18;

/** A deterministic aggregate declared by a kind, not an agent conclusion. */
export interface FactDecl {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly measure: 'count' | 'group-by' | 'histogram' | 'top-n';
  readonly display: 'number' | 'bar' | 'treemap' | 'timeline';
  readonly field?: string;
  /** Upper bounds in days since the timestamp, followed by an open-ended bucket. */
  readonly buckets?: readonly number[];
  readonly limit?: number;
  readonly audience?: readonly string[];
}

export interface PurposeDecl {
  id: string;
  labels: Readonly<Record<string, string>>;
  order: number;
  line: number;
}

export interface KindDecl {
  purpose?: string;
  audience?: readonly string[];
  facts?: readonly FactDecl[];
  name: string;
  /** The template's path in the product repository, `/`-separated. */
  template: string;
  /** `document`: the entities are identified sections of Markdown documents (use cases, rules, decisions, terms). */
  source: 'graph' | 'markdown' | 'document';
  /** The group the navigation and the catalogue put the kind in. */
  group?: string;
  /** How the kind's entities came to be, when it is not told by the entities themselves. */
  origin?: Origin;
  /** What the kind is, in plain words, per interface language. */
  descriptions?: Readonly<Record<string, string>>;
  /** Document kinds: the identifier prefixes (`UC` for `UC-2`) whose sections are entities of the kind; `*` is any other prefix. */
  identifier?: readonly string[];
  /** Document kinds: the documents (path patterns, `*` within a folder and `**` across folders) whose leading bold terms are entities of the kind. */
  terms?: readonly string[];
  /**
   * Document kinds: the headings whose sections are entities of the kind — each list item under one,
   * or each paragraph when it holds no list. The product writes its own headings here, so the wiki
   * reads an unnumbered `## Qualities` as well as a numbered `UC-2` (madarch-ztyq.3).
   */
  headings?: readonly string[];
  /**
   * Document kinds: the general kind a passage of this kind means (`scenario`, `actor`, `rule`,
   * `quality`, `decision`, `procedure`, `term`). The classifier's answer is shown as this kind, and
   * a passage of a general kind no kind names is said to be unshown, never dropped silently.
   */
  semantics?: SemanticKind;
  /**
   * Whether this kind's entities are findings: what a producer states about the graph's own consistency, read by the
   * Problems page as problems (madarch-stm0.7.1). The engine names no kind: the product's manifest says which kind is
   * its findings kind, and a kind that declares nothing is no findings kind.
   */
  readonly findings?: boolean;
  /**
   * Document kinds: the sections a section of this kind holds (`Status`, `Context`, `Decision`,
   * `Consequences`): the structure pass reads them, as a heading or as a paragraph that opens with
   * the name and a colon, and a missing one is a finding on the section.
   */
  structure?: readonly string[];
  /** Markdown kinds: the folder (many entities) or the file (one entity) the Markdown lives in. */
  folder?: string;
  file?: string;
  /** Retired authored Markdown location, read only by the one-time importer. */
  importFolder?: string;
  importFile?: string;
  /** The attribute that names a page. */
  title: string;
  attributes?: readonly string[];
  relations: readonly DeclaredRelation[];
  /** The kind's name in each interface language: `one` for a badge, `many` for the navigation. */
  labels?: Readonly<Record<string, KindLabel>>;
  /** The properties a page of this kind shows, in this order: keys of the manifest's `properties` map. */
  details?: readonly string[];
  /**
   * A ground on one of this kind's entities shows a card of the entity — its facts, what it is related to and the way
   * to its page — rather than the code it was read from (`card: true`).
   */
  card?: true;
  /** The shape of the story the history block tells of this kind's entities (`history:`); none when absent. */
  history?: HistoryShape;
  /** The views a page of this kind may draw of its entities (`views:`); none when absent. */
  views?: readonly KindView[];
  /** How the chain a page draws starts at this kind's entities (`sequence:`); none when absent. */
  sequence?: SequenceForm;
  /** How the ER view reads this kind's entities (`er:`); none when the view is not drawn. */
  er?: ErForm;
  /** The part this kind's entities play in the system view (`system:`); none when absent. */
  system?: SystemPart;
  /** What the definition block finds in this kind's entities (`definition-block:`); none when absent. */
  definitionBlock?: DefinitionForm;
  /** The form this kind's listing page takes (`listing:`); the plain table of names and places when absent. */
  listing?: ListingForm;
  /** Where this kind stands in the navigation (`nav:`); a page by kind when absent. */
  nav?: NavTrait;
  /** The kind is a member of another entity's page and has no catalogue page of its own. */
  member?: MemberDecl;
  /** The typed fields of the kind's contract. */
  fields?: readonly FieldDecl[];
  /** The kind's natural key, unique in its table. */
  key?: readonly string[];
  /** The capability that fills the kind. */
  capability?: string;
  /** The kinds whose discovery must finish before this kind's turn (decision 0035, item 11). */
  dependsOn?: readonly string[];
  line: number;
}

/**
 * How the history block tells the story of a kind's entities (`history:` of a kind declaration): one of the shapes
 * the block can project from the graph's history facts. The shape is engine vocabulary, like a block name or a
 * property format; which kind has which shape is the product's, so no module names a kind to choose one.
 *
 * - `repositories`: the whole history of the product's repositories — totals, the files that change most, the authors
 *   and the snapshots (a product's home page reads it across every repository).
 * - `author`: the commits one author made, and the files they touched most.
 * - `path`: the commits of one path, the files that change with it, and the renames it went through.
 * - `membership`: the commits of the files a container holds, and the authors of those commits.
 * - `commit`: one commit's parents, its own times, and the branch work only it brought in.
 * - `task`: the commits whose messages name the task.
 */
export const HISTORY_SHAPES = ['repositories', 'author', 'path', 'membership', 'commit', 'task'] as const;
export type HistoryShape = (typeof HISTORY_SHAPES)[number];

/**
 * The views a page of a kind may draw of one of its entities (`views:` of a kind declaration). A view is engine
 * vocabulary — a model the engine builds from the graph — and which kinds have one is the product's, so no module names
 * a kind to choose a view (decision 0033, the owner's rule that the engine holds no product data).
 *
 * - `c4-component`: the modules of the entity and the dependencies between them (the modules block and the component
 *   view). Whether the entity is a container of the system — a box of the system views, a domain's implementation, the
 *   folder a treemap covers — is `system:`.
 * - `state`: the transition tables found in the bytes of the entity's code.
 *
 * Two views are declared by how they read an entity, because each reads it in one of two ways: `er:` (the tables an
 * entity holds, or the links of one table) and `sequence:` (the chain that starts at an entity, or at the route that
 * reaches it). A kind without either starts none of them.
 */
const KIND_VIEWS = ['c4-component', 'state'] as const;
export type KindView = (typeof KIND_VIEWS)[number];

/**
 * How the ER view reads a kind's entities (`er:` of a kind declaration): `tables` draws the tables the entity holds — the
 * graph files them under its key, and it says the graph holds no table there when it holds none — and `links` draws the
 * entity as one table with the tables its foreign keys reach.
 */
const ER_FORMS = ['tables', 'links'] as const;
export type ErForm = (typeof ER_FORMS)[number];

/**
 * How the end-to-end chain a page draws starts at a kind's entities (`sequence:` of a kind declaration): `route` starts
 * at the entity itself, and `symbol` at the route that reaches it, or at it when no route does. A kind without the field
 * starts no chain.
 */
const SEQUENCE_FORMS = ['route', 'symbol'] as const;
export type SequenceForm = (typeof SEQUENCE_FORMS)[number];

/**
 * The part a kind's entities play in the system view (`system:` of a kind declaration).
 *
 * - `container`: the boxes the context and container views draw and the entities a chain's lanes are grouped by; a
 *   domain's implementation is the containers it relates, a container's neighbourhood carries the system view's rows, and
 *   the treemap of a container covers the folder its code stands in.
 * - `data-store`: a store a container reads and writes.
 * - `channel`: a topic or queue a container publishes to and consumes.
 *
 * Each part also names the kind a system element of that part falls back to when the graph holds no entity for it. A
 * kind without the field is no element of the system view.
 */
const SYSTEM_PARTS = ['container', 'data-store', 'channel'] as const;
export type SystemPart = (typeof SYSTEM_PARTS)[number];

/**
 * What the definition block finds in a kind's entities (`definition-block:` of a kind declaration): the `contract` file it
 * reads, an `operation` row of that contract, or a `channel` row of it with its messages. The block reads a contract
 * through the format its own reader parses; which kind holds one is the product's.
 */
const DEFINITION_FORMS = ['contract', 'operation', 'channel'] as const;
export type DefinitionForm = (typeof DEFINITION_FORMS)[number];

/** The forms a definition is read as a row of: a contract's members, beside the contract itself. */
const DEFINITION_MEMBER_FORMS: readonly DefinitionForm[] = ['operation', 'channel'];

/**
 * The form a kind's listing page takes (`listing:` of a kind declaration): the plain table of names and places when the
 * field is absent, the operations table, which names what declares, serves and calls each one (`operations`), or the
 * glossary's entries, whose text links to the term it uses and whose page states the definition and where it is stated
 * (`glossary`). Which fields a term's entry reads is the block's, in the product's template: no module names a kind.
 */
const LISTING_FORMS = ['operations', 'glossary'] as const;
export type ListingForm = (typeof LISTING_FORMS)[number];

/**
 * Where a kind stands in the navigation (`nav:` of a kind declaration): `own-page` for a kind whose entities stand at a
 * place of their own (the glossary, the tasks), so the kind's rows are not listed among the pages by kind; `loop` for
 * the kinds the loop keeps in its own places (the questions, the corrections).
 */
const NAV_TRAITS = ['own-page', 'loop'] as const;
export type NavTrait = (typeof NAV_TRAITS)[number];

/** A kind's name in one language, as a reader says it of one entity and of several. */
interface KindLabel {
  one: string;
  many: string;
}

/** How a property's value is written for a reader: a list, commands, ports, a date, a plain word. */
const PROPERTY_FORMATS = ['text', 'list', 'commands', 'ports', 'boolean', 'number', 'date', 'path', 'code', 'build', 'scripts'] as const;
export type PropertyFormat = (typeof PROPERTY_FORMATS)[number];

/** A property the product names in its manifest: its reader-facing label in each language and how its value is written. */
export interface PropertyDecl {
  name: string;
  labels: Readonly<Record<string, string>>;
  format: PropertyFormat;
  line: number;
  /** The keys of a value that is an object (a build's context, a Dockerfile): their labels, declared as data. */
  fields?: ReadonlyMap<string, PropertyDecl>;
}

/**
 * A kind whose entities are members of another entity's page rather than pages of their own (madarch-m38l.21):
 * a field of a class, a facet of a file. The relation names the edge to the parent; `property` is the fallback when
 * the graph holds no edge.
 */
export interface MemberDecl {
  relation: string;
  direction: 'out' | 'in';
  parentKind?: string;
  property?: string;
  line: number;
}

/** The renderers a diagram can open on (`diagram:` of the manifest). */
/** The diagram engines a product may open on (madarch-j9ao.1 adds the treemap's ECharts beside the drawn views'); `echarts` draws the Files map and cannot draw the drawn views. */
export const DIAGRAM_RENDERER_NAMES: readonly string[] = ['likec4', 'mermaid', 'archify', 'echarts'];

/** The languages the wiki's interface speaks; a label in another language is a finding. */
export const LABEL_LANGUAGES: readonly string[] = ['en', 'ru'];

/**
 * The word that stands for every role at once (decision 0031): it is never declared, because it is every declared
 * role and no role of its own.
 */
export const EVERY_ROLE = 'everything';

/** What a role changes on a page and in the navigation, as the manifest declares it (`roles:`). */
interface RoleDecl {
  /** The role's id, as the product's manifest names it (product, analyst, designer, security-engineer ...). */
  name: string;
  /** The blocks of a template that stand open for the role (block names); the others stay on the page, collapsed. Absent: every block is open. */
  open?: readonly string[];
  /** The groups the navigation lists first for the role, in this order. */
  lead: readonly string[];
  line: number;
}

/** A kind the product's documents are expected to hold, and the manifest's line that says so. */
interface ExpectedKind {
  readonly kind: string;
  readonly line: number;
}

export interface KindsManifest {
  file: string;
  /** What each role changes; a role the manifest does not declare reads everything open in the manifest's order. */
  roles: ReadonlyMap<string, RoleDecl>;
  purposes?: ReadonlyMap<string, PurposeDecl>;
  /** The language the product's pages are written in (`language:` at the top of the manifest); absent means English. */
  language?: string;
  /** `journal:` — whether the journal keeps every request a plugin makes, its reads included (off unless it is said). */
  journal?: { readonly debug: boolean };
  /** The renderer the diagrams open on (`diagram:` at the top of the manifest: likec4, mermaid or archify); absent means the environment's, else LikeC4. */
  diagram?: string;
  /** The reader-facing labels and value formats of the properties the kinds show. */
  properties: ReadonlyMap<string, PropertyDecl>;
  kinds: ReadonlyMap<string, KindDecl>;
  /** Source paths of folder declarations, keyed by kind name. */
  kindFiles?: ReadonlyMap<string, string>;
  /** The edge kinds the manifest declares, by name. */
  edges?: ReadonlyMap<string, EdgeDecl>;
  /** The plugins the product holds, by id (decision 0035, item 11). */
  plugins?: ReadonlyMap<string, PluginDecl>;
  /**
   * Every template path a kind declaration names, including a declaration whose template is missing (or whose other
   * fields are invalid) and so has no `KindDecl`. The status key reads the paths a declaration names, not only the paths
   * of the kinds that parsed: creating the missing template changes the answer (madarch-u3vw.8).
   */
  declaredTemplates?: readonly string[];
  /** The groups of kinds, in the manifest's order. */
  groups: ReadonlyMap<string, GroupDecl>;
  /** Markdown documents the wiki does not list as documents (harness files, say), as path patterns. */
  excludeDocuments: readonly string[];
  /** Block kinds a document may hold without a page, named by the product: a fence, an html comment. */
  ignoreBlocks: readonly string[];
  /**
   * The kinds the product expects its documents to hold (`documents.expect`). A kind that no
   * document section is read as is a finding naming the manifest's line: the wiki says what the
   * documents lack instead of showing a smaller result (decision 0032 section 4).
   */
  expect?: readonly ExpectedKind[];
  /**
   * The Problems page's rules and thresholds (`problems:`): which rules run, the severity each starts
   * with, and the sizes a file is judged large by. Absent declares no rule: the page lists the starter
   * rules only where the manifest writes them (`problems.rules`), and says so instead of guessing them.
   */
  problems?: ProblemSettings;
  findings: readonly Finding[];
  /**
   * The entity catalog, when the manifest declares one (`catalog:`): its schema and the row of every kind the
   * manifest holds, page kinds and catalogue-only kinds alike. A manifest without `catalog:` has none, and its kinds
   * are read as the versions before the catalog read them.
   */
  catalog?: { readonly schema: CatalogSchema; readonly kinds: ReadonlyMap<string, CatalogEntry>; readonly findings: readonly Finding[] };
  /**
   * The product's workflows (`madarch/workflows.yaml`), when the product holds one: the workflows it reads and the
   * findings of the workflow check — a stage the engine's registry does not hold, a stage whose required input no
   * stage of the workflow produces, a cycle. Its findings also stand with the manifest's own, so the Problems page
   * shows them once (decision 0033, items 1 and 2).
   */
  workflows?: { readonly file: string; readonly workflows: ReadonlyMap<string, WorkflowEntry>; readonly findings: readonly WorkflowFinding[] };
  /** The manifest could not be read as a whole (not YAML, not a mapping, no `kinds` mapping): no kind is known, which is not the same as every kind having a finding. */
  unreadable?: true;
}

export type KindsRead =
  | { present: false; file: string }
  | { present: true; manifest: KindsManifest };

/** The shape a manifest field's binding to a plugin field takes: `<plugin>@<major>.<field>` (decision 0035, item 17). */
const BINDING_PATTERN = /^([a-z][a-z0-9-]*)@(\d+)\.([a-z][a-z0-9_]*)$/u;

const KIND_KEYS = new Set([
  'purpose', 'audience', 'facts', 'template', 'source', 'folder', 'file', 'import-folder', 'import-file', 'title', 'attributes', 'relations', 'labels', 'group', 'origin', 'description',
  'identifier', 'terms', 'headings', 'semantics', 'structure', 'details', 'member', 'card', 'history', 'findings',
  'views', 'er', 'sequence', 'system', 'definition-block', 'listing', 'nav', 'fields', 'key', 'capability', 'depends-on',
  // the catalog's row of the kind (decision 0033, items 8 to 10): read when the manifest declares a catalog
  'id', 'definition', 'sources', 'acquisition', 'status', 'relation-constraints', 'template-policy',
]);

/** Whether a value is one of the shapes a kind's history page can have. */
function isHistoryShape(value: unknown): value is HistoryShape {
  return typeof value === 'string' && (HISTORY_SHAPES as readonly string[]).includes(value);
}

/**
 * What the manifest says of one kind, for the modules that draw a page: each reader asks the declaration rather than a
 * kind's name, so a product that renames or removes a kind keeps exactly the views, the listing and the navigation its
 * manifest declares (decision 0033, the owner's rule that the engine holds no product data). A kind the manifest does not
 * declare has none of them.
 */
function kindDeclOf(manifest: KindsManifest | undefined, kind: string): KindDecl | undefined {
  return manifest?.kinds?.get(kind);
}

/**
 * The sentence naming where a kind's declaration stands and what it does not declare: the modules that draw a page read
 * it instead of choosing by a kind's name, so a reader is told what to declare in the product's own manifest (file and
 * line), never that the engine lacks a kind (decision 0033).
 */
export function declarationMissing(manifest: KindsManifest | undefined, kind: string, declaration: string, what: string): string {
  const decl = kindDeclOf(manifest, kind);
  const file = manifest?.file ?? '';
  const named = file === '' ? 'the manifest' : `the manifest ${file}`;
  if (decl === undefined) return `${what}: ${named} declares no kind ${kind}`;
  // A declaration the reader holds always names its line; one a fixture hands in without a line is named by the file
  // alone, so a refusal never says ":undefined".
  const at = Number.isFinite(decl.line) ? `${named}${file === '' ? ' line' : ':'}${decl.line}` : named;
  return `${what}: ${at} gives the kind ${kind} no ${declaration}`;
}

/** Whether the manifest gives a kind one of the views a page may draw of its entities (`views:`). */
export function kindDraws(manifest: KindsManifest | undefined, kind: string, view: KindView): boolean {
  return kindDeclOf(manifest, kind)?.views?.includes(view) === true;
}

/** How the ER view reads a kind's entities (`er:`), when the manifest gives the kind one. */
export function erFormOf(manifest: KindsManifest | undefined, kind: string): ErForm | undefined {
  return kindDeclOf(manifest, kind)?.er;
}

/** How the chain a page draws starts at a kind's entities (`sequence:`), when the manifest gives the kind one. */
export function sequenceFormOf(manifest: KindsManifest | undefined, kind: string): SequenceForm | undefined {
  return kindDeclOf(manifest, kind)?.sequence;
}

/** The part a kind's entities play in the system view (`system:`), when the manifest gives the kind one. */
export function systemPartOf(manifest: KindsManifest | undefined, kind: string): SystemPart | undefined {
  return kindDeclOf(manifest, kind)?.system;
}

/** The kinds that play a part in the system view (`system: <part>`), in the manifest's order. */
export function systemKindsOf(manifest: KindsManifest | undefined, part: SystemPart): string[] {
  return [...(manifest?.kinds?.values() ?? [])].filter((decl) => decl.system === part).map((decl) => decl.name);
}

/** The first kind the manifest gives a part in the system view, when it declares one. */
export function systemKindOf(manifest: KindsManifest | undefined, part: SystemPart): string | undefined {
  return systemKindsOf(manifest, part)[0];
}

/** What the definition block finds in a kind's entities (`definition-block:`), when the manifest gives the kind one. */
export function definitionBlockFormOf(manifest: KindsManifest | undefined, kind: string): DefinitionForm | undefined {
  return kindDeclOf(manifest, kind)?.definitionBlock;
}

/** Whether the kind's entities are a row of a contract's definition (`definition-block: operation` or `definition-block: channel`). */
export function definitionBlockMemberOf(manifest: KindsManifest | undefined, kind: string): boolean {
  const form = definitionBlockFormOf(manifest, kind);
  return form !== undefined && DEFINITION_MEMBER_FORMS.includes(form);
}

/** The form a kind's listing page takes (`listing:`), when the manifest gives the kind one. */
export function listingFormOf(manifest: KindsManifest | undefined, kind: string): ListingForm | undefined {
  return kindDeclOf(manifest, kind)?.listing;
}

/** Whether a repository-relative path stays inside the folder: no climbing, not absolute. */
export function insideFolder(folder: string, path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\0')) return false;
  const from = relative(resolve(folder), resolve(folder, path));
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
}


/** The fields a declared rule holds. */
const RULE_FIELDS = ['predicate', 'kind', 'sonar', 'severity', 'section', 'action', 'label', 'params', 'enabled'] as const;
const PROBLEM_SECTIONS = ['code', 'documents', 'wiki'] as const;
const RULE_ACTIONS = ['task', 'none'] as const;

/** A mapping, not a list and not null. */
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A rule's parameters: named values a predicate reads, each a string, a number, a boolean or a list of strings. */
function readParams(value: unknown, file: string, line: number, id: string, findings: Finding[]): RuleParams | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    findings.push({ file, line, message: `rule "${id}": "params" maps a parameter name to a string, a number, a boolean or a list of strings` });
    return undefined;
  }
  const params: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [name, held] of Object.entries(value)) {
    // The YAML line counter has no finer position inside a flow mapping; the parameter is named in the message.
    if (typeof held === 'string' || typeof held === 'boolean' || (typeof held === 'number' && Number.isFinite(held))) params[name] = held;
    else if (Array.isArray(held) && held.every((entry) => typeof entry === 'string')) params[name] = held as string[];
    else findings.push({ file, line, message: `rule "${id}": the parameter "${name}" is a string, a number, a boolean or a list of strings, got ${JSON.stringify(held)}` });
  }
  return params;
}

/**
 * The `problems:` mapping: every rule the page runs — its predicate, kind, Sonar kind, severity,
 * section, action, label and parameters — and the thresholds the size rules read. The engine keeps
 * only the predicates, so a rule this manifest does not declare is not run, and a declaration that
 * misses a field is a finding at its line rather than a rule running with a guessed value.
 */
/**
 * The keys of an object-valued property (a build's context and its Dockerfile), each declared as { en, ru, format? }.
 * The engine names no key of a product's value: a key it reads is a key the manifest declares here (madarch-m38l.21).
 */
function propertyFields(
  property: string,
  raw: unknown,
  at: (path: (string | number)[]) => number,
  findings: Finding[],
  file: string,
): Map<string, PropertyDecl> {
  const fields = new Map<string, PropertyDecl>();
  if (raw === undefined) return fields;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    findings.push({ file, line: at(['properties', property, 'fields']), message: `property "${property}": "fields" maps a key of the value to { en, ru, format? }` });
    return fields;
  }
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const line = at(['properties', property, 'fields', key]);
    if (key.trim() === '') { findings.push({ file, line, message: `property "${property}": a field name is a name, not the empty string` }); continue; }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { findings.push({ file, line, message: `property "${property}" field "${key}": the declaration is { en, ru, format? }` }); continue; }
    const body = entry as Record<string, unknown>;
    for (const inner of Object.keys(body)) if (inner !== 'en' && inner !== 'ru' && inner !== 'format') findings.push({ file, line: at(['properties', property, 'fields', key, inner]), message: `property "${property}" field "${key}": "${inner}" is not a field of a field: the fields are en, ru and format` });
    const labels: Record<string, string> = {};
    for (const language of LABEL_LANGUAGES) {
      const text = body[language];
      // The word a missing language lacks has no line of its own: the finding names the field's declaration.
      if (typeof text !== 'string' || text.trim() === '') findings.push({ file, line, message: `property "${property}" field "${key}": "${language}" is the word a reader sees` });
      else labels[language] = text;
    }
    const format = body['format'] ?? 'text';
    if (typeof format !== 'string' || !(PROPERTY_FORMATS as readonly string[]).includes(format)) findings.push({ file, line, message: `property "${property}" field "${key}": "format" is one of ${PROPERTY_FORMATS.join(', ')}, got ${JSON.stringify(format)}` });
    if (Object.keys(labels).length === LABEL_LANGUAGES.length && typeof format === 'string' && (PROPERTY_FORMATS as readonly string[]).includes(format)) fields.set(key, { name: key, labels, format: format as PropertyFormat, line });
  }
  return fields;
}

function parseProblems(
  raw: unknown,
  at: (path: (string | number)[]) => number,
  findings: Finding[],
  file: string,
): ProblemSettings | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    findings.push({ file, line: at(['problems']), message: '"problems" is { rules: { <rule id>: { predicate, kind, sonar, severity, section, action, label, params?, enabled? } }, thresholds: { largeFileLines: 600 } }' });
    return undefined;
  }
  const body = raw;
  for (const key of Object.keys(body)) if (key !== 'rules' && key !== 'thresholds') findings.push({ file, line: at(['problems', key]), message: `"${key}" is not a field of "problems": the fields are "rules" and "thresholds"` });
  const rules: Record<string, RuleSetting> = {};
  const kinds = new Map<string, string>();
  const rawRules = body['rules'];
  if (rawRules !== undefined) {
    if (!isRecord(rawRules)) findings.push({ file, line: at(['problems', 'rules']), message: '"rules" maps a rule id to { predicate, kind, sonar, severity, section, action, label, params?, enabled? }' });
    else {
      for (const [id, entry] of Object.entries(rawRules)) {
        const line = at(['problems', 'rules', id]);
        if (id === '') { findings.push({ file, line, message: 'a rule id is a name, not the empty string' }); continue; }
        if (!isRecord(entry)) { findings.push({ file, line, message: `rule "${id}": the rule is { predicate, kind, sonar, severity, section, action, label, params?, enabled? }` }); continue; }
        const setting = entry;
        for (const key of Object.keys(setting)) if (!(RULE_FIELDS as readonly string[]).includes(key)) findings.push({ file, line: at(['problems', 'rules', id, key]), message: `rule "${id}": "${key}" is not a field of the rule: the fields are ${RULE_FIELDS.join(', ')}` });
        let sound = true;
        const predicate = setting['predicate'];
        if (typeof predicate !== 'string' || !PREDICATES.includes(predicate)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'predicate']), message: `rule "${id}": "predicate" is one the engine implements (${PREDICATES.join(', ')}), got ${JSON.stringify(predicate)}` });
          sound = false;
        }
        const kind = setting['kind'];
        if (typeof kind !== 'string' || kind.trim() === '') {
          findings.push({ file, line: at(['problems', 'rules', id, 'kind']), message: `rule "${id}": "kind" is the kind of finding the rule makes, a word or words` });
          sound = false;
        } else if (kinds.has(kind)) {
          findings.push({ file, line, message: `rule "${id}": the kind ${JSON.stringify(kind)} is already declared by the rule "${kinds.get(kind)}": a finding kind names one rule` });
          sound = false;
        }
        const sonar = setting['sonar'];
        if (typeof sonar !== 'string' || !SONAR_KINDS.includes(sonar as never)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'sonar']), message: `rule "${id}": "sonar" is one of ${SONAR_KINDS.join(', ')}` });
          sound = false;
        }
        const severity = setting['severity'];
        if (typeof severity !== 'string' || !PROBLEM_SEVERITIES.includes(severity as never)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'severity']), message: `rule "${id}": "severity" is one of ${PROBLEM_SEVERITIES.join(', ')}` });
          sound = false;
        }
        const section = setting['section'];
        if (typeof section !== 'string' || !(PROBLEM_SECTIONS as readonly string[]).includes(section)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'section']), message: `rule "${id}": "section" is one of ${PROBLEM_SECTIONS.join(', ')}` });
          sound = false;
        }
        const action = setting['action'];
        if (typeof action !== 'string' || !(RULE_ACTIONS as readonly string[]).includes(action)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'action']), message: `rule "${id}": "action" is one of ${RULE_ACTIONS.join(', ')}` });
          sound = false;
        }
        const label = setting['label'];
        const labelSound = isRecord(label) && typeof label['en'] === 'string' && label['en'].trim() !== '' && typeof label['ru'] === 'string' && label['ru'].trim() !== '' && Object.keys(label).every((key) => key === 'en' || key === 'ru');
        if (!labelSound) {
          findings.push({ file, line: at(['problems', 'rules', id, 'label']), message: `rule "${id}": "label" is { en: <words>, ru: <words> }` });
          sound = false;
        }
        const enabled = setting['enabled'];
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          findings.push({ file, line: at(['problems', 'rules', id, 'enabled']), message: `rule "${id}": "enabled" is true or false` });
          sound = false;
        }
        const params = readParams(setting['params'], file, at(['problems', 'rules', id, 'params']), id, findings);
        if (setting['params'] !== undefined && params === undefined) sound = false;
        if (!sound) continue;
        kinds.set(kind as string, id);
        rules[id] = {
          predicate: predicate as string,
          kind: kind as string,
          sonar: sonar as never,
          severity: severity as never,
          section: section as never,
          action: action as never,
          label: { en: (label as Record<string, string>)['en']!, ru: (label as Record<string, string>)['ru']! },
          ...(params === undefined ? {} : { params }),
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        };
      }
    }
  }
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const rawThresholds = body['thresholds'];
  if (rawThresholds !== undefined) {
    if (!isRecord(rawThresholds)) findings.push({ file, line: at(['problems', 'thresholds']), message: '"thresholds" maps a threshold name to a positive whole number' });
    else {
      for (const [key, value] of Object.entries(rawThresholds)) {
        if (!(key in DEFAULT_THRESHOLDS)) { findings.push({ file, line: at(['problems', 'thresholds', key]), message: `"${key}" is not a threshold: the thresholds are ${Object.keys(DEFAULT_THRESHOLDS).join(', ')}` }); continue; }
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) findings.push({ file, line: at(['problems', 'thresholds', key]), message: `"${key}" is a positive whole number, got ${JSON.stringify(value)}` });
        else (thresholds as Record<string, number>)[key] = value;
      }
    }
  }
  return { rules, thresholds };
}

function nothing(file: string, findings: Finding[]): KindsManifest {
  return { file, roles: new Map(), properties: new Map(), kinds: new Map(), declaredTemplates: [], groups: new Map(), excludeDocuments: [], ignoreBlocks: [], expect: [], findings, unreadable: true };
}

/**
 * The manifest with the product's workflows beside it: a product that holds `madarch/workflows.yaml` reads its
 * workflows here, and their findings stand with the manifest's own, each naming its own file and line.
 */
function withWorkflows(manifest: KindsManifest, files: ProductFileRead, productFolder: string): KindsManifest {
  const file = join(productFolder, WORKFLOWS_FILE);
  const text = files.has(WORKFLOWS_FILE) ? files.text(WORKFLOWS_FILE) : undefined;
  if (text === undefined) {
    if (!files.has(WORKFLOWS_FILE)) return manifest;
    return { ...manifest, workflows: { file, workflows: new Map(), findings: [{ file, line: 1, message: 'the file cannot be read: the source holds no text of it' }] }, findings: [...manifest.findings, { file, line: 1, message: 'the file cannot be read: the source holds no text of it' }] };
  }
  const read = { ...parseWorkflows(text, file), present: true };
  return {
    ...manifest,
    workflows: { file, workflows: read.workflows, findings: read.findings },
    findings: [...manifest.findings, ...read.findings],
  };
}

/** Reads catalogue metadata and kind declarations of a product working tree; absent when neither exists. */
export function readKinds(productFolder: string): KindsRead {
  return readKindsFrom(workingTreeFiles(productFolder), productFolder);
}

/**
 * Reads the metadata and folder declarations from a source of the product repository's files: the
 * fill's working tree, or the graph's stored text for a reader of the wiki. Nothing is read from a checkout here.
 */
export function readKindsFrom(files: KindsFileSource, productFolder: string): KindsRead {
  if (files.has(LEGACY_KINDS_FILE)) {
    const file = join(productFolder, LEGACY_KINDS_FILE);
    return { present: true, manifest: nothing(file, [{ file, source: file, line: 1, message: 'the legacy madarch/kinds.yaml layout is not supported: migrate metadata to madarch/catalog.yaml and kind declarations to madarch/kinds/<group>/<subgroup>/<kind>.yaml' }]) };
  }
  const read = readKindsFolderFrom(files, productFolder);
  return read.present ? { present: true, manifest: withWorkflows(read.manifest, files, productFolder) } : read;
}

/** Reads a folder catalogue through the same validator as product declarations, retaining each source line. */
export function readKindsFolderFrom(files: KindsFileSource, productFolder: string, metadataPath = KINDS_FILE, kindsFolder = KINDS_FOLDER): KindsRead {
  const file = join(productFolder, metadataPath);
  const paths = files.filesBelow(kindsFolder).filter((path) => path !== metadataPath).sort(byCodePoint);
  if (!files.has(metadataPath) && paths.length === 0) return { present: false, file };
  const findings: Finding[] = [];
  const locations: { file: string; line: number }[] = [];
  const composite: string[] = [];
  const kindFiles = new Map<string, string>();
  const append = (text: string, path: string, indent = ''): void => {
    for (const [index, line] of text.replace(/\n$/, '').split('\n').entries()) {
      composite.push(indent + line);
      locations.push({ file: join(productFolder, path), line: index + 1 });
    }
  };
  const documentText = (path: string): string | undefined => {
    const full = join(productFolder, path);
    const text = files.has(path) ? files.text(path) : undefined;
    if (text === undefined) {
      findings.push({ file: full, source: full, line: 1, message: 'the file cannot be read: the source holds no text of it' });
      return undefined;
    }
    const { doc } = parsedManifest(text, full);
    if (doc.errors.length > 0) {
      for (const error of doc.errors) findings.push({ file: full, source: full, line: error.linePos?.[0].line ?? 1, message: error.message.split('\n')[0] ?? error.message });
      return undefined;
    }
    const value: unknown = doc.toJS();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      findings.push({ file: full, source: full, line: 1, message: 'the declaration is a YAML mapping' });
      return undefined;
    }
    for (const key of ['kinds', ...(path === metadataPath ? [] : ['name', 'group'])]) {
      if (Object.hasOwn(value, key)) {
        const { lines } = parsedManifest(text, full);
        findings.push({ file: full, source: full, line: lineForPath(doc, lines, [key]), message: `"${key}" is not declared here: kind names and groups come from the folder layout` });
        return undefined;
      }
    }
    // Document markers cannot be indented into the enclosing kind mapping.
    return text.replace(/^(?:---|\.\.\.)(?:[ \t]*(?:#.*)?)?$/gm, '');
  };
  const metadata = documentText(metadataPath);
  if (metadata !== undefined) {
    const { doc, lines } = parsedManifest(metadata, file);
    if ((doc.contents as { flow?: boolean } | null)?.flow === true) {
      const value = doc.toJS() as Record<string, unknown>;
      const written = stringify(value, { lineWidth: 0 });
      const normalizedLines = new LineCounter();
      const normalized = parseDocument(written, { lineCounter: normalizedLines });
      const before = locations.length;
      if (Object.keys(value).length > 0) append(written, metadataPath);
      const mapPaths = (held: unknown, path: (string | number)[]): void => {
        const generatedLine = lineForPath(normalized, normalizedLines, path);
        const originalLine = lineForPath(doc, lines, path);
        if (locations[before + generatedLine - 1] !== undefined) locations[before + generatedLine - 1]!.line = originalLine;
        if (Array.isArray(held)) held.forEach((entry, index) => mapPaths(entry, [...path, index]));
        else if (held !== null && typeof held === 'object') for (const [key, entry] of Object.entries(held)) mapPaths(entry, [...path, key]);
      };
      mapPaths(value, []);
    } else append(metadata, metadataPath);
  }
  const rawGroups: unknown = metadata === undefined ? undefined : parsedManifest(metadata, file).doc.toJS()?.groups;
  const groups = rawGroups !== null && typeof rawGroups === 'object' && !Array.isArray(rawGroups) ? rawGroups as Record<string, { parent?: unknown }> : {};
  composite.push('kinds:'); locations.push({ file, line: 1 });
  for (const path of paths) {
    const full = join(productFolder, path);
    const suffix = path.slice(kindsFolder.length + 1);
    const segments = suffix.split('/');
    const leaf = segments.at(-1)!;
    if (segments.length !== 3 || !leaf.endsWith('.yaml') || leaf === '.yaml' || segments.some((segment) => segment === '')) {
      findings.push({ file: full, source: full, line: 1, message: 'a kind declaration lives at <group>/<subgroup>/<kind>.yaml' });
      continue;
    }
    const name = leaf.slice(0, -'.yaml'.length);
    if (kindFiles.has(name)) {
      findings.push({ file: full, source: full, line: 1, message: `kind "${name}" is already declared in ${join(productFolder, kindFiles.get(name)!)}` });
      continue;
    }
    const text = documentText(path);
    if (text === undefined) continue;
    kindFiles.set(name, path);
    composite.push(`  ${JSON.stringify(name)}:`); locations.push({ file: full, line: 1 });
    const joinedGroup = segments.slice(0, -1).join('.');
    const subgroup = segments[1]!;
    const group = JSON.stringify(groups[subgroup]?.parent === segments[0] ? subgroup : joinedGroup);
    const { doc } = parsedManifest(text, full);
    if ((doc.contents as { flow?: boolean } | null)?.flow === true) {
      const offset = doc.contents!.range![0];
      append(text.slice(0, offset + 1) + `group: ${group}, ` + text.slice(offset + 1), path, '    ');
    } else {
      composite.push(`    group: ${group}`); locations.push({ file: full, line: 1 });
      append(text, path, '    ');
    }
  }
  if (kindFiles.size === 0) { composite[composite.indexOf('kinds:')] = 'kinds: {}'; }
  const manifest = parseKinds(composite.join('\n') + '\n', file, productFolder, files);
  const location = (line: number) => locations[line - 1] ?? { file, line: 1 };
  const remap = (finding: Finding): Finding => finding.file === file
    ? { ...finding, ...location(finding.line), source: location(finding.line).file }
    : finding;
  // Declaration locations are used by publication as well as diagnostics.
  const remapLines = (value: unknown): void => {
    if (value instanceof Map) { for (const entry of value.values()) remapLines(entry); }
    else if (Array.isArray(value)) { for (const entry of value) remapLines(entry); }
    else if (value !== null && typeof value === 'object') {
      for (const [key, held] of Object.entries(value)) {
        if (key === 'line' && typeof held === 'number') (value as { line: number }).line = location(held).line;
        else remapLines(held);
      }
    }
  };
  const mapped = manifest.findings.map(remap);
  const catalogMapped = manifest.catalog?.findings.map(remap);
  remapLines(manifest.kinds);
  remapLines(manifest.groups);
  remapLines(manifest.properties);
  remapLines(manifest.expect);
  remapLines(manifest.roles);
  if (manifest.purposes !== undefined) remapLines(manifest.purposes);
  remapLines(manifest.edges);
  remapLines(manifest.plugins);
  if (manifest.catalog !== undefined) {
    remapLines(manifest.catalog.kinds);
    remapLines(manifest.catalog.schema);
    manifest.catalog = { ...manifest.catalog, findings: catalogMapped ?? [] };
  }
  return { present: true, manifest: { ...manifest, kindFiles, findings: [...findings, ...mapped] } };
}

/**
 * How many parsed manifests are kept: one per product folder a process reads, and a cap so a products home of many
 * products does not hold them all. A manifest read again is a hit; one that fell out of the cache is parsed again.
 */
const PARSED_MANIFESTS_KEPT = 8;

/**
 * The parsed YAML of a manifest, by the text it was parsed from: `parseDocument` reads 474 KB (8 222 lines) in 54-93 ms
 * on this box, and a manifest is read on the answer to every page, status poll and Problems read — on the event loop of
 * the process that serves them (madarch-8bdc.9, CI shard 2: one such parse was the 330 ms stall that hit every endpoint
 * at the press of a fill on a two-core runner). The text is the key, so an edited file is parsed at the next read; what
 * is made *of* the parsed document — findings, line numbers, whether a template exists — is worked out on every read and
 * is not cached, so a template written beside an unchanged manifest is still seen (madarch-u3vw.8).
 */
const parsedManifests = new Map<string, { readonly text: string; readonly doc: Document; readonly lines: LineCounter }>();

/** The parse of one manifest text, from the cache when this file last saw this text. */
function parsedManifest(text: string, file: string): { readonly doc: Document; readonly lines: LineCounter } {
  const held = parsedManifests.get(file);
  if (held !== undefined && held.text === text) return held;
  const lines = new LineCounter();
  const entry = { text, doc: parseDocument(text, { lineCounter: lines, uniqueKeys: true }), lines };
  parsedManifests.delete(file);
  parsedManifests.set(file, entry);
  while (parsedManifests.size > PARSED_MANIFESTS_KEPT) {
    const oldest = parsedManifests.keys().next().value;
    if (oldest === undefined) break;
    parsedManifests.delete(oldest);
  }
  return entry;
}

/** Parses the manifest's text; `productFolder` lets a template's existence be judged. */
/**
 * One plugin's own contract, read from its folder in the product repository (decision 0035, items 3, 17 and 18): the
 * outputs its introduction declares, with each field's type, meaning, example and required flag. A contract the check
 * cannot read is a finding naming the file and the line, and the plugin stands without one, so every binding to it is
 * refused rather than trusted.
 */
function readPluginContract(files: ProductFileRead, id: string, path: string, manifestFile: string, line: number, findings: Finding[]): PluginContract | undefined {
  const file = `${path}/contract.json`;
  const text = files.has(file) ? files.text(file) : undefined;
  if (text === undefined) {
    findings.push({ file: manifestFile, line, message: `plugin "${id}": the contract ${file} cannot be read (${files.has(file) ? 'the source holds no text of it' : 'the product repository holds no such file'}): a plugin's folder holds its contract.json` });
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    findings.push({ file, line: jsonLine(text, 0), message: `the plugin contract ${file} is not JSON: ${(error as Error).message}` });
    return undefined;
  }
  if (!Value.Check(PluginContractFile, value)) {
    const first = [...Value.Errors(PluginContractFile, value)][0];
    const where = first === undefined ? '' : first.instancePath;
    findings.push({ file, line: jsonLine(text, where.length), message: `the plugin contract ${file} is not a plugin contract: ${first === undefined ? 'it does not fit the protocol' : `${where === '' ? 'the contract' : where.slice(1)} ${first.message}`}` });
    return undefined;
  }
  const contract = value as { id: string; version: string; outputs: PluginContractDeclaration; reads?: 'unit' | 'whole-graph' };
  if (contract.id !== id) findings.push({ file, line: 1, message: `the plugin contract ${file} declares the id ${JSON.stringify(contract.id)}, and the manifest declares the plugin ${JSON.stringify(id)}` });
  const vertices: PluginOutputKind[] = [];
  for (const vertex of contract.outputs.vertices) {
    // A field's declaration is checked whole here, so the table built from it never meets a half-declared field.
    const fields: PluginFieldDecl[] = vertex.fields ?? [];
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.name)) findings.push({ file, line: 1, message: `the plugin contract ${file}: the kind ${JSON.stringify(vertex.kind)} declares the field ${JSON.stringify(field.name)} twice` });
      seen.add(field.name);
    }
    for (const keyField of vertex.key ?? []) {
      const declared = fields.find((field) => field.name === keyField);
      if (declared === undefined) findings.push({ file, line: 1, message: `the plugin contract ${file}: the kind ${JSON.stringify(vertex.kind)} is keyed by ${JSON.stringify(keyField)}, which its fields do not declare` });
    }
    vertices.push({ kind: vertex.kind, key: vertex.key ?? [], fields });
  }
  const edges: PluginOutputEdge[] = (contract.outputs.edges ?? []).map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to, fields: edge.fields ?? [] }));
  const agentFile = `${path}/plugin.json`;
  let agent: PluginContract['agent'];
  try {
    if (!files.has(agentFile)) return { id, version: contract.version, reads: contract.reads ?? 'unit', vertices, edges, file };
    const declaration: unknown = JSON.parse(files.text(agentFile)!);
    if (!Value.Check(PluginManifest, declaration)) {
      findings.push({ file: agentFile, line: 1, message: `the plugin manifest ${agentFile} does not fit its declaration: ${[...Value.Errors(PluginManifest, declaration)][0]?.message ?? 'invalid manifest'}` });
    } else agent = declaration.agent;
  } catch (error) {
    findings.push({ file: agentFile, line: 1, message: `the plugin manifest ${agentFile} cannot be read: ${(error as Error).message}` });
  }
  return { id, version: contract.version, reads: contract.reads ?? 'unit', vertices, edges, file, ...(agent === undefined ? {} : { agent }) };
}

/**
 * The bounds a plugin's manifest entry declares for one run of its agent part (decision 0035, item 22), read whole: a
 * bound the engine cannot hold a run to is the manifest's error, named with its line, and never a silently dropped one.
 * `undefined` means the entry declares no bounds at all.
 */
function readPluginBounds(value: unknown, id: string, manifestFile: string, line: number, findings: Finding[]): PluginBounds | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push({ file: manifestFile, line, message: `plugin "${id}": "bounds" is { tokens: <whole number>, cost: { amount: <number>, currency: <code> } }` });
    return undefined;
  }
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => key !== 'tokens' && key !== 'cost');
  if (extra.length > 0) { findings.push({ file: manifestFile, line, message: `plugin "${id}": "${extra[0]}" is not a bound: a plugin's bounds are "tokens" and "cost"` }); return undefined; }
  const tokens = body['tokens'];
  if (tokens !== undefined && (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 1)) {
    findings.push({ file: manifestFile, line, message: `plugin "${id}": "bounds.tokens" is the most tokens one run may spend: a whole number of 1 or more, not ${JSON.stringify(tokens)}` });
    return undefined;
  }
  const cost = body['cost'];
  let declaredCost: PluginBounds['cost'];
  if (cost !== undefined) {
    const held = cost !== null && typeof cost === 'object' && !Array.isArray(cost) ? cost as Record<string, unknown> : undefined;
    const amount = held?.['amount'];
    const currency = held?.['currency'];
    const costExtra = held === undefined ? [] : Object.keys(held).filter((key) => key !== 'amount' && key !== 'currency');
    if (held === undefined || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || typeof currency !== 'string' || currency.trim() === '' || costExtra.length > 0) {
      findings.push({ file: manifestFile, line, message: `plugin "${id}": "bounds.cost" is { amount: <a positive number>, currency: <the unit the agent reports> }, not ${JSON.stringify(cost)}` });
      return undefined;
    }
    declaredCost = { amount, currency: currency.trim() };
  }
  if (tokens === undefined && declaredCost === undefined) {
    findings.push({ file: manifestFile, line, message: `plugin "${id}": "bounds" declares no bound: name "tokens", "cost" or leave the key out` });
    return undefined;
  }
  return { ...(tokens === undefined ? {} : { tokens }), ...(declaredCost === undefined ? {} : { cost: declaredCost }) };
}

/** The line a JSON document's nth path segment stands on: the nth occurrence of its quoted name, or the first line. */
function jsonLine(text: string, segment: number): number {
  if (segment === 0) return 1;
  let at = 0;
  for (let seen = 0, index = text.indexOf('"'); index >= 0 && seen < segment; index = text.indexOf('"', index + 1), seen += 1) at = index;
  return text.slice(0, at).split('\n').length;
}

export function parseKinds(text: string, file: string, productFolder: string, files: ProductFileRead = workingTreeFiles(productFolder)): KindsManifest {
  const findings: Finding[] = [];
  const { doc, lines } = parsedManifest(text, file);
  const at = (path: (string | number)[]): number => lineForPath(doc, lines, path);
  for (const problem of doc.errors) findings.push({ file, line: problem.linePos?.[0].line ?? 1, message: problem.message.split('\n')[0] ?? problem.message });
  if (doc.errors.length > 0) return nothing(file, findings);
  const root: unknown = doc.toJS();
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return nothing(file, [{ file, line: 1, message: 'the manifest is a mapping with a "kinds" mapping in it' }]);
  }
  const top = root as Record<string, unknown>;
  let language: string | undefined;
  let diagram: string | undefined;
  for (const key of Object.keys(top)) {
    if (key === 'language') {
      const value = top['language'];
      if (typeof value !== 'string' || !LABEL_LANGUAGES.includes(value)) findings.push({ file, line: at(['language']), message: `"language" is ${JSON.stringify(value)}: the pages are written in ${LABEL_LANGUAGES.join(' or ')}` });
      else language = value;
    } else if (key === 'diagram') {
      const value = top['diagram'];
      if (typeof value !== 'string' || !DIAGRAM_RENDERER_NAMES.includes(value)) findings.push({ file, line: at(['diagram']), message: `"diagram" is ${JSON.stringify(value)}: the diagrams open on ${DIAGRAM_RENDERER_NAMES.join(', ')}` });
      else diagram = value;
    } else if (key !== 'purposes' && key !== 'kinds' && key !== 'groups' && key !== 'documents' && key !== 'roles' && key !== 'problems' && key !== 'properties' && key !== 'catalog' && key !== 'mapping' && key !== 'edges' && key !== 'plugins' && key !== 'journal') findings.push({ file, line: at([key]), message: `"${key}" is not a field of the manifest: the manifest holds "kinds", "edges", "plugins", "groups", "purposes", "documents", "roles", "problems", "properties", "catalog", "mapping", "language", "diagram" and "journal"` });
  }
  const properties = new Map<string, PropertyDecl>();
  const rawProperties = top['properties'];
  if (rawProperties !== undefined) {
    if (rawProperties === null || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
      findings.push({ file, line: at(['properties']), message: '"properties" maps a property name to { en, ru, format? }' });
    } else {
      for (const [name, entry] of Object.entries(rawProperties as Record<string, unknown>)) {
        const line = at(['properties', name]);
        if (name.trim() === '') { findings.push({ file, line, message: 'a property name is a name, not the empty string' }); continue; }
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { findings.push({ file, line, message: `property "${name}": the declaration is { en, ru, format? }` }); continue; }
        const body = entry as Record<string, unknown>;
        for (const key of Object.keys(body)) if (key !== 'en' && key !== 'ru' && key !== 'format' && key !== 'fields') findings.push({ file, line: at(['properties', name, key]), message: `property "${name}": "${key}" is not a field of a property: the fields are en, ru and format` });
        const labels: Record<string, string> = {};
        for (const language of LABEL_LANGUAGES) {
          const text = body[language];
          if (typeof text !== 'string' || text.trim() === '') findings.push({ file, line: at(['properties', name, language]), message: `property "${name}": "${language}" is the word a reader sees` });
          else labels[language] = text;
        }
        const format = body['format'] ?? 'text';
        if (typeof format !== 'string' || !(PROPERTY_FORMATS as readonly string[]).includes(format)) findings.push({ file, line: at(['properties', name, 'format']), message: `property "${name}": "format" is one of ${PROPERTY_FORMATS.join(', ')}, got ${JSON.stringify(format)}` });
        const fields = propertyFields(name, body['fields'], at, findings, file);
        if (Object.keys(labels).length === LABEL_LANGUAGES.length && typeof format === 'string' && (PROPERTY_FORMATS as readonly string[]).includes(format)) {
          properties.set(name, { name, labels, format: format as PropertyFormat, line, ...(fields.size === 0 ? {} : { fields }) });
        }
      }
    }
  }
  const problems = parseProblems(top['problems'], at, findings, file);
  const purposes = new Map<string, PurposeDecl>();
  const rawPurposes = top['purposes'];
  if (rawPurposes !== undefined) {
    if (rawPurposes === null || typeof rawPurposes !== 'object' || Array.isArray(rawPurposes)) findings.push({ file, line: at(['purposes']), message: 'purposes maps ids to { labels: { en, ru }, order: integer }' });
    else for (const [id, raw] of Object.entries(rawPurposes)) {
      const path = ['purposes', id];
      const problem = (key: string, message: string): void => { findings.push({ file, line: at([...path, key]), message: `purpose "${id}": ${message}` }); };
      const start = findings.length;
      if (!id.trim() || raw === null || typeof raw !== 'object' || Array.isArray(raw)) { problem('', 'expected { labels: { en, ru }, order: integer }'); continue; }
      const body = raw as Record<string, unknown>;
      for (const key of Object.keys(body)) if (!['labels', 'order'].includes(key)) problem(key, `unknown field "${key}"`);
      const labels = body['labels'] as Record<string, unknown> | undefined;
      if (labels === null || typeof labels !== 'object' || Array.isArray(labels) || Object.keys(labels).length !== LABEL_LANGUAGES.length || LABEL_LANGUAGES.some((lang) => typeof labels[lang] !== 'string' || !(labels[lang] as string).trim())) problem('labels', `labels names each language (${LABEL_LANGUAGES.join(', ')})`);
      if (!Number.isSafeInteger(body['order'])) problem('order', 'order is a safe integer');
      if (findings.length === start) purposes.set(id, { id, labels: labels as Record<string, string>, order: body['order'] as number, line: at(path) });
    }
  }
  const groups = new Map<string, GroupDecl>();
  /** The groups whose `parent` the reader refused: their own finding covers the defect, and no other rule repeats it. */
  const refusedGroupParents = new Set<string>();
  /** The groups whose `short` label was refused: their own finding covers it, and the group itself still stands. */
  const refusedShortLabels = new Set<string>();
  const rawGroups = top['groups'];
  if (rawGroups !== undefined) {
    if (rawGroups === null || typeof rawGroups !== 'object' || Array.isArray(rawGroups)) findings.push({ file, line: at(['groups']), message: '"groups" maps a group name to its name in each language (en, ru)' });
    else {
      for (const [name, entry] of Object.entries(rawGroups as Record<string, unknown>)) {
        const body = entry as Record<string, unknown> | null;
        const line = at(['groups', name]);
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
          findings.push({ file, line, message: `group "${name}": the group is { en: <its name>, ru: <its name> }` });
          continue;
        }
        const labels: Record<string, string> = {};
        const short: Record<string, string> = {};
        let parent: string | undefined;
        let open: boolean | undefined;
        let bad = false;
        const rawShort = body['short'];
        if (rawShort !== undefined) {
          // A short label that is not usable is a finding of its own, and the group still stands: the navigation falls
          // back to the full name, and no other rule repeats the defect (one defect, one problem).
          let shortProblem = false;
          if (rawShort === null || typeof rawShort !== 'object' || Array.isArray(rawShort)) { findings.push({ file, line: at(['groups', name, 'short']), message: `group "${name}": "short" is { en: <its short label>, ru: <its short label> }` }); shortProblem = true; }
          else {
            for (const [language, label] of Object.entries(rawShort as Record<string, unknown>)) {
              if (!LABEL_LANGUAGES.includes(language)) { findings.push({ file, line: at(['groups', name, 'short', language]), message: `group "${name}": "short" holds a label per language (${LABEL_LANGUAGES.join(', ')}), got "${language}"` }); shortProblem = true; continue; }
              if (typeof label !== 'string' || label.trim() === '') { findings.push({ file, line: at(['groups', name, 'short', language]), message: `group "${name}": the short label in "${language}" is one or two words` }); shortProblem = true; continue; }
              if (Array.from(label).length > GROUP_SHORT_LABEL_LIMIT) { findings.push({ file, line: at(['groups', name, 'short', language]), message: `group "${name}": the short label in "${language}" is ${Array.from(label).length} code points, and the navigation holds ${GROUP_SHORT_LABEL_LIMIT} without cutting it: give it one or two words` }); shortProblem = true; continue; }
              short[language] = label;
            }
            if (!shortProblem && Object.keys(short).length !== LABEL_LANGUAGES.length) {
              findings.push({ file, line: at(['groups', name, 'short']), message: `group "${name}": "short" names a label in each language (${LABEL_LANGUAGES.join(', ')}), and it names ${Object.keys(short).join(', ') || 'none'}` });
              shortProblem = true;
            }
          }
          if (shortProblem) refusedShortLabels.add(name);
        }
        for (const [language, label] of Object.entries(body)) {
          if (language === 'open') {
            if (typeof label !== 'boolean') findings.push({ file, line: at(['groups', name, 'open']), message: `group "${name}": "open" is true or absent` });
            else open = label;
          } else if (language === 'short') { continue; } else if (language === 'parent') {
            if (typeof label !== 'string' || label.trim() === '') { findings.push({ file, line: at(['groups', name, 'parent']), message: `group "${name}": "parent" is the name of a group of "groups"` }); bad = true; }
            else parent = label;
          } else if (!LABEL_LANGUAGES.includes(language)) { findings.push({ file, line: at(['groups', name, language]), message: `group "${name}": "${language}" is not a language of the wiki: the languages are ${LABEL_LANGUAGES.join(', ')}` }); bad = true; }
          else if (typeof label !== 'string' || label.trim() === '') { findings.push({ file, line: at(['groups', name, language]), message: `group "${name}": the name in "${language}" is a text` }); bad = true; }
          else labels[language] = label;
        }
        if (!bad) groups.set(name, { name, labels, line, ...(Object.keys(short).length === LABEL_LANGUAGES.length ? { short } : {}), ...(parent === undefined ? {} : { parent }), ...(open === undefined ? {} : { open }) });
      }
      // A sub-area names a group that stands beside it. Two levels would hide the
      // catalogue's shape, so a group whose parent is itself a sub-area is a finding.
      // Every invalid edge is also discarded: the app draws top-level groups by a
      // parent that is absent, so a kept edge would hide the group from the
      // navigation while the finding names it (madarch-m38l.24, the review). A
      // cycle — a names b and b names a — fails at both edges and both stand at
      // the top level; the check reads the edges as they were written, so neither
      // edge can make the other look valid while they are discarded one by one.
      const invalidParents = new Map<string, { line: number; message: string }>();
      for (const group of groups.values()) {
        if (group.parent === undefined) continue;
        const line = at(['groups', group.name, 'parent']);
        if (group.parent === group.name) {
          invalidParents.set(group.name, { line, message: `group "${group.name}": "parent" cannot name the group itself` });
          continue;
        }
        const parent = groups.get(group.parent);
        if (parent === undefined) {
          invalidParents.set(group.name, { line, message: `group "${group.name}": "parent" names a group of "groups" (${[...groups.keys()].join(', ') || 'none is declared'}), got ${JSON.stringify(group.parent)}` });
        } else if (parent.parent !== undefined) {
          invalidParents.set(group.name, { line, message: `group "${group.name}": "parent" names "${parent.name}", which is itself a sub-area: sub-areas are one level deep` });
        }
      }
      for (const [name, invalid] of invalidParents) {
        findings.push({ file, line: invalid.line, message: invalid.message });
        refusedGroupParents.add(name);
        delete groups.get(name)!.parent;
      }
    }
  }
  // The entity catalog's schema (decision 0033, items 8 to 10): the bound of a subgroup, the origin marks, the
  // statuses, the template policies, the attributes and the relation names. It is read before the kinds, whose rows
  // it validates; a manifest without one keeps every kind it declares as the wiki read it before the catalog.
  // A manifest that declares a catalog at all is read against it; one whose `catalog:` mapping cannot be read keeps its
  // kinds and reports the schema's own findings rather than a field of the catalog on every kind.
  const catalogDeclared = top['catalog'] !== undefined;
  const catalogRead = catalogDeclared ? readCatalogSchema(top['catalog'], at, file) : undefined;
  const catalogSchema = catalogRead?.schema;
  const catalogEntries = new Map<string, CatalogEntry>();
  const catalogFound: Finding[] = [];
  if (catalogRead !== undefined) {
    findings.push(...catalogRead.findings);
    catalogFound.push(...catalogRead.findings);
  }
  const roles = new Map<string, RoleDecl>();
  /** The groups the roles' `lead` lists name, sound or not: the POV rule reads the declarations, so one refused role
   * declaration does not make its areas look unled (one defect, one problem). */
  const declaredLeads = new Set<string>();
  let rolesDeclared = false;
  /** A role's declaration the reader could not open: its leads are unknown, so the POV's coverage is not judged. */
  let roleDeclarationUnreadable = false;
  const rawRoles = top['roles'];
  if (rawRoles !== undefined) {
    rolesDeclared = true;
    if (rawRoles === null || typeof rawRoles !== 'object' || Array.isArray(rawRoles)) findings.push({ file, line: at(['roles']), message: '"roles" maps each role the product declares to { open: [<block>, ...], lead: [<area or subgroup>, ...] }' });
    else {
      for (const [name, entry] of Object.entries(rawRoles as Record<string, unknown>)) {
        const line = at(['roles', name]);
        // The leads a role declares are read before its declaration is judged: a role with a defect still tells the
        // POV which areas it leads, so one defect is one problem (the unled-area rule does not echo it).
        {
          const leads = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>)['lead'] : undefined;
          if (Array.isArray(leads)) for (const group of leads) if (typeof group === 'string' && groups.has(group)) declaredLeads.add(group);
        }
        // A role's name is the product's: the engine keeps no list of them. "everything" is every role at once.
        if (name.trim() === '' || name.trim() !== name || /\s/.test(name)) { findings.push({ file, line, message: `role ${JSON.stringify(name)}: a role's name is one word without whitespace` }); continue; }
        if (name === EVERY_ROLE) { findings.push({ file, line, message: `role "${name}": "everything" is every role at once and is not declared` }); continue; }
        const body = entry as Record<string, unknown> | null;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) { roleDeclarationUnreadable = true; findings.push({ file, line, message: `role "${name}": the declaration is { open: [<block>, ...], lead: [<group>, ...] }` }); continue; }
        const before = findings.length;
        for (const key of Object.keys(body)) if (key !== 'open' && key !== 'lead') findings.push({ file, line: at(['roles', name, key]), message: `role "${name}": "${key}" is not a field of a role: the fields are "open" and "lead"` });
        const list = (field: 'open' | 'lead'): string[] | undefined => {
          const value = body[field];
          if (value === undefined) return undefined;
          if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
            if (field === 'lead') roleDeclarationUnreadable = true; // the role's leads are unknown: the POV is not judged
            findings.push({ file, line: at(['roles', name, field]), message: `role "${name}": "${field}" is a list of ${field === 'open' ? 'blocks of the library' : 'groups of "groups"'}` });
            return undefined;
          }
          return value as string[];
        };
        const open = list('open');
        const lead = list('lead');
        for (const block of open ?? []) if (!(BLOCK_NAMES as readonly string[]).includes(block)) findings.push({ file, line: at(['roles', name, 'open']), message: `role "${name}": "${block}" is not a block of the library (${BLOCK_NAMES.join(', ')})` });
        for (const group of lead ?? []) {
          if (!groups.has(group)) findings.push({ file, line: at(['roles', name, 'lead']), message: `role "${name}": "${group}" is not a group of "groups" (${[...groups.keys()].join(', ') || 'none is declared'})` });
          else declaredLeads.add(group);
        }
        if (findings.length === before) roles.set(name, { name, ...(open === undefined ? {} : { open }), lead: lead ?? [], line });
      }
      // The POV covers the catalog (decision 0033, item 12): every area is led by at least one role, whether the role
      // names the area or a subgroup of it. A catalog with no role declared has no POV to check; a manifest without a
      // catalog is read as before the catalog.
      if (catalogSchema !== undefined && rolesDeclared && !roleDeclarationUnreadable) {
        const led = declaredLeads;
        const all = [...groups.values()];
        for (const area of all.filter((group) => group.parent === undefined)) {
          if (refusedGroupParents.has(area.name)) continue; // its own finding names the parent nobody declares
          if (led.has(area.name) || all.some((subgroup) => subgroup.parent === area.name && led.has(subgroup.name))) continue;
          findings.push({ file, line: at(['groups', area.name]), message: `area "${area.name}": no role leads it, and every area is led by a role or by one of its subgroups (the roles are ${[...roles.keys()].join(', ')})` });
        }
      }
    }
  }
  // The navigation names every group by a short label (decision 0033's two levels, shown in a 240 px column):
  // with a catalog declared, a group without one would be cut off at the sidebar's width.
  if (catalogSchema !== undefined) {
    for (const group of groups.values()) {
      // A group whose `parent` was refused already carries that finding: no second rule repeats it.
      if (group.short !== undefined || refusedGroupParents.has(group.name) || refusedShortLabels.has(group.name)) continue;
      findings.push({ file, line: at(['groups', group.name]), message: `group "${group.name}": no "short" label, and the navigation names every group by one or two words ("short: { en, ru }")` });
    }
  }
  const excludeDocuments: string[] = [];
  // Block kinds the product says hold no meaning of their own: a fence or an html comment is furniture, and the manifest
  // names it rather than the reader guessing (the review of the eighth pass, finding 1).
  const ignoredBlocks: string[] = [];
  const expected: ExpectedKind[] = [];
  const rawDocuments = top['documents'];
  if (rawDocuments !== undefined) {
    const body = rawDocuments as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) findings.push({ file, line: at(['documents']), message: '"documents" is { exclude: [<path pattern>, ...], expect: [<kind>, ...] }' });
    else {
      for (const key of Object.keys(body)) if (key !== 'exclude' && key !== 'expect' && key !== 'ignore') findings.push({ file, line: at(['documents', key]), message: `"${key}" is not a field of "documents": the fields are "exclude", "expect" and "ignore"` });
      const ignore = body['ignore'];
      if (ignore !== undefined) {
        if (!Array.isArray(ignore) || ignore.some((entry) => typeof entry !== 'string' || entry.trim() === '')) findings.push({ file, line: at(['documents', 'ignore']), message: '"ignore" is a list of block kinds a document may hold without a page, such as "code" or "html"' });
        else ignoredBlocks.push(...(ignore as string[]));
      }
      const exclude = body['exclude'];
      if (exclude !== undefined) {
        if (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== 'string' || entry.trim() === '')) findings.push({ file, line: at(['documents', 'exclude']), message: '"exclude" is a list of path patterns of documents the wiki does not list, such as "AGENTS.md" or "**/CHANGELOG.md"' });
        else excludeDocuments.push(...(exclude as string[]));
      }
      // The general kinds the documents are expected to hold: one that no section is read as is a finding, never a smaller wiki.
      const expect = body['expect'];
      if (expect !== undefined) {
        if (!Array.isArray(expect) || expect.some((entry) => typeof entry !== 'string' || entry.trim() === '')) findings.push({ file, line: at(['documents', 'expect']), message: '"expect" is a list of the kinds of "kinds" the documents must hold, such as "doc.use-case" or "doc.quality"' });
        else (expect as string[]).forEach((kind, index) => expected.push({ kind, line: at(['documents', 'expect', index]) }));
      }
    }
  }
  const declared = top['kinds'];
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    findings.push({ file, line: at(['kinds']), message: '"kinds" is a mapping of kind names to their declarations' });
    return { ...nothing(file, findings), groups, roles, excludeDocuments, ignoreBlocks: ignoredBlocks };
  }
  const kinds = new Map<string, KindDecl>();
  const declaredTemplates: string[] = [];
  // A kind's missing translation is a finding, but not a reason to leave its page out: the kinds a product has not
  // translated yet still show, marked as untranslated. These findings join the manifest's at the end of the read.
  const wordsFound: Finding[] = [];
  // Every name the manifest declares, sound or not: the mapping resolves a kind against the declaration, and the
  // catalog's own finding is the one a refused kind carries (one defect, one problem on the Problems page).
  for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
    const line = at(['kinds', name]);
    const problem = (path: (string | number)[], message: string): void => {
      // A field that is absent has no line of its own: the problem stands at the kind.
      const written = path.length === 0 || (value !== null && typeof value === 'object' && String(path[0]) in (value as object));
      findings.push({ file, line: written ? at(['kinds', name, ...path]) : line, message: `kind "${name}": ${message}` });
    };
    // The catalog's own findings, kept apart from the manifest's others: `bun run check:catalog` reads them over the
    // starter set, where the product has no documents yet and the document expectations are the product's own matter.
    const catalogProblem = (path: (string | number)[], message: string): void => {
      const before = findings.length;
      problem(path, message);
      catalogFound.push(...findings.slice(before));
    };
    // The catalogue's words are read apart: a missing language is reported, and the kind stays whatever its page shows.
    const wordsProblem = (path: (string | number)[], message: string): void => {
      const before = findings.length;
      problem(path, message);
      wordsFound.push(...findings.splice(before));
    };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      findings.push({ file, line, message: `kind "${name}": the declaration is a mapping with a template and a source` });
      continue;
    }
    const decl = value as Record<string, unknown>;
    const before = findings.length;
    for (const key of Object.keys(decl)) if (!KIND_KEYS.has(key)) problem([key], `"${key}" is not a field of a kind: the fields are ${[...KIND_KEYS].join(', ')}`);
    // The catalog's row of the kind: its place, its meaning, its sources, its acquisition, its status, the relations
    // it may carry and its template policy. A row with a problem leaves the kind out, like every other problem does;
    // a kind the catalog declares with the policy "none" is catalogue data only and shows no page.
    if (!catalogDeclared) {
      const stray = Object.keys(decl).filter((key) => CATALOG_ONLY_FIELDS.has(key));
      if (stray.length > 0) catalogProblem([stray[0]!], `"${stray[0]}" is a field of the entity catalog, and the manifest declares no "catalog"`);
    } else if (catalogSchema !== undefined) {
      const entry = readCatalogKind(name, decl, catalogSchema, groups, line, catalogProblem, wordsProblem, LABEL_LANGUAGES, refusedGroupParents);
      if (entry !== undefined) catalogEntries.set(name, entry);
    }
    const audienceOf = (raw: unknown, path: (string | number)[]): readonly string[] | undefined => {
      if (raw === undefined) return undefined;
      if (!Array.isArray(raw) || raw.length === 0 || raw.some((role) => typeof role !== 'string' || !roles.has(role)) || new Set(raw).size !== raw.length) {
        problem(path, `audience is a nonempty list of distinct declared roles (${[...roles.keys()].join(', ')})`);
        return undefined;
      }
      return raw as string[];
    };
    const audience = audienceOf(decl['audience'], ['audience']);
    const purpose = decl['purpose'];
    if ((rawPurposes !== undefined || purpose !== undefined) && (typeof purpose !== 'string' || !purposes.has(purpose))) catalogProblem(['purpose'], `purpose names a declared purpose (${[...purposes.keys()].join(', ')}), got ${JSON.stringify(purpose)}`);
    const policy = typeof decl['template-policy'] === 'string' ? decl['template-policy'] : 'page';
    if (policy === 'none') {
      for (const field of ['template', 'source', 'folder', 'file', 'member', 'details', 'card', 'history', 'views', 'er', 'sequence', 'system', 'definition-block', 'listing', 'nav'] as const) if (decl[field] !== undefined) catalogProblem([field], `"${field}" belongs to a kind that shows a page, and "template-policy" is "none"`);
      continue;
    }
    const source = decl['source'];
    if (source !== 'graph' && source !== 'markdown' && source !== 'document') problem(['source'], `"source" is "graph", "markdown" or "document", got ${JSON.stringify(source)}`);
    const named = decl['template'];
    // The stamp follows every path a declaration names, even when the declaration is refused below: a template created
    // for a kind that named it missing changes the manifest's findings and the kinds the wiki shows (madarch-u3vw.8).
    if (typeof named === 'string' && named.trim() !== '' && insideFolder(productFolder, named)) declaredTemplates.push(named);
    let template = named;
    if (typeof template !== 'string' || template.trim() === '') problem(['template'], '"template" names the template file in the product repository');
    else if (!insideFolder(productFolder, template)) problem(['template'], `the template "${template}" is not a path inside the product repository`);
    else if (!files.has(template)) {
      // A kind that names a Markdown template of 0029 and a product that holds the Liquid template of the same name (the
      // starter set of 0032 was written beside the old files) is drawn by that one: the rename is madarch's, and a
      // product need not edit its manifest for it (madarch-u3vw.1).
      const liquid = typeof template === 'string' && template.endsWith('.md') ? `${template.slice(0, -'.md'.length)}.liquid` : undefined;
      if (liquid !== undefined && files.has(liquid)) template = liquid;
      else problem(['template'], `the template "${String(named)}" does not exist in the product repository`);
    }
    const importFolder = decl['import-folder'];
    const importFile = decl['import-file'];
    for (const [field, path] of [['import-folder', importFolder], ['import-file', importFile]] as const) {
      if (path !== undefined && (typeof path !== 'string' || !insideFolder(productFolder, path))) problem([field], `"${field}" is a path inside the product repository`);
    }
    if (importFolder !== undefined && importFile !== undefined) problem(['import-folder'], 'an import location names either a folder or a file, not both');
    const folder = decl['folder'];
    const single = decl['file'];
    if (source === 'markdown') {
      if ((folder === undefined) === (single === undefined)) problem([], 'a markdown kind names exactly one of "folder" (many entities) and "file" (one entity)');
      for (const [field, path] of [['folder', folder], ['file', single]] as const) {
        if (path !== undefined && (typeof path !== 'string' || !insideFolder(productFolder, path))) problem([field], `"${field}" is a path inside the product repository`);
      }
    } else if ((source === 'graph' || source === 'document') && (folder !== undefined || single !== undefined)) {
      problem([folder !== undefined ? 'folder' : 'file'], `a ${source} kind has no "folder" or "file": its entities come from the ${source === 'graph' ? 'graph' : 'documents'}`);
    }
    const identifier = decl['identifier'];
    const terms = decl['terms'];
    const names = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
    const identifiers = typeof identifier === 'string' ? [identifier] : identifier;
    if (identifier !== undefined && (!names(identifiers) || !identifiers.every((entry) => entry === '*' || /^[A-Za-z]+$/.test(entry)))) problem(['identifier'], '"identifier" is the letters an identifier opens with ("UC" for UC-2), a list of them, or "*" for any other');
    if (terms !== undefined && !names(terms)) problem(['terms'], '"terms" is a list of path patterns of the documents whose leading bold terms are entities, such as "**/glossary.md"');
    const headings = decl['headings'];
    const names2 = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
    if (headings !== undefined && !names2(headings)) problem(['headings'], '"headings" is a list of the headings whose sections are entities of the kind, such as [Use cases, Qualities]');
    const semantics = decl['semantics'];
    const findingsKind = decl['findings'];
    if (findingsKind !== undefined && typeof findingsKind !== 'boolean') problem(['findings'], '"findings" is true for a kind whose entities are findings, and nothing else');
    if (semantics !== undefined && (typeof semantics !== 'string' || !isSemanticKind(semantics))) problem(['semantics'], `"semantics" is the general kind of the sections: ${SEMANTIC_KINDS.join(', ')}`);
    const structure = decl['structure'];
    if (structure !== undefined && !names2(structure)) problem(['structure'], '"structure" is a list of the sections a section of the kind holds, such as [Status, Context, Decision, Consequences]');
    if (source === 'document' && identifier === undefined && terms === undefined && headings === undefined && semantics === undefined) problem([], 'a document kind names "identifier" (the sections that open with an identifier), "headings" (the headings whose sections are entities of the kind), "terms" (the documents whose bold terms are entities) or "semantics" (the passages the classifier reads of a general kind)');
    // A graph kind whose producer reads documents names them in `terms` and nothing else of the document vocabulary:
    // db-schema reads every TypeScript source, so a product that holds none plans no unit for it.
    const producerBound = Array.isArray(decl['fields']) && (decl['fields'] as unknown[]).some((field) => field !== null && typeof field === 'object' && 'binding' in (field as Record<string, unknown>));
    const termsOfAGraphKind = source === 'graph' && producerBound && terms !== undefined && identifier === undefined && headings === undefined && structure === undefined && semantics === undefined;
    if (source !== 'document' && !termsOfAGraphKind && (identifier !== undefined || terms !== undefined || headings !== undefined || structure !== undefined || semantics !== undefined)) {
      const field = identifier !== undefined ? 'identifier' : terms !== undefined ? 'terms' : headings !== undefined ? 'headings' : structure !== undefined ? 'structure' : 'semantics';
      problem([field], `"${field}" belongs to a document kind`);
    }
    const group = decl['group'];
    // With a catalog declared, the catalog's own row names an unknown subgroup, so the manifest reader stays silent there:
    // one defect is one problem (the Problems page counts them).
    if (catalogSchema === undefined && group !== undefined && (typeof group !== 'string' || !groups.has(group))) problem(['group'], `"group" names a group of "groups" (${[...groups.keys()].join(', ') || 'none is declared'}), got ${JSON.stringify(group)}`);
    const origin = decl['origin'];
    if (origin !== undefined && !ORIGINS.includes(origin as Origin)) problem(['origin'], `"origin" is ${ORIGINS.join(', ')}; got ${JSON.stringify(origin)}`);
    const descriptions: Record<string, string> = {};
    const rawDescription = decl['description'];
    if (rawDescription !== undefined) {
      if (rawDescription === null || typeof rawDescription !== 'object' || Array.isArray(rawDescription)) problem(['description'], `"description" maps a language (${LABEL_LANGUAGES.join(', ')}) to a sentence saying what the kind is`);
      else {
        for (const [language, text] of Object.entries(rawDescription as Record<string, unknown>)) {
          if (!LABEL_LANGUAGES.includes(language)) problem(['description', language], `"${language}" is not a language of the wiki: the languages are ${LABEL_LANGUAGES.join(', ')}`);
          else if (typeof text !== 'string' || text.trim() === '') problem(['description', language], 'a description is a sentence');
          else descriptions[language] = text;
        }
      }
    }
    const title = decl['title'];
    if (title !== undefined && (typeof title !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(title))) problem(['title'], '"title" names an attribute');
    const attributes = decl['attributes'];
    if (attributes !== undefined && (!Array.isArray(attributes) || attributes.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(entry)))) problem(['attributes'], '"attributes" is a list of attribute names');
    const relations: DeclaredRelation[] = [];
    const rawRelations = decl['relations'];
    if (rawRelations !== undefined) {
      if (!Array.isArray(rawRelations)) problem(['relations'], '"relations" is a list of { type, to }');
      else {
        rawRelations.forEach((entry: unknown, index) => {
          const body = entry as Record<string, unknown> | null;
          if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['type'] !== 'string' || typeof body['to'] !== 'string' || body['type'] === '' || body['to'] === '') {
            problem(['relations', index], 'a relation is { type: <relation type>, to: <key of the other end> }');
            return;
          }
          const extra = Object.keys(body).filter((key) => key !== 'type' && key !== 'to');
          if (extra.length > 0) problem(['relations', index, extra[0]!], `"${extra[0]}" is not a field of a relation: the fields are type and to`);
          else relations.push({ type: body['type'], to: body['to'], line: at(['kinds', name, 'relations', index])});
        });
      }
    }
    const card = decl['card'];
    if (card !== undefined && typeof card !== 'boolean') problem(['card'], `"card" is true or absent: a ground on one of the kind's entities shows its card, and the entity's code is shown when it is absent`);
    const history = decl['history'];
    if (history !== undefined && !isHistoryShape(history)) problem(['history'], `"history" is the shape of the story the history block tells of the kind: ${HISTORY_SHAPES.join(', ')}, got ${JSON.stringify(history)}`);
    // The views a page of the kind may draw, and the traits the engine draws them by: each field names one thing of a
    // small vocabulary the engine defines, and the manifest says which kind has it (decision 0033: the engine holds no
    // kind of its own). A value the engine cannot read is a finding at the field's line, and the kind is left out.
    const oneOf = <T extends string>(field: string, vocabulary: readonly T[]): T | undefined => {
      const value = decl[field];
      if (value === undefined) return undefined;
      if (typeof value === 'string' && (vocabulary as readonly string[]).includes(value)) return value as T;
      problem([field], `"${field}" is one of ${vocabulary.join(', ')}, got ${JSON.stringify(value)}`);
      return undefined;
    };
    const declaredViews: KindView[] = [];
    const rawViews = decl['views'];
    if (rawViews !== undefined) {
      if (!Array.isArray(rawViews) || rawViews.length === 0 || rawViews.some((entry) => typeof entry !== 'string' || !(KIND_VIEWS as readonly string[]).includes(entry))) problem(['views'], `"views" lists the views a page of the kind may draw of its entities: ${KIND_VIEWS.join(', ')}, got ${JSON.stringify(rawViews)}`);
      else if (new Set(rawViews).size !== rawViews.length) problem(['views'], `"views" names each view once, and ${JSON.stringify(rawViews)} names one twice`);
      else declaredViews.push(...(rawViews as KindView[]));
    }
    const er = oneOf('er', ER_FORMS);
    const sequence = oneOf('sequence', SEQUENCE_FORMS);
    const system = oneOf('system', SYSTEM_PARTS);
    const definition = oneOf('definition-block', DEFINITION_FORMS);
    const listing = oneOf('listing', LISTING_FORMS);
    const nav = oneOf('nav', NAV_TRAITS);
    const details: string[] = [];
    const rawDetails = decl['details'];
    if (rawDetails !== undefined) {
      if (!Array.isArray(rawDetails) || rawDetails.some((entry) => typeof entry !== 'string' || entry.trim() === '')) problem(['details'], '"details" is a list of the property names the page shows, in their order');
      else for (const name of rawDetails as string[]) {
        if (!properties.has(name)) problem(['details'], `"details" names the property ${JSON.stringify(name)}, and "properties" does not declare it`);
        else details.push(name);
      }
    }
    let member: MemberDecl | undefined;
    const rawMember = decl['member'];
    if (rawMember !== undefined) {
      if (rawMember === null || typeof rawMember !== 'object' || Array.isArray(rawMember)) problem(['member'], '"member" is { relation, direction, parentKind?, property? }');
      else {
        const body = rawMember as Record<string, unknown>;
        for (const key of Object.keys(body)) if (key !== 'relation' && key !== 'direction' && key !== 'parentKind' && key !== 'property') problem(['member', key], `"${key}" is not a field of "member": the fields are relation, direction, parentKind and property`);
        const relation = body['relation'];
        const direction = body['direction'];
        const parentKind = body['parentKind'];
        const property = body['property'];
        if (typeof relation !== 'string' || relation.trim() === '') problem(['member', 'relation'], '"relation" is the edge from a member to the entity whose page it belongs to');
        if (direction !== 'out' && direction !== 'in') problem(['member', 'direction'], '"direction" is "out" (the member names the parent) or "in" (the parent contains the member)');
        if (parentKind !== undefined && (typeof parentKind !== 'string' || parentKind.trim() === '')) problem(['member', 'parentKind'], '"parentKind" is the kind of the parent entity');
        if (property !== undefined && (typeof property !== 'string' || property.trim() === '')) problem(['member', 'property'], '"property" names the member property that holds the parent key, when the graph holds no edge');
        if (typeof relation === 'string' && relation.trim() !== '' && (direction === 'out' || direction === 'in')) member = { relation, direction, ...(typeof parentKind === 'string' && parentKind.trim() !== '' ? { parentKind } : {}), ...(typeof property === 'string' && property.trim() !== '' ? { property } : {}), line: at(['kinds', name, 'member']) };
      }
    }
    const fieldTypes = new Set(['text', 'integer', 'bigint', 'boolean', 'timestamp', 'json']);
    const parseFields = (raw: unknown, field: string): FieldDecl[] => {
      if (raw === undefined) return [];
      if (!Array.isArray(raw)) { problem([field], `"${field}" is a list of { name, type, nullable?, producers?, reference?, binding? }`); return []; }
      const out: FieldDecl[] = [];
      raw.forEach((entry: unknown, index) => {
        const body = entry as Record<string, unknown> | null;
        if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['name'] !== 'string' || !/^[a-z][a-z0-9_]*$/.test(body['name']) || typeof body['type'] !== 'string' || !fieldTypes.has(body['type'])) {
          problem([field, index], 'a field is { name: <lower-case identifier>, type: text|integer|bigint|boolean|timestamp|json, nullable?: true, producers?: [<producer>], reference?: <kind>, binding?: "<plugin>@<major>.<field>" | { agent: <description> } }');
          return;
        }
        // Nothing is authoritative and nothing is claimed: the word "role" left the manifest's field language, and a
        // manifest that still says it is refused where it says it.
        if (body['role'] !== undefined) { problem([field, index, 'role'], '"role" is gone: no field is authoritative and none is claimed — every value a producer states is an opinion'); return; }
        const extra = Object.keys(body).filter((key) => key !== 'name' && key !== 'type' && key !== 'nullable' && key !== 'producers' && key !== 'reference' && key !== 'binding' && key !== 'evidence');
        if (extra.length > 0) { problem([field, index, extra[0]!], `"${extra[0]}" is not a field of a field: the fields are name, type, nullable, evidence, producers, reference and binding`); return; }
        if (body['evidence'] !== undefined && typeof body['evidence'] !== 'boolean') { problem([field, index, 'evidence'], '"evidence" is true or false'); return; }
        const producers = body['producers'];
        if (producers !== undefined && (!Array.isArray(producers) || producers.length === 0 || producers.some((one) => typeof one !== 'string' || !/^[a-z][a-z0-9-]*$/.test(one)))) {
          problem([field, index, 'producers'], '"producers" is a list of producer names, each a lower-case identifier'); return;
        }
        const reference = body['reference'];
        if (reference !== undefined && (typeof reference !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(reference))) { problem([field, index, 'reference'], '"reference" names a kind of the manifest'); return; }
        const binding = parseBinding(body['binding'], [field, index, 'binding']);
        if (binding === null) return;
        out.push({
          name: body['name'],
          type: body['type'] as FieldDecl['type'],
          ...(body['nullable'] === true ? { nullable: true } : {}),
          ...(typeof body['evidence'] === 'boolean' ? { evidence: body['evidence'] } : {}),
          ...(producers === undefined ? {} : { producers: producers as string[] }),
          ...(reference === undefined ? {} : { reference }),
          ...(binding === undefined ? {} : { binding }),
          line: at(['kinds', name, field, index]),
        });
      });
      return out;
    };
    /** The producer one field names: `"<plugin>@<major>.<field>"`, or `{ agent: <description> }`. */
    const parseBinding = (raw: unknown, path: (string | number)[]): FieldBinding | undefined | null => {
      if (raw === undefined) return undefined;
      if (typeof raw === 'string') {
        const parsed = BINDING_PATTERN.exec(raw);
        if (parsed === null) { problem(path, `"binding" is "<plugin>@<major>.<field>" (a plugin id, the major version the manifest binds, and a field the plugin declares), and is ${JSON.stringify(raw)}`); return null; }
        return { kind: 'plugin', plugin: parsed[1]!, major: parsed[2]!, field: parsed[3]! };
      }
      const body = raw as Record<string, unknown> | null;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) { problem(path, '"binding" is "<plugin>@<major>.<field>" or { agent: <what the field is and how to extract it> }'); return null; }
      const extra = Object.keys(body).filter((key) => key !== 'agent');
      if (extra.length > 0) { problem([...path, extra[0]!], `"${extra[0]}" is not a field of a binding: a binding names a plugin field, or the agent with { agent: <description> }`); return null; }
      const description = body['agent'];
      if (typeof description !== 'string' || description.trim() === '') { problem([...path, 'agent'], '"agent" says what the field is and how to extract it'); return null; }
      return { kind: 'agent', description };
    };
    const fields = parseFields(decl['fields'], 'fields');
    const facts: FactDecl[] = [];
    const rawFacts = decl['facts'];
    if (rawFacts !== undefined && !Array.isArray(rawFacts)) problem(['facts'], 'facts is a list of declared aggregates');
    if (Array.isArray(rawFacts)) rawFacts.forEach((raw: unknown, index) => {
      const path = ['facts', index] as (string | number)[];
      if (!isRecord(raw)) { problem(path, 'a fact is a mapping'); return; }
      const start = findings.length;
      for (const key of Object.keys(raw)) if (!['id', 'labels', 'measure', 'display', 'field', 'buckets', 'limit', 'audience'].includes(key)) problem([...path, key], `unknown fact field "${key}"`);
      if (typeof raw['id'] !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(raw['id']) || facts.some((fact) => fact.id === raw['id'])) problem([...path, 'id'], 'a fact id is a unique lower-case identifier');
      const labels = raw['labels'];
      if (!isRecord(labels) || Object.keys(labels).some((key) => !LABEL_LANGUAGES.includes(key)) || LABEL_LANGUAGES.some((lang) => typeof labels[lang] !== 'string' || (labels[lang] as string).trim() === '')) problem([...path, 'labels'], `fact labels must name every language (${LABEL_LANGUAGES.join(', ')})`);
      const measure = raw['measure'];
      if (!['count', 'group-by', 'histogram', 'top-n'].includes(String(measure))) problem([...path, 'measure'], 'measure is count, group-by, histogram or top-n');
      if (!['number', 'bar', 'treemap', 'timeline'].includes(String(raw['display']))) problem([...path, 'display'], 'display is number, bar, treemap or timeline');
      if ((measure === 'count' && raw['display'] !== 'number') || (measure !== 'count' && raw['display'] === 'number')) problem([...path, 'display'], 'count displays a number; grouped, histogram and top-n facts display bar, treemap or timeline');
      const field = fields.find((field) => field.name === raw['field']);
      if (measure !== 'count' && field === undefined) problem([...path, 'field'], 'a fact must name a declared field');
      if (measure === 'count' && raw['field'] !== undefined) problem([...path, 'field'], 'count has no field');
      if (measure === 'group-by' && field?.type === 'json') problem([...path, 'field'], 'group-by requires a scalar field');
      if (measure === 'histogram' && field?.type !== 'timestamp') problem([...path, 'field'], 'histogram requires a timestamp field');
      if (measure === 'top-n' && field?.type !== 'integer' && field?.type !== 'bigint') problem([...path, 'field'], 'top-n requires a numeric field');
      const buckets = raw['buckets'];
      if (measure === 'histogram') {
        if (!Array.isArray(buckets) || buckets.length === 0 || buckets.some((n, i) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || (i > 0 && n <= buckets[i - 1]))) problem([...path, 'buckets'], 'histogram buckets are increasing positive day bounds');
      } else if (buckets !== undefined) problem([...path, 'buckets'], 'only histogram declares buckets');
      if (measure === 'top-n') {
        if (typeof raw['limit'] !== 'number' || !Number.isInteger(raw['limit']) || raw['limit'] < 1) problem([...path, 'limit'], 'top-n requires a positive integer limit');
      } else if (raw['limit'] !== undefined) problem([...path, 'limit'], 'only top-n declares a limit');
      const factAudience = audienceOf(raw['audience'], [...path, 'audience']);
      if (start === findings.length) facts.push({ ...raw, ...(factAudience === undefined ? {} : { audience: factAudience }) } as unknown as FactDecl);
    });
    const key = decl['key'];
    if (key !== undefined && (!Array.isArray(key) || (key.length === 0 && origin !== 'person') || key.some((entry) => typeof entry !== 'string' || !fields.some((field) => field.name === entry)))) problem(['key'], '"key" is a list of the field names the kind\'s natural key holds');
    const capability = decl['capability'];
    if (capability !== undefined && (typeof capability !== 'string' || !/^[a-z][a-z0-9-]*$/.test(capability))) problem(['capability'], '"capability" is the name of the capability that fills the kind');
    const dependsOn = decl['depends-on'];
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.some((entry) => typeof entry !== 'string' || entry.trim() === ''))) problem(['depends-on'], '"depends-on" is a list of the kinds whose discovery must finish first');
    const labels: Record<string, KindLabel> = {};
    const rawLabels = decl['labels'];
    if (rawLabels !== undefined) {
      if (rawLabels === null || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) problem(['labels'], `"labels" maps a language (${LABEL_LANGUAGES.join(', ')}) to { one, many }`);
      else {
        for (const [language, entry] of Object.entries(rawLabels as Record<string, unknown>)) {
          const body = entry as Record<string, unknown> | null;
          if (!LABEL_LANGUAGES.includes(language)) problem(['labels', language], `"${language}" is not a language of the wiki: the languages are ${LABEL_LANGUAGES.join(', ')}`);
          else if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['one'] !== 'string' || typeof body['many'] !== 'string' || body['one'].trim() === '' || body['many'].trim() === '' || Object.keys(body).some((key) => key !== 'one' && key !== 'many')) {
            problem(['labels', language], 'a label is { one: <the name of one>, many: <the name of several> }');
          } else labels[language] = { one: body['one'], many: body['many'] };
        }
      }
    }
    // The template policy says what the kind shows: a page of its own, a member's row, or nothing yet. A policy that
    // says one thing and a declaration that says another is a finding (a catalogue-only kind was let go above).
    if (catalogDeclared) {
      if (policy === 'page' && decl['member'] !== undefined) catalogProblem(['member'], '\'template-policy\' is "page", and the kind declares "member": a member\'s row is the policy "member"');
      if (policy === 'member' && decl['member'] === undefined) catalogProblem(['template-policy'], '"template-policy" is "member", and the kind declares no "member": a member\'s row names the relation to the parent whose page it stands on');
    }
    if (findings.length > before) continue;
    kinds.set(name, {
      name,
      template: template as string,
      source: source as 'graph' | 'markdown' | 'document',
      ...(typeof group === 'string' ? { group } : {}),
      ...(typeof origin === 'string' ? { origin: origin as Origin } : {}),
      ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
      ...(identifiers !== undefined && names(identifiers) ? { identifier: identifiers } : {}),
      ...(Array.isArray(terms) ? { terms: terms as string[] } : {}),
      ...(names2(headings) ? { headings: headings as string[] } : {}),
      ...(typeof semantics === 'string' && isSemanticKind(semantics) ? { semantics } : {}),
      ...(names2(structure) ? { structure: structure as string[] } : {}),
      ...(typeof folder === 'string' ? { folder } : {}),
      ...(typeof importFolder === 'string' ? { importFolder } : {}),
      ...(typeof importFile === 'string' ? { importFile } : {}),
      ...(typeof single === 'string' ? { file: single } : {}),
      title: typeof title === 'string' ? title : 'label',
      ...(Array.isArray(attributes) ? { attributes: attributes as string[] } : {}),
      ...(details.length > 0 ? { details } : {}),
      ...(card === true ? { card: true as const } : {}),
      ...(isHistoryShape(history) ? { history } : {}),
      ...(findingsKind === true ? { findings: true } : {}),
      ...(declaredViews.length === 0 ? {} : { views: declaredViews }),
      ...(er === undefined ? {} : { er }),
      ...(sequence === undefined ? {} : { sequence }),
      ...(system === undefined ? {} : { system }),
      ...(definition === undefined ? {} : { definitionBlock: definition }),
      ...(listing === undefined ? {} : { listing }),
      ...(nav === undefined ? {} : { nav }),
      ...(member === undefined ? {} : { member }),
      ...(fields.length === 0 ? {} : { fields }),
      ...(typeof purpose === 'string' ? { purpose } : {}),
      ...(audience === undefined ? {} : { audience }),
      ...(facts.length === 0 ? {} : { facts }),
      ...(Array.isArray(key) && key.every((entry) => typeof entry === 'string') ? { key: key as string[] } : {}),
      ...(typeof capability === 'string' ? { capability } : {}),
      ...(Array.isArray(dependsOn) ? { dependsOn: dependsOn as string[] } : {}),
      relations,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      line,
    });
  }
  // The catalog as a whole: a subgroup above its bound or with no kind, an area with no subgroup, two kinds of one
  // concept id, and a value the catalog marks as an attribute declared as a kind.
  if (catalogSchema !== undefined) {
    const shape = catalogFindings(catalogSchema, groups, catalogEntries, file);
    findings.push(...shape);
    catalogFound.push(...shape);
  }
  // The translation findings stand beside the catalog's own, after every kind has been read: they name a kind that is
  // still shown, so they must not be read as the defect that leaves a page out.
  findings.push(...wordsFound);
  catalogFound.push(...wordsFound);
  // A kind named in "expect" that the manifest does not declare is a finding at its own line.
  const wanted = expected.filter((entry) => {
    const kind = kinds.get(entry.kind);
    if (kind === undefined) {
      findings.push({ file, line: entry.line, message: `"documents.expect" names the kind ${JSON.stringify(entry.kind)}, and the manifest declares no such kind: the kinds are ${[...kinds.keys()].join(', ') || 'none'}` });
      return false;
    }
    if (kind.source !== 'document') {
      findings.push({ file, line: entry.line, message: `"documents.expect" names the kind ${JSON.stringify(entry.kind)}, which is a ${kind.source} kind: it names the kinds a document section is read as` });
      return false;
    }
    return true;
  });
  // The edge kinds the product declares: their ends, repeat rule and typed attributes. A name is a kind's name, so
  // a vertex and an edge share no name; a field's name is a lower-case identifier.
  const edges = new Map<string, EdgeDecl>();
  const rawEdges = top['edges'];
  if (rawEdges !== undefined) {
    if (!Array.isArray(rawEdges)) findings.push({ file, line: at(['edges']), message: '"edges" is a list of { name, from, to, repeats, discriminator, fields, capability }' });
    else rawEdges.forEach((entry: unknown, index) => {
      const body = entry as Record<string, unknown> | null;
      const line = at(['edges', index]);
      const names = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((one) => typeof one === 'string' && one.trim() !== '');
      if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['name'] !== 'string' || body['name'].trim() === '' || !names(body['from']) || !names(body['to'])) {
        findings.push({ file, line, message: 'an edge is { name: <name>, from: [<kind>, ...], to: [<kind>, ...], repeats?: true, discriminator?: <field>, fields?: [...], capability?: <name> }' });
        return;
      }
      const extra = Object.keys(body).filter((key) => !['name', 'from', 'to', 'repeats', 'discriminator', 'fields', 'capability'].includes(key));
      if (extra.length > 0) { findings.push({ file, line: at(['edges', index, extra[0]!]), message: `"${extra[0]}" is not a field of an edge: the fields are name, from, to, repeats, discriminator, fields and capability` }); return; }
      const fieldTypes = new Set(['text', 'integer', 'bigint', 'boolean', 'timestamp', 'json']);
      const fields: FieldDecl[] = [];
      const rawFields = body['fields'];
      if (rawFields !== undefined) {
        if (!Array.isArray(rawFields)) { findings.push({ file, line: at(['edges', index, 'fields']), message: '"fields" is a list of { name, type, nullable }' }); return; }
        for (const [fieldAt, raw] of rawFields.entries()) {
          const field = raw as Record<string, unknown> | null;
          if (field === null || typeof field !== 'object' || Array.isArray(field) || typeof field['name'] !== 'string' || !/^[a-z][a-z0-9_]*$/.test(field['name']) || typeof field['type'] !== 'string' || !fieldTypes.has(field['type'])) {
            findings.push({ file, line: at(['edges', index, 'fields', fieldAt]), message: 'a field is { name: <lower-case identifier>, type: text|integer|bigint|boolean|timestamp|json, nullable?: true }' });
            return;
          }
          if (field['role'] !== undefined) { findings.push({ file, line: at(['edges', index, 'fields', fieldAt, 'role']), message: '"role" is gone: no field is authoritative and none is claimed — every value a producer states is an opinion' }); return; }
          const fieldExtra = Object.keys(field).filter((key) => !['name', 'type', 'nullable', 'producers', 'reference'].includes(key));
          if (fieldExtra.length > 0) { findings.push({ file, line: at(['edges', index, 'fields', fieldAt, fieldExtra[0]!]), message: `"${fieldExtra[0]}" is not a field of a field: the fields are name, type, nullable, producers and reference` }); return; }
          const fieldProducers = field['producers'];
          if (fieldProducers !== undefined && (!Array.isArray(fieldProducers) || fieldProducers.length === 0 || fieldProducers.some((one) => typeof one !== 'string' || !/^[a-z][a-z0-9-]*$/.test(one)))) { findings.push({ file, line: at(['edges', index, 'fields', fieldAt, 'producers']), message: '"producers" is a list of producer names, each a lower-case identifier' }); return; }
          const fieldReference = field['reference'];
          if (fieldReference !== undefined && (typeof fieldReference !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(fieldReference))) { findings.push({ file, line: at(['edges', index, 'fields', fieldAt, 'reference']), message: '"reference" names a kind of the manifest' }); return; }
          fields.push({ name: field['name'], type: field['type'] as FieldDecl['type'], ...(field['nullable'] === true ? { nullable: true } : {}), ...(fieldProducers === undefined ? {} : { producers: fieldProducers as string[] }), ...(fieldReference === undefined ? {} : { reference: fieldReference }), line: at(['edges', index, 'fields', fieldAt]) });
        }
      }
      const repeats = body['repeats'] === true;
      const discriminator = typeof body['discriminator'] === 'string' ? body['discriminator'] : undefined;
      if (repeats && discriminator === undefined) { findings.push({ file, line: at(['edges', index]), message: 'an edge kind that repeats names the field that tells its repeats apart (discriminator)' }); return; }
      if (!repeats && discriminator !== undefined) { findings.push({ file, line: at(['edges', index, 'discriminator']), message: 'an edge kind that does not repeat has no discriminator' }); return; }
      const capability = typeof body['capability'] === 'string' ? body['capability'] : undefined;
      edges.set(body['name'], { name: body['name'], from: body['from'] as string[], to: body['to'] as string[], repeats, ...(discriminator === undefined ? {} : { discriminator }), fields, ...(capability === undefined ? {} : { capability }), line });
    });
  }
  // The plugins the product holds (decision 0035, items 3, 11 and 20): the manifest binds a major version and names
  // the plugin's folder; the folder's own contract states the fields, and the lock names the exact version and closure.
  const plugins = new Map<string, PluginDecl>();
  const rawPlugins = top['plugins'];
  if (rawPlugins !== undefined) {
    if (!Array.isArray(rawPlugins)) findings.push({ file, line: at(['plugins']), message: '"plugins" is a list of { id, version, path, inputs, outputs, closure }' });
    else rawPlugins.forEach((entry: unknown, index) => {
      const body = entry as Record<string, unknown> | null;
      const line = at(['plugins', index]);
      const names = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === 'string' && one.trim() !== '');
      const declaredVersion = body === null || typeof body !== 'object' || Array.isArray(body) ? undefined : typeof body['version'] === 'number' ? String(body['version']) : body['version'];
      if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['id'] !== 'string' || !/^[a-z][a-z0-9-]*$/.test(body['id']) || typeof declaredVersion !== 'string' || !/^\d+$/.test(declaredVersion) || !names(body['inputs']) || !names(body['outputs']) || (!names(body['closure']) || body['closure'].length === 0)) {
        findings.push({ file, line, message: 'a plugin is { id: <lower-case name>, version: <the major version the manifest binds>, path: <its folder>, inputs: [<kind>, ...], outputs: [<kind>, ...], closure: [<path>, ...] }' });
        return;
      }
      const extra = Object.keys(body).filter((key) => !['id', 'version', 'path', 'inputs', 'outputs', 'closure', 'bounds'].includes(key));
      if (extra.length > 0) { findings.push({ file, line: at(['plugins', index, extra[0]!]), message: `"${extra[0]}" is not a field of a plugin: the fields are id, version, path, inputs, outputs, closure and bounds` }); return; }
      const id = body['id'] as string;
      if (plugins.has(id)) { findings.push({ file, line: at(['plugins', index, 'id']), message: `plugin "${id}": a plugin id stands once` }); return; }
      const path = body['path'];
      if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.split('/').some((leg) => leg === '' || leg === '.' || leg === '..')) { findings.push({ file, line: at(['plugins', index, 'path']), message: `plugin "${id}": "path" is the plugin's folder in the product repository, relative and with no ".."` }); return; }
      const contract = readPluginContract(files, id, path, file, at(['plugins', index, 'path']), findings);
      const bounds = readPluginBounds(body['bounds'], id, file, at(['plugins', index, 'bounds']), findings);
      plugins.set(id, { id, version: declaredVersion, path, inputs: body['inputs'] as string[], outputs: body['outputs'] as string[], closure: body['closure'] as string[], ...(contract === undefined ? {} : { contract }), ...(bounds === undefined ? {} : { bounds }), line });
    });
  }
  // Declaration producers own their schema before any content-producing plugin derives its outputs.
  for (const declaration of TEMPLATE_CONTRACT.vertex) {
    const kind = kinds.get(declaration.name);
    if (kind === undefined) continue;
    kinds.set(kind.name, { ...kind, key: [...declaration.key], fields: declaration.fields.map((field) => ({
      ...field, producers: [declaration.capability], line: kind.line,
    })) });
  }
  // A catalogue agent declares the algorithm, not product kinds. Its effective outputs come only from this manifest.
  const catalogueAgents = [...plugins.values()].filter((plugin) => plugin.contract?.agent?.catalogue === true);
  if (catalogueAgents.length > 1) findings.push({ file, line: catalogueAgents[1]!.line, message: 'only one catalogue agent plugin may fill kinds without another producer' });
  const catalogueAgent = catalogueAgents[0];
  if (catalogueAgent?.contract !== undefined) {
    const candidates = [...kinds.values()].filter((kind) => kind.fields !== undefined && kind.fields.length > 0
      && !(kind.fields ?? []).some((field) => field.binding?.kind === 'plugin')
      && ![...plugins.values()].some((plugin) => plugin !== catalogueAgent && (plugin.outputs.includes(kind.name) || plugin.contract?.vertices.some((vertex) => vertex.kind === kind.name)))
      && (kind.capability === undefined || kind.capability === catalogueAgent.id)
      && !(kind.fields ?? []).some((field) => field.producers?.some((producer) => producer !== catalogueAgent.id))).sort((left, right) => byCodePoint(left.name, right.name));
    for (const kind of candidates) if (kind.key === undefined || kind.key.length === 0) findings.push({ file, line: kind.line, source: isAbsolute(file) ? file : resolve(productFolder, file), message: `kind "${kind.name}": the catalogue agent "${catalogueAgent.id}" fills it, and the manifest declares no "key": a table is unique by its kind's natural key` });
    const keyed = candidates.filter((kind) => kind.key !== undefined && kind.key.length > 0);
    const vertices: PluginOutputKind[] = keyed.map((kind) => ({ kind: kind.name, key: kind.key!, fields: (kind.fields ?? []).map((field) => ({
      name: field.name, type: field.type, meaning: field.binding?.kind === 'agent' ? field.binding.description : field.name,
      example: null, required: (kind.key ?? []).includes(field.name) || field.nullable !== true, evidence: field.evidence ?? true, ...(field.reference === undefined ? {} : { reference: field.reference }),
    })) }));
    for (const kind of keyed) kinds.set(kind.name, { ...kind, fields: kind.fields!.map((field) => field.binding !== undefined ? field : { ...field, binding: { kind: 'agent', description: Object.values(kind.descriptions ?? {}).join(' ') || field.name } }) });
    const names = new Set(keyed.map((kind) => kind.name));
    for (const edge of edges.values()) if (edge.capability === catalogueAgent.id && (edge.from.length !== 1 || edge.to.length !== 1)) findings.push({ file, line: edge.line, message: `edge "${edge.name}": a catalogue agent edge must name one from kind and one to kind; union ends cannot be silently dropped` });
    const agentEdges: PluginOutputEdge[] = [...edges.values()].filter((edge) => edge.capability === catalogueAgent.id && edge.from.length === 1 && edge.to.length === 1 && (names.has(edge.from[0]!) || names.has(edge.to[0]!))).map((edge) => ({ kind: edge.name, from: edge.from[0]!, to: edge.to[0]!, fields: edge.fields.map((field) => ({ name: field.name, type: field.type, meaning: field.name, example: null, required: field.nullable !== true, evidence: field.evidence ?? true })) }));
    plugins.set(catalogueAgent.id, { ...catalogueAgent, outputs: keyed.map((kind) => kind.name), contract: { ...catalogueAgent.contract, vertices, edges: agentEdges } });
  }
  // The plugin lock and the field bindings (decision 0035, items 17, 18, 19 and 20): the lock names each plugin's exact
  // version and closure, a field binds to a field its plugin declares, the type is the plugin's, and a required field
  // the manifest leaves out is the manifest's error. Every problem names the manifest or the contract and its line.
  const lockRead = parsePluginLock(files.has(PLUGINS_LOCK_FILE) ? files.text(PLUGINS_LOCK_FILE) : undefined);
  if (!lockRead.ok) findings.push({ file: lockRead.file, line: lockRead.line, message: lockRead.message });
  const locked = new Map((lockRead.ok ? lockRead.entries : []).map((entry) => [entry.id, entry] as const));
  for (const plugin of plugins.values()) {
    const held = locked.get(plugin.id);
    if (held === undefined) findings.push({ file, line: plugin.line, message: `plugin "${plugin.id}": ${PLUGINS_LOCK_FILE} locks no such plugin: the lock records each plugin's exact version and closure` });
    else {
      if (held.path !== plugin.path) findings.push({ file, line: plugin.line, message: `plugin "${plugin.id}": the manifest names its folder ${JSON.stringify(plugin.path)}, and ${PLUGINS_LOCK_FILE}:${String(held.line)} locks it at ${JSON.stringify(held.path)}` });
      if (majorOf(held.version) !== plugin.version) findings.push({ file, line: plugin.line, message: `plugin "${plugin.id}": the manifest binds major version ${plugin.version}, and ${PLUGINS_LOCK_FILE}:${String(held.line)} locks ${held.version}: a major version the manifest does not bind is not run` });
      if (plugin.contract !== undefined && plugin.contract.version !== held.version) findings.push({ file: join(plugin.path!, 'contract.json'), line: 1, message: `the plugin "${plugin.id}" declares its version ${plugin.contract.version}, and ${PLUGINS_LOCK_FILE}:${String(held.line)} locks ${held.version}` });
    }
  }
  for (const [name, kind] of kinds) {
    /** The fields of this kind whose producer is a plugin, gathered by the plugin and its output kind. */
    const byPlugin = new Map<string, { plugin: PluginDecl; output: PluginOutputKind; fields: FieldDecl[] }>();
    for (const field of kind.fields ?? []) {
      if (field.binding?.kind !== 'plugin') continue;
      const binding = field.binding;
      const line = field.line ?? kind.line;
      const plugin = plugins.get(binding.plugin);
      if (plugin === undefined) {
        findings.push({ file, line, message: `kind "${name}": field "${field.name}" binds to ${binding.plugin}@${binding.major}.${binding.field}, and the manifest declares no plugin "${binding.plugin}"` });
        continue;
      }
      if (plugin.version !== binding.major) {
        findings.push({ file, line, message: `kind "${name}": field "${field.name}" binds to major version ${binding.major} of the plugin "${binding.plugin}", and the manifest binds version ${plugin.version}` });
        continue;
      }
      const output = plugin.contract?.vertices.find((vertex) => vertex.kind === name);
      if (output === undefined) {
        if (plugin.contract !== undefined) findings.push({ file, line, message: `kind "${name}": field "${field.name}" binds to ${binding.plugin}@${binding.major}.${binding.field}, and the plugin's contract ${join(plugin.path!, 'contract.json')}:1 declares no kind "${name}"` });
        continue;
      }
      const declared = output.fields.find((one) => one.name === binding.field);
      if (declared === undefined) {
        const known = output.fields.map((one) => one.name);
        findings.push({ file, line, message: `kind "${name}": field "${field.name}" binds to ${binding.plugin}@${binding.major}.${binding.field}, and the plugin's contract declares no field "${binding.field}" of the kind "${name}": it declares ${known.length === 0 ? 'none' : known.join(', ')}` });
        continue;
      }
      if (declared.type !== field.type) findings.push({ file, line, message: `kind "${name}": field "${field.name}" is ${field.type}, and the plugin's field ${binding.plugin}@${binding.major}.${binding.field} is ${declared.type}: a manifest field takes the type its plugin declares` });
      const held = byPlugin.get(binding.plugin);
      if (held === undefined) byPlugin.set(binding.plugin, { plugin, output, fields: [field] });
      else held.fields.push(field);
    }
    if (byPlugin.size === 0) continue;
    // A kind a plugin fills has a key: the unique index of its table is built from the key's columns.
    for (const [id, entry] of byPlugin) {
      if (kind.key === undefined || kind.key.length === 0) {
        findings.push({ file, line: kind.line, message: `kind "${name}": the plugin "${id}" fills it, and the manifest declares no "key": a table is unique by its kind's natural key` });
        continue;
      }
      // Every required field the plugin declares is bound: a required field left out is the manifest's error (item 18).
      for (const required of entry.output.fields.filter((one) => one.required)) {
        if (!entry.fields.some((field) => field.binding?.kind === 'plugin' && field.binding.field === required.name)) {
          findings.push({ file, line: kind.line, message: `kind "${name}": the plugin "${id}" requires the field "${required.name}" (${required.meaning}), and the manifest binds none: add { name: ${required.name}, type: ${required.type}, binding: "${id}@${entry.plugin.version}.${required.name}" }` });
        }
      }
      // A key field is the vertex's, so the manifest must name a producer for it.
      for (const keyField of kind.key) {
        const bound = entry.fields.find((field) => field.name === keyField);
        const declared = entry.output.fields.find((one) => one.name === keyField);
        if (bound === undefined || declared === undefined) {
          findings.push({ file, line: kind.line, message: `kind "${name}": key field "${keyField}" must be a field the plugin "${id}" writes, and ${bound === undefined ? 'the manifest binds it to no plugin field' : 'the plugin declares no such field'}` });
        }
      }
    }
  }
  // The contract's preflight (decision 0035, items 2 and 11): every field has a producer, no field states a role (none is
  // authoritative), the dependency graph is acyclic and declared, and a plugin reads only what the
  // closure of its earliest output kind holds. No fill starts while any finding stands.
  const dependencies = new Map<string, readonly string[]>();
  for (const [name, kind] of kinds) dependencies.set(name, kind.dependsOn ?? []);
  for (const [name, deps] of dependencies) {
    const kind = kinds.get(name)!;
    for (const dependency of deps) {
      if (!kinds.has(dependency)) findings.push({ file, line: kind.line, message: `kind "${name}": "depends-on" names the kind ${JSON.stringify(dependency)}, and the manifest declares no such kind` });
    }
  }
  const cycle = findDependencyCycle(dependencies);
  if (cycle !== undefined) {
    const first = cycle[0]!;
    findings.push({ file, line: kinds.get(first)?.line ?? at(['kinds', first]), message: `kind "${first}": the dependency cycle ${cycle.join(' -> ')} is refused: the kinds' declared dependencies must form no cycle` });
  }
  const order = cycle === undefined ? dependencyOrder(dependencies) : undefined;
  const orderIndex = new Map((order ?? []).map((name, index) => [name, index] as const));
  const closureOf = (kind: string): Set<string> => {
    const held = new Set<string>([kind]);
    const walk = (name: string): void => { for (const dependency of dependencies.get(name) ?? []) if (!held.has(dependency)) { held.add(dependency); walk(dependency); } };
    walk(kind);
    return held;
  };
  const checkField = (owner: string, field: FieldDecl, ownerLine: number, edge: boolean): void => {
    const line = field.line ?? ownerLine;
    const what = edge ? 'edge kind' : 'kind';
    const producers = field.producers ?? [];
    // A field with a binding names its producer there, and the plugin's own declaration states its type.
    if (field.binding === undefined) {
      if (producers.length === 0) findings.push({ file, line, message: `${what} "${owner}": field "${field.name}" names no producer` });
    } else if (producers.length > 0) {
      findings.push({ file, line, message: `${what} "${owner}": field "${field.name}" names its producer twice, as a binding and as producers: a field names one` });
    }
    if (field.reference !== undefined && !kinds.has(field.reference)) findings.push({ file, line, message: `${what} "${owner}": field "${field.name}" references the kind ${JSON.stringify(field.reference)}, and the manifest declares no such kind` });
  };
  for (const [name, kind] of kinds) {
    const seen = new Set<string>();
    for (const field of kind.fields ?? []) {
      if (seen.has(field.name)) findings.push({ file, line: field.line ?? kind.line, message: `kind "${name}": field "${field.name}" stands once` });
      seen.add(field.name);
      checkField(name, field, kind.line, false);
    }
  }
  for (const [name, edge] of edges) for (const field of edge.fields) checkField(name, field, edge.line, true);
  for (const plugin of plugins.values()) {
    for (const output of plugin.outputs) if (!kinds.has(output)) findings.push({ file, line: plugin.line, message: `plugin "${plugin.id}": output ${JSON.stringify(output)} is not a kind the manifest declares` });
    for (const input of plugin.inputs) if (!kinds.has(input)) findings.push({ file, line: plugin.line, message: `plugin "${plugin.id}": input ${JSON.stringify(input)} is not a kind the manifest declares` });
    if (orderIndex.size === 0) continue;
    const declaredOutputs = plugin.outputs.filter((output) => orderIndex.has(output));
    if (declaredOutputs.length === 0) continue;
    // A plugin that reads the whole graph asks for no particular kind as its input: the graph is its input, and the
    // declared list names what a person should see it read, not a dependency closure (madarch-stm0.7.1, piece 3).
    if (plugin.contract?.reads === 'whole-graph') continue;
    const earliest = declaredOutputs.reduce((first, next) => (orderIndex.get(next)! < orderIndex.get(first)! ? next : first));
    const closure = closureOf(earliest);
    for (const input of plugin.inputs) if (!closure.has(input)) findings.push({ file, line: plugin.line, message: `plugin "${plugin.id}": input ${JSON.stringify(input)} is outside the dependency closure of its earliest output kind ${JSON.stringify(earliest)}` });
  }
  // `journal: { debug: true }` keeps every request a plugin makes, its reads included, in the journal; off by default,
  // and a plugin never logs itself.
  let journal: { debug: boolean } | undefined;
  const rawJournal = top['journal'];
  if (rawJournal !== undefined) {
    if (rawJournal === null || typeof rawJournal !== 'object' || Array.isArray(rawJournal)) {
      findings.push({ file, line: at(['journal']), message: '"journal" is { debug: true|false }: whether the journal keeps every request a plugin makes, its reads included' });
    } else {
      for (const key of Object.keys(rawJournal)) if (key !== 'debug') findings.push({ file, line: at(['journal', key]), message: `"journal" holds only "debug", and "${key}" is not one` });
      const debug = (rawJournal as Record<string, unknown>)['debug'];
      if (debug !== undefined && typeof debug !== 'boolean') findings.push({ file, line: at(['journal', 'debug']), message: '"journal" "debug" is true or false' });
      if (debug === true) journal = { debug: true };
    }
  }
  return { file, roles, ...(rawPurposes === undefined ? {} : { purposes }), properties, kinds, ...(edges.size === 0 ? {} : { edges }), ...(plugins.size === 0 ? {} : { plugins }), declaredTemplates: [...new Set(declaredTemplates)], groups, excludeDocuments, ignoreBlocks: ignoredBlocks, expect: wanted, ...(problems === undefined ? {} : { problems }), ...(catalogSchema === undefined ? {} : { catalog: { schema: catalogSchema, kinds: catalogEntries, findings: catalogFound } }), findings, ...(language === undefined ? {} : { language }), ...(diagram === undefined ? {} : { diagram }), ...(journal === undefined ? {} : { journal }) };
}

/**
 * Writes `language:` into the manifest of a product, keeping the rest of the file (comments included) as it is.
 * Answers a sentence naming the file when it cannot; nothing when it is done.
 */
export function setKindsLanguage(productFolder: string, language: string): string | undefined {
  const file = join(productFolder, KINDS_FILE);
  if (!LABEL_LANGUAGES.includes(language)) return `${file}: "${language}" is not a language of the wiki; the languages are ${LABEL_LANGUAGES.join(', ')}`;
  try {
    // A manifest that is a link out of the product is somebody else's file: it is not rewritten.
    if (lstatSync(file).isSymbolicLink()) {
      const real = realpathSync(file);
      const root = realpathSync(productFolder);
      if (!real.startsWith(`${root}/`) && !real.startsWith(`${root}\\`)) return `${file}: the manifest is a link to ${real}, outside the product ${productFolder}, so the language is not written into it`;
    }
    const document = parseDocument(readFileSync(file, 'utf8'));
    if (document.errors.length > 0) return `${file}: the manifest cannot be read, so the language is not written into it: ${document.errors[0]!.message.split('\n')[0]}`;
    document.set('language', language);
    writeFileSync(file, document.toString(), 'utf8');
    return undefined;
  } catch (error) {
    return `${file}: the language could not be written: ${(error as Error).message}`;
  }
}

/** The first single-file Markdown kind is home; graph-backed products use the declared `product` kind. */
export function homeKind(manifest: KindsManifest): KindDecl | undefined {
  for (const decl of manifest.kinds.values()) if (decl.source === 'markdown' && decl.file !== undefined) return decl;
  const product = manifest.kinds.get('product');
  return product?.source === 'graph' ? product : undefined;
}

/** A path pattern as a regular expression: `*` stays within a folder, `**` crosses folders, `?` is one character. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]!;
    if (char === '*') {
      if (pattern[at + 1] === '*') {
        at += 1;
        if (pattern[at + 1] === '/') { at += 1; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Whether a document path (`/`-separated) matches one of the patterns. */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}


/**
 * The kinds in the order their declared dependencies give (decision 0035, item 11): a kind after the kinds it depends on.
 * The manifest's check refuses a cycle before a fill starts, so the order stands whenever a fill reads it.
 */
export function kindsInDependencyOrder(manifest: KindsManifest): string[] {
  const dependencies = new Map<string, readonly string[]>([...manifest.kinds].map(([name, kind]) => [name, kind.dependsOn ?? []]));
  return dependencyOrder(dependencies);
}

/** The first dependency cycle among the kinds, as the names in its order, or undefined when the graph is acyclic. */
function findDependencyCycle(dependencies: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const walk = (name: string): string[] | undefined => {
    const seen = state.get(name);
    if (seen === 'done') return undefined;
    if (seen === 'visiting') return [...stack.slice(stack.indexOf(name)), name];
    state.set(name, 'visiting');
    stack.push(name);
    for (const dependency of dependencies.get(name) ?? []) {
      const found = walk(dependency);
      if (found !== undefined) return found;
    }
    stack.pop();
    state.set(name, 'done');
    return undefined;
  };
  for (const name of dependencies.keys()) {
    const found = walk(name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The kinds in dependency order: every kind after the kinds it depends on. Only called for an acyclic graph. */
function dependencyOrder(dependencies: ReadonlyMap<string, readonly string[]>): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const walk = (name: string): void => {
    if (done.has(name)) return;
    done.add(name);
    for (const dependency of dependencies.get(name) ?? []) walk(dependency);
    order.push(name);
  };
  for (const name of dependencies.keys()) walk(name);
  return order;
}

import { Type, type Static } from 'typebox';

/**
 * The TypeBox schemas of the product repository's kinds registry and stage
 * list (decision 0021, outcome 1 of the standalone charter). The published
 * JSON schema is generated from this source with `bun run schemas`
 * (scripts/generate-schemas.ts) and its freshness is checked by
 * test/schemas.test.ts, the way the model schemas are.
 */

/**
 * The words a registry's fields give the reader: an id (`^[A-Za-z]
 * [A-Za-z0-9_-]*$`, shared with the model schema's id pattern so the two
 * never drift) and a name, which may carry spaces ("product requirement").
 */
const ID_PATTERN_SOURCE = '^[A-Za-z][A-Za-z0-9_-]*$';
const NAME_PATTERN_SOURCE = '^[A-Za-z][A-Za-z0-9 _-]*$';
const RegistryId = Type.String({ pattern: ID_PATTERN_SOURCE });
const RegistryName = Type.String({ pattern: NAME_PATTERN_SOURCE, minLength: 1 });

/** One link field a kind's documents may carry, as a kind declares it. */
export const KindLinkEntry = Type.Object(
  {
    /** The form field's name the documents of the kind write the link under, like `Serves`. */
    field: Type.String({ minLength: 1, description: 'The field name as the document\'s form writes it, like Grew from, Serves.' }),
    /** The kinds the field's link may name, by the kinds' own names in this registry. */
    targets: Type.Array(RegistryName, { minItems: 1, description: 'The kinds this link may go to, each a kind of the registry.' }),
    /** The label the linked page shows its backlinks under; left out, the wiki words the backlink generically. */
    backlink: Type.Optional(RegistryName),
    /** Whether the field names one document or many: `many` is the shape a left-out cardinality reads as. */
    cardinality: Type.Optional(Type.Union([Type.Literal('one'), Type.Literal('many')])),
    /** Whether a document of the kind must carry the link at all. */
    required: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type KindLinkEntry = Static<typeof KindLinkEntry>;

/**
 * The storage forms a kind may declare (the 0021 amendment as the owner
 * refined it, 2026-10-12 ~22:15 MSK): how the kind's records are stored
 * inside the product. `document` is the only form this engine version
 * implements; the other four are reserved — the tracker's tasks, the
 * model's elements, the UI kit's components, and imported facts with their
 * evidence. The engine keeps a form it does not implement and names it as
 * an honest "not supported by this engine version" finding, never dropping
 * it.
 */
export const StorageForm = Type.Union(
  [
    Type.Literal('document'),
    Type.Literal('task'),
    Type.Literal('model-element'),
    Type.Literal('component'),
    Type.Literal('fact'),
  ],
  { description: 'How the kind is stored inside the product. document is what this engine version implements; the other forms are reserved and kept as data, named by an honest finding, never dropped.' },
);
export type StorageForm = Static<typeof StorageForm>;

/**
 * The evidence shape a `fact` kind carries, reserved: the field names the
 * fact's document carries its provenance in — the source system, the ref
 * or commit it was read at, and the record id the source holds. The shape
 * is data the engine keeps; the fact's truth stays with the system it came
 * from, read-only in the wiki.
 */
export const EvidenceFields = Type.Object(
  {
    /** The document's field naming the source system, like `Source`. */
    source: RegistryName,
    /** The document's field naming the ref or commit, like `Ref`. */
    ref: Type.Optional(RegistryName),
    /** The document's field naming the record id, like `Record`. */
    record: Type.Optional(RegistryName),
  },
  { additionalProperties: false },
);
export type EvidenceFields = Static<typeof EvidenceFields>;

/** One level of the reserved goals section: a named maturity level holding
 * the rules over the graph — counts by type and status, required-link
 * coverage, provenance agreement, approvals by role — seen from one
 * perspective when one is named. The shape is reserved: this engine
 * version keeps the section as data and names it as
 * reserved-but-unimplemented when it renders, never silently. */
export const GoalLevel = Type.Object(
  {
    /** The level's name as a reader sees it, like `grounded`. */
    name: RegistryName,
    /** The perspective the level is granted for, like `business`, `security`; absent, the level is granted for every perspective. */
    perspective: Type.Optional(RegistryName),
    /** The rules the level is built from, each as the words the level grants. */
    rules: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'The rules the level holds; a rule names a count, a coverage, a provenance agreement or an approval by role.' }),
  },
  { additionalProperties: false },
);
export type GoalLevel = Static<typeof GoalLevel>;

/** One kind of document the product holds, as the registry names it. */
export const KindEntry = Type.Object(
  {
    /** The kind's name as a reader sees it, like `source`, `product requirement`. */
    name: RegistryName,
    /** The prefix the kind's document ids carry, like `FR` for `FR-001`. */
    prefix: Type.String({ minLength: 1, description: 'Two to four capitals (A-Z), checked when the registry is read.' }),
    /** The place inside the product the kind's documents live in, `docs/…`. */
    folder: Type.String({ minLength: 1, description: 'A place under docs/, like docs/requirements; checked when the registry is read.' }),
    /** The stage the kind belongs to, one of the stage list below. */
    stage: RegistryId,
    /** The next-step hint the wiki shows where the stage holds nothing of the kind. */
    hint: Type.String({ minLength: 1 }),
    /** The statuses a document of the kind may carry in its `Status` field; a written status outside the list is the wiki's finding. */
    statuses: Type.Optional(Type.Array(RegistryName, { description: 'The allowed statuses of the kind, as the documents write them.' })),
    /** The link fields the kind's documents may carry, each naming its target kinds. */
    links: Type.Optional(Type.Array(KindLinkEntry, { description: 'The links the kind declares: field name, allowed target kinds, the backlink\'s label, the cardinality and whether the link is required.' })),
    /** The storage form the kind is kept in (the 0021 amendment); `document` stands where it is left out. */
    storage: Type.Optional(StorageForm),
    /**
     * The field names the kind's fact carries its evidence in, reserved for
     * the `fact` storage form: source system, ref or commit, record id. The
     * engine keeps the shape as data and shows an honest "not supported by
     * this engine version" finding at the reserved form, never a refusal
     * and never a drop.
     */
    evidence: Type.Optional(EvidenceFields),
  },
  { additionalProperties: false },
);
export type KindEntry = Static<typeof KindEntry>;

/** One stage of the product's life cycle, in the list's own order. */
export const StageEntry = Type.Object(
  {
    id: RegistryId,
    /** The stage's name as a reader sees it; the id stands in where it is left out. */
    name: Type.Optional(RegistryName),
  },
  { additionalProperties: false },
);
export type StageEntry = Static<typeof StageEntry>;

/**
 * The registry as one file's shape: the stages in the order the reader walks
 * them and the kinds that belong to them. The file carries no fixed kinds —
 * the kinds are the data the product (usually the skill set, at setup)
 * writes; the schema fixes only the mechanism.
 */
/**
 * The contract version the registry schema publishes (the owner's
 * refinement, 2026-10-12): the version stands in the registry file itself
 * (`contract: 1`) and in the published schema's `$id`, so a tool that
 * validates a registry knows both sides' version, and moving either side
 * to a new version is a deliberate change. The file under madarch
 * (`schema/product-registry.schema.json`) stays the one source; a reader
 * of another version (the skill set's copy) targets the version its `$id`
 * names.
 */
const REGISTRY_SCHEMA_ID = 'https://github.com/shady2k/madarch/schema/v1/product-registry.schema.json';


export const KindsRegistry = Type.Object(
  {
    /** The contract version the registry is written against; this schema is version 1. */
    contract: Type.Literal(1, { description: 'The contract version the registry is written against; this schema publishes version 1.' }),
    goals: Type.Optional(Type.Array(GoalLevel, { minItems: 1, description: 'The reserved goals section: maturity levels over the graph, per perspective (the 0021 amendment). This engine version keeps the section and names it as reserved-but-unimplemented when it renders; never a silent unknown section.' })),
    stages: Type.Array(StageEntry, { minItems: 1, description: 'The life cycle in the order the reader walks it; every kind names one of these.' }),
    kinds: Type.Array(KindEntry, { description: 'The kinds the product holds, each naming its stage of the list.' }),
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: REGISTRY_SCHEMA_ID,
    title: 'Madarch product kinds registry',
    description:
      'The shape of one product repository kinds registry file, at contract version 1: the stages as an ordered list with no fixed kinds, and the kinds the product holds, each with its name, id prefix, folder, stage, next-step hint, allowed statuses and declared link types. The mechanism is madarch\'s; the kinds (usually written at setup by the skill set) are the product\'s data.',
    additionalProperties: false,
  },
);
export type KindsRegistry = Static<typeof KindsRegistry>;


/**
 * The generic document fields a document under the layout may carry for
 * madarch to link it and place it (decision 0021). A field this madarch
 * does not know is ignored, so a later version adds beside them.
 */
export const DocumentFields = Type.Object(
  {
    /** The document's id in its kind's own prefix's shape, like `FR-001`. */
    id: Type.Optional(Type.String({ minLength: 1, description: "The document's own id, like FR-001; checked against the registry's prefix of the field kind names." })),
    /** The kind the document carries, one name of the registry. */
    kind: Type.Optional(RegistryName),
    /** The document's written status, as its kind's form says it. */
    status: Type.Optional(Type.String({ minLength: 1 })),
    /** The documents this one links to, by their ids. */
    links: Type.Optional(Type.Array(Type.String(), { description: "The ids this document links to, as its fields' values name them." })),
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/shady2k/madarch/schema/product-document.schema.json',
    title: 'Madarch product document fields',
    description:
      "The generic fields a product's Markdown document may carry for madarch to link it and place it: id, kind, status, links. A field this madarch does not know is ignored. The kinds themselves (and with them the field's meaning of status) are the registry's data.",
    additionalProperties: false,
  },
);
export type DocumentFieldsSchema = Static<typeof DocumentFields>;

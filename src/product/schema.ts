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
export const KindsRegistry = Type.Object(
  {
    stages: Type.Array(StageEntry, { minItems: 1, description: 'The life cycle in the order the reader walks it; every kind names one of these.' }),
    kinds: Type.Array(KindEntry, { description: 'The kinds the product holds, each naming its stage of the list.' }),
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/shady2k/madarch/schema/product-registry.schema.json',
    title: 'Madarch product kinds registry',
    description:
      'The shape of one product repository kinds registry file: the stages as an ordered list with no fixed kinds, and the kinds the product holds, each with its name, id prefix, folder, stage and next-step hint. The mechanism is madarch\'s; the kinds (usually written at setup by the skill set) are the product\'s data.',
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

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

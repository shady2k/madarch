import { Type, type Static } from 'typebox';

/**
 * The TypeBox schemas are the one source for the intended model's types,
 * its runtime validation and its published JSON Schema. Later tasks add
 * more fields and top-level arrays (zones, environments, states) alongside
 * `elements`, `interfaces`, `relations` and `categories`.
 */

/**
 * Letters, digits, dots, dashes and underscores, starting with a letter or
 * digit (intended-model/ids). The one source both `validate.ts`'s id check
 * and the published JSON Schemas' `id` fields use, so the two can never
 * drift apart.
 */
export const ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
export const ID_PATTERN = new RegExp(ID_PATTERN_SOURCE);

const Id = Type.String({ pattern: ID_PATTERN_SOURCE });

export const ElementKind = Type.Union([
  Type.Literal('person'),
  Type.Literal('external'),
  Type.Literal('domain'),
  Type.Literal('system'),
  Type.Literal('service'),
  Type.Literal('module'),
  Type.Literal('store'),
  Type.Literal('broker'),
]);
export type ElementKind = Static<typeof ElementKind>;

export const Evidence = Type.Object(
  {
    file: Type.String(),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    endLine: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: 'The last line of the range the item names; needs `line` and may not come before it (checked when the model is loaded).',
      }),
    ),
    commit: Type.Optional(
      Type.String({
        description:
          'The commit the file was read at: 40 hexadecimal digits, lower case. Given together with `blob` or with neither (checked when the model is loaded).',
      }),
    ),
    blob: Type.Optional(
      Type.String({
        description:
          "The file's git blob id at `commit`: 40 hexadecimal digits, lower case. Given together with `commit` or with neither (checked when the model is loaded).",
      }),
    ),
  },
  { additionalProperties: false },
);
export type Evidence = Static<typeof Evidence>;

export const ZonesChange = Type.Object(
  {
    add: Type.Optional(Type.Array(Type.String())),
    exclude: Type.Optional(Type.Array(Type.String())),
    replace: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type ZonesChange = Static<typeof ZonesChange>;

export const Element = Type.Object(
  {
    id: Id,
    kind: ElementKind,
    name: Type.Optional(Type.String()),
    parent: Type.Optional(Type.String()),
    technology: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(Evidence)),
    zones: Type.Optional(ZonesChange),
    environments: Type.Optional(Type.Array(Type.String())),
    since: Type.Optional(Type.String()),
    until: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Element = Static<typeof Element>;

export const Zone = Type.Object(
  {
    id: Id,
    kind: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Zone = Static<typeof Zone>;

export const Category = Type.Object(
  {
    id: Id,
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Category = Static<typeof Category>;

/**
 * A data entity: one named piece of data that crosses a relation (a
 * session id, a user's name), classified by the model's own data
 * categories — there is no second vocabulary (decision 0016).
 */
export const DataEntity = Type.Object(
  {
    id: Id,
    name: Type.Optional(
      Type.String({ description: 'A readable name of the piece of data ("Session id"), the label a reader sees.' }),
    ),
    description: Type.Optional(
      Type.String({ description: 'What the piece of data is, in prose, when its name does not say it alone.' }),
    ),
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "The classification: ids of the model's data categories. An empty list is an answer (checked, of no category); the field left out entirely is warned about, so a legacy model still loads.",
      }),
    ),
    evidence: Type.Optional(Type.Array(Evidence)),
  },
  { additionalProperties: false },
);
export type DataEntity = Static<typeof DataEntity>;

export const Interface = Type.Object(
  {
    id: Id,
    provider: Type.String(),
    contract: Type.String(),
    evidence: Type.Optional(Type.Array(Evidence)),
  },
  { additionalProperties: false },
);
export type Interface = Static<typeof Interface>;

export const TransferDirection = Type.Union([Type.Literal('forward'), Type.Literal('reverse')]);
export type TransferDirection = Static<typeof TransferDirection>;

/**
 * One data transfer of an interaction. `categories` names data category ids,
 * `entities` data entity ids; a transfer names categories, entities or both —
 * naming neither is refused when the model is loaded (the compiled transfer
 * then carries the union of the categories it names and those of its
 * entities, each once, sorted by code point).
 */
export const Transfer = Type.Object(
  {
    direction: TransferDirection,
    confidentiality: Type.String({ minLength: 1 }),
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description: 'The data categories the transfer carries, by id. An empty list is an answer: nothing categorised crosses.',
      }),
    ),
    entities: Type.Optional(
      Type.Array(Type.String(), {
        description: 'The data entities the transfer carries, by id; their categories join the transfer\'s own in the compiled model.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type Transfer = Static<typeof Transfer>;

export const Binding = Type.Object(
  {
    env: Type.String(),
  },
  { additionalProperties: false },
);
export type Binding = Static<typeof Binding>;

/**
 * One step of a scenario's main flow or of one of its alternatives: the
 * relation it runs over — at any level, a refinement or not, so a scenario
 * written early over coarse relations stays valid when they are refined —
 * and an optional name of what happens ("the order is announced").
 */
export const ScenarioStep = Type.Object(
  {
    id: Id,
    relation: Type.String({ description: 'The relation the step runs over, by id: any relation of the model, coarse or a refinement.' }),
    name: Type.Optional(
      Type.String({ description: 'What happens at this step, in a few words ("the order is announced"); the label a reader sees.' }),
    ),
  },
  { additionalProperties: false },
);
export type ScenarioStep = Static<typeof ScenarioStep>;

/**
 * One alternative flow of a scenario: it replaces the main flow from the
 * step `at` names on. `when` states the condition under which it is taken,
 * in prose; rejoining the main flow is not expressed (the alternative runs
 * to its own last step).
 */
export const ScenarioAlternative = Type.Object(
  {
    id: Id,
    at: Type.String({ description: 'The main-flow step the alternative starts at, by step id.' }),
    when: Type.String({ minLength: 1, description: 'The condition under which the alternative is taken, in prose ("the payment is declined").' }),
    steps: Type.Optional(Type.Array(ScenarioStep, { description: "The alternative's own steps, in order; never empty in a valid model." })),
  },
  { additionalProperties: false },
);
export type ScenarioAlternative = Static<typeof ScenarioAlternative>;

/**
 * A scenario: one use case as an ordered walk over the model's relations
 * (decision 0016). `requirements` names the capability requirements it
 * realises, as ids of the form `capability/requirement` — the loader checks
 * only their form; whether a requirement exists is the model check's
 * question, which reads the repository's capability specs.
 */
export const Scenario = Type.Object(
  {
    id: Id,
    name: Type.Optional(
      Type.String({ description: 'A readable name of the use case ("Place an order"), the label a reader sees.' }),
    ),
    description: Type.Optional(
      Type.String({ description: "The use case's goal and preconditions, in prose." }),
    ),
    actor: Type.Optional(
      Type.String({ description: 'The element that initiates the use case, by id; usually a person or an external system.' }),
    ),
    requirements: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'The capability requirements the scenario realises, as ids of the form `capability/requirement`. The loader checks only their form.',
      }),
    ),
    steps: Type.Optional(
      Type.Array(ScenarioStep, {
        description:
          'The main flow: an ordered list of steps, each over a relation of the model at any level. Optional only so the loader can refuse a scenario with no step naming the scenario; a valid scenario always has at least one.',
      }),
    ),
    alternatives: Type.Optional(
      Type.Array(ScenarioAlternative, {
        description: 'Alternative flows, each replacing the main flow from the step its `at` names on.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type Scenario = Static<typeof Scenario>;

export const RelationAction = Type.Union([Type.Literal('send'), Type.Literal('receive')], {
  description:
    'How the initiator uses the topic or queue the relation goes through: "send" publishes or sends to it, "receive" subscribes to it or receives from it. Only on a relation through an interface of kind topic or queue; the relation still goes from its initiator to what it depends on, usually the broker.',
});
export type RelationAction = Static<typeof RelationAction>;

export const Relation = Type.Object(
  {
    id: Id,
    name: Type.Optional(
      Type.String({
        description:
          'What the relation does, in a few words ("places orders"). Optional, so a model written before names existed still loads, but a relation with no name, or a blank one, is warned about.',
      }),
    ),
    from: Type.String(),
    to: Type.String(),
    refines: Type.Optional(Type.String()),
    interface: Type.Optional(Type.String()),
    action: Type.Optional(RelationAction),
    binding: Type.Optional(Binding),
    transfers: Type.Optional(Type.Array(Transfer)),
    evidence: Type.Optional(Type.Array(Evidence)),
    since: Type.Optional(Type.String()),
    until: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Relation = Static<typeof Relation>;

export const EnvironmentZonesChange = Type.Object(
  {
    add: Type.Optional(Type.Array(Type.String())),
    exclude: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type EnvironmentZonesChange = Static<typeof EnvironmentZonesChange>;

export const Environment = Type.Object(
  {
    id: Id,
    name: Type.Optional(Type.String()),
    bindings: Type.Optional(Type.Record(Type.String(), Type.String())),
    zones: Type.Optional(Type.Record(Type.String(), EnvironmentZonesChange)),
  },
  { additionalProperties: false },
);
export type Environment = Static<typeof Environment>;

export const State = Type.Object(
  {
    id: Id,
    name: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type State = Static<typeof State>;

export const ModelFile = Type.Object(
  {
    version: Type.Literal(1),
    elements: Type.Array(Element),
    interfaces: Type.Optional(Type.Array(Interface)),
    relations: Type.Optional(Type.Array(Relation)),
    categories: Type.Optional(Type.Array(Category)),
    entities: Type.Optional(Type.Array(DataEntity)),
    scenarios: Type.Optional(Type.Array(Scenario)),
    zones: Type.Optional(Type.Array(Zone)),
    environments: Type.Optional(Type.Array(Environment)),
    states: Type.Optional(Type.Array(State)),
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/shady2k/madarch/schema/intended-model.schema.json',
    title: 'Madarch intended model',
    description:
      "The shape of one madarch/*.yaml file: what people and agents declare the architecture to be. A repository's intended model is every such file in its madarch/ folder, read as one.",
    additionalProperties: false,
  },
);
export type ModelFile = Static<typeof ModelFile>;

/** One model, read from every `*.yaml` file of a repository's `madarch/` folder. */
export interface IntendedModel {
  version: 1;
  elements: Element[];
  interfaces: Interface[];
  relations: Relation[];
  categories: Category[];
  entities: DataEntity[];
  scenarios: Scenario[];
  zones: Zone[];
  environments: Environment[];
  states: State[];
}

/** The id of the implicit single state a model with no `states` has. */
export const DEFAULT_STATE_ID = 'as-is';

declare const validatedBrand: unique symbol;

/**
 * An `IntendedModel` that has passed `loadModel`/`parseModel`'s checks:
 * strict YAML, the schema, ids, references, cycles and every other rule in
 * `validate.ts`. Only the loader produces one, so `compileModel` — which
 * assumes a model already free of those problems — cannot be called on
 * anything else without an explicit, visible cast.
 */
export type ValidatedModel = IntendedModel & { readonly [validatedBrand]: true };

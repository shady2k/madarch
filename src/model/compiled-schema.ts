import { Type, type Static } from 'typebox';
import { Binding, ElementKind, Evidence, ID_PATTERN_SOURCE, Transfer } from './schema.js';

/**
 * The TypeBox schemas of the compiled model, `model.json`: the one source
 * for its type, its runtime validation and its published JSON Schema
 * (`schema/compiled-model.schema.json`), the same way `schema.ts` is the
 * source for the intended model's.
 */

/** The one constant for the compiled schema's version. */
export const COMPILED_SCHEMA_VERSION = 1;

const CompiledId = Type.String({ pattern: ID_PATTERN_SOURCE });

export const CompiledZone = Type.Object(
  {
    id: CompiledId,
    kind: Type.String(),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledZone = Static<typeof CompiledZone>;

export const CompiledCategory = Type.Object(
  {
    id: CompiledId,
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledCategory = Static<typeof CompiledCategory>;

export const CompiledEnvironment = Type.Object(
  {
    id: CompiledId,
    name: Type.Optional(Type.String()),
    bindings: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);
export type CompiledEnvironment = Static<typeof CompiledEnvironment>;

export const CompiledState = Type.Object(
  {
    id: CompiledId,
    name: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledState = Static<typeof CompiledState>;

/**
 * The presence description shared by an element's and a relation's
 * `environments` field. With no environments declared in the model at all,
 * every element and relation is trivially unrestricted, and that is written
 * as the single sentinel id `"*"` rather than an empty list, so "every
 * environment" (a model with none declared) can never be confused with "no
 * environment" — which is refused before a model can be compiled at all, so
 * a real, non-sentinel list is never empty either.
 */
const ENVIRONMENTS_DESCRIPTION =
  'The environments it exists in, after inheriting and narrowing presence: the sorted ids of the environments it is in, or the single sentinel id "*" when the model declares no environments at all (in which case everything is trivially unrestricted). Never empty otherwise: a thing that exists in no environment is refused before compilation.';

export const CompiledElement = Type.Object(
  {
    id: CompiledId,
    kind: ElementKind,
    name: Type.Optional(Type.String()),
    parent: Type.Optional(Type.String()),
    technology: Type.Optional(Type.String()),
    ancestors: Type.Array(Type.String(), { description: 'Ancestor ids, ordered from the root down to the immediate parent.' }),
    evidence: Type.Optional(Type.Array(Evidence)),
    zones: Type.Array(Type.String(), { description: "The element's zones, worked out after inheritance, add, exclude and replace." }),
    zonesByEnvironment: Type.Record(Type.String(), Type.Array(Type.String()), {
      description: "The element's zones in each environment it exists in, listing only the environments it exists in, after that environment's own changes.",
    }),
    environments: Type.Array(Type.String(), { description: ENVIRONMENTS_DESCRIPTION }),
    states: Type.Array(Type.String(), { description: 'The states it exists in, first to last in the chain; every state when unrestricted.' }),
  },
  { additionalProperties: false },
);
export type CompiledElement = Static<typeof CompiledElement>;

export const CompiledInterface = Type.Object(
  {
    id: CompiledId,
    provider: Type.String(),
    contract: Type.String(),
    evidence: Type.Optional(Type.Array(Evidence)),
  },
  { additionalProperties: false },
);
export type CompiledInterface = Static<typeof CompiledInterface>;

export const CompiledRelation = Type.Object(
  {
    id: CompiledId,
    from: Type.String(),
    to: Type.String(),
    refines: Type.Optional(Type.String()),
    interface: Type.Optional(Type.String()),
    interaction: Type.Boolean({ description: 'True when the relation carries an interface or transfers: it is an interaction.' }),
    binding: Type.Optional(Binding),
    bindingByEnvironment: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "The binding variable's value in each environment the relation exists in. An environment that does not define the variable has no key here: a binding variable an environment leaves unset is recorded as absent, never as an error.",
      }),
    ),
    transfers: Type.Optional(Type.Array(Transfer)),
    evidence: Type.Optional(Type.Array(Evidence)),
    environments: Type.Array(Type.String(), { description: `${ENVIRONMENTS_DESCRIPTION} A relation exists where both its ends do.` }),
    states: Type.Array(Type.String(), { description: 'The states the relation exists in: its own since/until, intersected with both its ends.' }),
  },
  { additionalProperties: false },
);
export type CompiledRelation = Static<typeof CompiledRelation>;

export const CompiledModel = Type.Object(
  {
    schemaVersion: Type.Literal(COMPILED_SCHEMA_VERSION),
    elements: Type.Array(CompiledElement),
    interfaces: Type.Array(CompiledInterface),
    relations: Type.Array(CompiledRelation),
    categories: Type.Array(CompiledCategory),
    zones: Type.Array(CompiledZone),
    environments: Type.Array(CompiledEnvironment),
    states: Type.Array(CompiledState),
  },
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/shady2k/madarch/schema/compiled-model.schema.json',
    title: 'Madarch compiled model',
    description:
      'model.json: a loaded intended model with its references resolved, its zones and presence worked out per environment and state, and its contract ids normalized — the one shape every frontend and agent reads.',
    additionalProperties: false,
  },
);
export type CompiledModel = Static<typeof CompiledModel>;

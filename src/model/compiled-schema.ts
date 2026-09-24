import { Type, type Static } from 'typebox';
import { Binding, ElementKind, Evidence, Transfer } from './schema.js';

/**
 * The TypeBox schemas of the compiled model, `model.json`: the one source
 * for its type, its runtime validation and its published JSON Schema
 * (`schema/model.schema.json`), the same way `schema.ts` is the source for
 * the intended model's.
 */

export const CompiledZone = Type.Object(
  {
    id: Type.String(),
    kind: Type.String(),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledZone = Static<typeof CompiledZone>;

export const CompiledCategory = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledCategory = Static<typeof CompiledCategory>;

export const CompiledEnvironment = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
    bindings: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);
export type CompiledEnvironment = Static<typeof CompiledEnvironment>;

export const CompiledState = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledState = Static<typeof CompiledState>;

export const CompiledElement = Type.Object(
  {
    id: Type.String(),
    kind: ElementKind,
    name: Type.Optional(Type.String()),
    parent: Type.Optional(Type.String()),
    technology: Type.Optional(Type.String()),
    /** Ancestor ids, ordered from the root down to the immediate parent. */
    ancestors: Type.Array(Type.String()),
    evidence: Type.Optional(Type.Array(Evidence)),
    /** The element's zones, worked out after inheritance, add, exclude and replace. */
    zones: Type.Array(Type.String()),
    /** The element's zones in each environment it exists in, after the environment's own changes. */
    zonesByEnvironment: Type.Record(Type.String(), Type.Array(Type.String())),
    /** The environments the element exists in; every environment when unrestricted. */
    environments: Type.Array(Type.String()),
    /** The states the element exists in; every state when unrestricted. */
    states: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledElement = Static<typeof CompiledElement>;

export const CompiledInterface = Type.Object(
  {
    id: Type.String(),
    provider: Type.String(),
    contract: Type.String(),
    evidence: Type.Optional(Type.Array(Evidence)),
  },
  { additionalProperties: false },
);
export type CompiledInterface = Static<typeof CompiledInterface>;

export const CompiledRelation = Type.Object(
  {
    id: Type.String(),
    from: Type.String(),
    to: Type.String(),
    refines: Type.Optional(Type.String()),
    interface: Type.Optional(Type.String()),
    /** True when the relation carries an interface or transfers: it is an interaction. */
    interaction: Type.Boolean(),
    binding: Type.Optional(Binding),
    transfers: Type.Optional(Type.Array(Transfer)),
    evidence: Type.Optional(Type.Array(Evidence)),
    /** The environments the relation exists in: where both its ends exist. */
    environments: Type.Array(Type.String()),
    /** The states the relation exists in: its own since/until, intersected with both its ends. */
    states: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type CompiledRelation = Static<typeof CompiledRelation>;

export const CompiledModel = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    elements: Type.Array(CompiledElement),
    interfaces: Type.Array(CompiledInterface),
    relations: Type.Array(CompiledRelation),
    categories: Type.Array(CompiledCategory),
    zones: Type.Array(CompiledZone),
    environments: Type.Array(CompiledEnvironment),
    states: Type.Array(CompiledState),
  },
  { additionalProperties: false },
);
export type CompiledModel = Static<typeof CompiledModel>;

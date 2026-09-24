import { Type, type Static } from 'typebox';

/**
 * The TypeBox schemas are the one source for the intended model's types,
 * its runtime validation and its published JSON Schema. Later tasks add
 * more fields and top-level arrays (zones, environments, states) alongside
 * `elements`, `interfaces`, `relations` and `categories`.
 */

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
    line: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
export type Evidence = Static<typeof Evidence>;

export const Element = Type.Object(
  {
    id: Type.String(),
    kind: ElementKind,
    name: Type.Optional(Type.String()),
    parent: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(Evidence)),
  },
  { additionalProperties: false },
);
export type Element = Static<typeof Element>;

export const Category = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Category = Static<typeof Category>;

export const Interface = Type.Object(
  {
    id: Type.String(),
    provider: Type.String(),
    contract: Type.String(),
    evidence: Type.Optional(Type.Array(Evidence)),
  },
  { additionalProperties: false },
);
export type Interface = Static<typeof Interface>;

export const TransferDirection = Type.Union([Type.Literal('forward'), Type.Literal('reverse')]);
export type TransferDirection = Static<typeof TransferDirection>;

export const Transfer = Type.Object(
  {
    direction: TransferDirection,
    confidentiality: Type.String(),
    categories: Type.Array(Type.String()),
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

export const Relation = Type.Object(
  {
    id: Type.String(),
    from: Type.String(),
    to: Type.String(),
    refines: Type.Optional(Type.String()),
    interface: Type.Optional(Type.String()),
    binding: Type.Optional(Binding),
    transfers: Type.Optional(Type.Array(Transfer)),
    evidence: Type.Optional(Type.Array(Evidence)),
  },
  { additionalProperties: false },
);
export type Relation = Static<typeof Relation>;

export const ModelFile = Type.Object(
  {
    version: Type.Literal(1),
    elements: Type.Array(Element),
    interfaces: Type.Optional(Type.Array(Interface)),
    relations: Type.Optional(Type.Array(Relation)),
    categories: Type.Optional(Type.Array(Category)),
  },
  { additionalProperties: false },
);
export type ModelFile = Static<typeof ModelFile>;

/** One model, read from every `*.yaml` file of a repository's `madarch/` folder. */
export interface IntendedModel {
  version: 1;
  elements: Element[];
  interfaces: Interface[];
  relations: Relation[];
  categories: Category[];
}

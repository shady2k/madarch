import { Type, type Static } from 'typebox';

/**
 * The TypeBox schemas are the one source for the intended model's types,
 * its runtime validation and its published JSON Schema. Later tasks add
 * more fields and top-level arrays (interfaces, relations, zones,
 * categories, environments, states) alongside `elements`.
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

export const Element = Type.Object(
  {
    id: Type.String(),
    kind: ElementKind,
    name: Type.Optional(Type.String()),
    parent: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Element = Static<typeof Element>;

export const ModelFile = Type.Object(
  {
    version: Type.Literal(1),
    elements: Type.Array(Element),
  },
  { additionalProperties: false },
);
export type ModelFile = Static<typeof ModelFile>;

/** One model, read from every `*.yaml` file of a repository's `madarch/` folder. */
export interface IntendedModel {
  version: 1;
  elements: Element[];
}

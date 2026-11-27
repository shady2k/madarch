/** The source HTTP response is an explicit transport contract, not product catalogue data. */
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const SOURCE_LANGUAGE_SCHEMA = Type.Union([
  Type.Literal('typescript'), Type.Literal('javascript'), Type.Literal('go'), Type.Literal('sql'),
  Type.Literal('json'), Type.Literal('yaml'), Type.Literal('markdown'), Type.Literal('protobuf'),
  Type.Literal('prisma'), Type.Literal('shell'), Type.Literal('toml'), Type.Literal('dockerfile'),
  Type.Literal('makefile'), Type.Literal('text'),
]);
export type SourceLanguage = Static<typeof SOURCE_LANGUAGE_SCHEMA>;

export const SOURCE_RESPONSE_SCHEMA = Type.Object({
  repo: Type.Union([Type.String(), Type.Null()]),
  path: Type.String(),
  language: SOURCE_LANGUAGE_SCHEMA,
  commit: Type.Union([Type.String(), Type.Null()]),
  text: Type.String(),
}, { additionalProperties: false });
export type SourceResponse = Static<typeof SOURCE_RESPONSE_SCHEMA>;

/** Check the actual response before it crosses the HTTP boundary. */
export function decodeSourceResponse(value: unknown, place: string): SourceResponse {
  if (!Value.Check(SOURCE_RESPONSE_SCHEMA, value)) {
    const issue = [...Value.Errors(SOURCE_RESPONSE_SCHEMA, value)][0];
    throw new Error(`${place}: source response ${issue?.instancePath ?? ''} ${issue?.message ?? 'does not match SOURCE_RESPONSE_SCHEMA'}`);
  }
  return value;
}

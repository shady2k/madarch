/** Source coordinates shared by graph evidence producers and the page citation component. */
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const CITATION_SCHEMA = Type.Object({
  repository: Type.Union([Type.String(), Type.Null()]),
  path: Type.Union([Type.String(), Type.Null()]),
  lineStart: Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  lineEnd: Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
}, { additionalProperties: true });

export type Citation = Static<typeof CITATION_SCHEMA>;

/** Provenance metadata may accompany coordinates; no alias supplies a missing coordinate. */
export function decodeCitation(value: unknown, place: string): Citation {
  if (!Value.Check(CITATION_SCHEMA, value)) {
    const issue = [...Value.Errors(CITATION_SCHEMA, value)][0];
    throw new Error(`${place}: citation ${issue?.instancePath ?? ''} ${issue?.message ?? 'does not match CITATION_SCHEMA'}`);
  }
  const { repository, path, lineStart, lineEnd } = value;
  if ((lineStart === null) !== (lineEnd === null) || (lineStart !== null && lineEnd !== null && lineEnd < lineStart)) {
    throw new Error(`${place}: citation line range requires both positive endpoints in order`);
  }
  return { repository, path, lineStart, lineEnd };
}

import type { ModelWarning } from './errors.js';
import type { Relation } from './schema.js';
import { segmentsToPath, type PathSegment } from './yaml-position.js';

/**
 * A relation's name counts only if it says something: an empty or
 * whitespace-only `name` is treated as no name at all, both when loading
 * warns about it and when the compiler leaves it out of the compiled model,
 * so a reader never meets a blank label.
 */
export function isUnnamed(name: string | undefined): boolean {
  return name === undefined || name.trim() === '';
}

/**
 * The warning for one relation of one file, or none when it is named. A
 * missing `name` is reported at the relation itself (`relations[i]`, the
 * line its item starts on); a blank one at the `name` it gives
 * (`relations[i].name`, that key's line).
 */
export function unnamedRelationWarning(
  relation: Relation,
  file: string,
  index: number,
  line: (segments: PathSegment[]) => number,
): ModelWarning | undefined {
  if (!isUnnamed(relation.name)) return undefined;
  const segments: PathSegment[] = relation.name === undefined ? ['relations', index] : ['relations', index, 'name'];
  const problem = relation.name === undefined ? 'has no name' : 'has a blank name, which says nothing, so it is treated as unnamed';
  return {
    file,
    line: line(segments),
    path: segmentsToPath(segments),
    message: `relation "${relation.id}" ${problem}: give it a name saying what it does in a few words, such as "places orders"`,
  };
}

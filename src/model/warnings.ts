import type { ModelWarning } from './errors.js';
import type { Relation } from './schema.js';
import { messagingOf } from './contracts.js';
import type { PositionedEntity, PositionedRelation } from './validate.js';
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

/**
 * The warning for a relation through a topic or queue that does not say
 * whether its initiator sends or receives (intended-model/messaging), or none.
 * Reported at the relation itself (`relations[i]`, the line its item starts
 * on). `contracts` maps interface ids to their contracts; an interface it does
 * not hold was not declared by any readable file, and is reference checking's
 * to report.
 */
export function unmarkedMessagingWarning(entry: PositionedRelation, contracts: ReadonlyMap<string, string>): ModelWarning | undefined {
  const { relation } = entry;
  if (relation.action !== undefined || relation.interface === undefined) return undefined;
  const contract = contracts.get(relation.interface);
  const messaging = contract === undefined ? undefined : messagingOf(contract);
  if (messaging === undefined) return undefined;
  return {
    file: entry.file,
    line: entry.line,
    path: segmentsToPath(['relations', entry.index]),
    message: `relation "${relation.id}" goes through the ${messaging.kind} "${messaging.name}" without saying how: add "action: send" if it publishes or sends to it, "action: receive" if it subscribes to it or receives from it`,
  };
}

/**
 * The warning for a data entity whose `categories` field is not there at
 * all (intended-model/entities), or none. `categories: []` is an answer —
 * checked, of no category — and never warned about: only the field's
 * absence leaves the classification unstated. Reported at the entity
 * itself (`entities[i]`, the line its item starts on), so a legacy
 * repository's model still loads while its gaps stay open.
 */
export function entityClassificationWarning(entry: PositionedEntity): ModelWarning | undefined {
  if (entry.entity.categories !== undefined) return undefined;
  return {
    file: entry.file,
    line: entry.line,
    path: segmentsToPath(['entities', entry.index]),
    message: `entity "${entry.entity.id}" states no classification: its classification is not stated; give the categories it belongs to, or an empty list once checked and found of no category`,
  };
}

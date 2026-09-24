import type { ModelError } from './errors.js';
import type { Element } from './schema.js';

/**
 * An element together with where it was written, kept only for the
 * duration of loading: ids, references and cycles all need to name a
 * file and a line, but the compiled `IntendedModel` does not carry
 * positions.
 */
export interface PositionedElement {
  element: Element;
  file: string;
  line: number;
  parentLine: number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates ids and references across the whole model, once every file has
 * parsed and matched the schema. Checks run in stages, each assuming the
 * previous one found nothing: a malformed or duplicate id makes reference
 * and cycle checks meaningless, so later stages are skipped once an earlier
 * one reports a problem.
 */
export function validateElements(positioned: PositionedElement[]): ModelError[] {
  const syntaxErrors = checkIdSyntax(positioned);
  if (syntaxErrors.length > 0) return syntaxErrors;

  const duplicateErrors = checkDuplicateIds(positioned);
  if (duplicateErrors.length > 0) return duplicateErrors;

  const referenceErrors = checkParentReferences(positioned);
  if (referenceErrors.length > 0) return referenceErrors;

  return checkParentCycles(positioned);
}

function checkIdSyntax(positioned: PositionedElement[]): ModelError[] {
  const errors: ModelError[] = [];
  for (const { element, file, line } of positioned) {
    if (!ID_PATTERN.test(element.id)) {
      errors.push({
        file,
        line,
        path: 'id',
        message: `id "${element.id}" is not valid: ids are letters, digits, dots, dashes and underscores, starting with a letter or digit`,
      });
    }
  }
  return errors;
}

function checkDuplicateIds(positioned: PositionedElement[]): ModelError[] {
  const byId = new Map<string, PositionedElement[]>();
  for (const entry of positioned) {
    const group = byId.get(entry.element.id);
    if (group) group.push(entry);
    else byId.set(entry.element.id, [entry]);
  }

  const errors: ModelError[] = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const others = group
        .filter((other) => other !== entry)
        .map((other) => `${other.file}:${other.line}`)
        .join(', ');
      errors.push({
        file: entry.file,
        line: entry.line,
        path: 'id',
        message: `element id "${id}" is used more than once; also defined at ${others}`,
      });
    }
  }
  return errors;
}

function checkParentReferences(positioned: PositionedElement[]): ModelError[] {
  const knownIds = new Set(positioned.map((entry) => entry.element.id));
  const errors: ModelError[] = [];
  for (const entry of positioned) {
    const parent = entry.element.parent;
    if (parent === undefined || knownIds.has(parent)) continue;
    errors.push({
      file: entry.file,
      line: entry.parentLine,
      path: 'parent',
      message: `element "${entry.element.id}" names parent "${parent}", which does not exist`,
    });
  }
  return errors;
}

/**
 * Finds cycles of `parent` references. Safe to assume every `parent` names
 * a known element: `checkParentReferences` already ran and found nothing.
 */
function checkParentCycles(positioned: PositionedElement[]): ModelError[] {
  const byId = new Map(positioned.map((entry) => [entry.element.id, entry]));
  const errors: ModelError[] = [];
  const reported = new Set<string>();

  for (const start of positioned) {
    if (reported.has(start.element.id)) continue;

    const path: string[] = [];
    const seen = new Set<string>();
    let current: PositionedElement | undefined = start;

    while (current) {
      if (seen.has(current.element.id)) {
        const cycleStart = path.indexOf(current.element.id);
        const cycle = cycleStart >= 0 ? path.slice(cycleStart) : [current.element.id];
        for (const id of cycle) reported.add(id);
        const first = byId.get(cycle[0]!)!;
        errors.push({
          file: first.file,
          line: first.line,
          path: 'parent',
          message: `elements ${cycle.map((id) => `"${id}"`).join(', ')} form a cycle of parents`,
        });
        break;
      }
      seen.add(current.element.id);
      path.push(current.element.id);
      const parentId: string | undefined = current.element.parent;
      current = parentId === undefined ? undefined : byId.get(parentId);
    }
  }

  return errors;
}

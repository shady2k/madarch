import type { Element, IntendedModel } from './schema.js';

export const SCHEMA_VERSION = 1;

export interface CompiledElement {
  id: string;
  kind: Element['kind'];
  name?: string;
  parent?: string;
}

/**
 * The normalized JSON every frontend and agent reads. `JSON.stringify`
 * of this object is `model.json`. Later tasks add ancestors, interfaces,
 * relations, zones, categories, environments and states alongside
 * `elements`.
 */
export interface CompiledModel {
  schemaVersion: typeof SCHEMA_VERSION;
  elements: CompiledElement[];
}

export function compileModel(model: IntendedModel): CompiledModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    // Sorted by id so the compiled output never depends on which file (or
    // which order of files) an element was written in: the same model
    // split across files compiles to identical bytes.
    elements: [...model.elements].sort((a, b) => a.id.localeCompare(b.id)).map(compileElement),
  };
}

function compileElement(element: Element): CompiledElement {
  const compiled: CompiledElement = { id: element.id, kind: element.kind };
  if (element.name !== undefined) compiled.name = element.name;
  if (element.parent !== undefined) compiled.parent = element.parent;
  return compiled;
}

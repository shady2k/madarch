/**
 * The names a GraphQL schema gives a product's kinds, edges and fields (decision 0036, section 1): a kind is
 * split on `.`, `-` and `_`, each part capitalised and joined, and a field or an edge is the same parts in
 * camelCase. The reserved names are refused rather than renamed, and two declarations that encode to one name
 * refuse the manifest naming both, so two machines always derive one schema from one manifest.
 */

/** The scalars a contract field may name, by its declared type. */
export const SCALAR_NAMES: Readonly<Record<'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json', string>> = {
  text: 'String', integer: 'Int', bigint: 'BigInt', boolean: 'Boolean', timestamp: 'DateTime', json: 'JSON',
};

/** Field names the mechanism owns on every entity, and the suffixes it owns for its own fields. */
export const RESERVED_FIELD_NAMES: readonly string[] = ['id', 'kind', 'label', 'template', 'opinions', 'contested', 'backlinks'];
export const RESERVED_FIELD_SUFFIXES: readonly string[] = ['Of', 'Aggregate', 'Opinions'];

/** Type names the mechanism owns: the roots and the records it defines itself, the scalars, and the suffixes its generated types take. */
export const RESERVED_TYPE_NAMES: readonly string[] = [
  'Query', 'Entity', 'CatalogueEntity', 'PageTemplate', 'Bootstrap', 'Revision', 'Opinion', 'Evidence', 'Group', 'Bucket', 'Ranked',
  'String', 'Int', 'Float', 'Boolean', 'ID', 'BigInt', 'DateTime', 'JSON',
];
export const RESERVED_TYPE_SUFFIXES: readonly string[] = ['Connection', 'Edge', 'Where', 'Order', 'OrderField', 'Aggregate'];

/** Whether the schema owns the type name, so a kind or an edge may not encode to it. */
export function isReservedTypeName(name: string): boolean {
  return RESERVED_TYPE_NAMES.includes(name) || RESERVED_TYPE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** The parts of a kind, edge or field name: split on the separators section 1 names. */
function parts(name: string): string[] {
  return name.split(/[._-]/u).filter((part) => part !== '');
}

function capitalised(part: string): string {
  return part.slice(0, 1).toUpperCase() + part.slice(1);
}

/** The type name of a kind or an edge: `code.file` → `CodeFile`, `doc.use-case` → `DocUseCase`. */
export function typeNameOf(name: string): string {
  return parts(name).map(capitalised).join('');
}

/** The field name of a contract field or an edge kind: `commit_count` → `commitCount`, `code.contains` → `codeContains`. */
export function fieldNameOf(name: string): string {
  const held = parts(name);
  return held.map((part, at) => (at === 0 ? part.slice(0, 1).toLowerCase() + part.slice(1) : capitalised(part))).join('');
}

/** A refused manifest: its declaration, the name it encoded to and why that name is taken. */
export class SchemaRefusal extends Error {}

/**
 * The names one schema claims, each with the declaration that claimed it: two declarations encoding to one
 * name, or a reserved name, are refused here and the refusal names what stands on both sides.
 */
export class NameRegistry {
  private readonly types = new Map<string, string>();
  private readonly fields = new Map<string, string>();

  /** A type name, claimed by a declaration (`the kind "code.file"`). */
  claimType(name: string, declaration: string): void {
    if (isReservedTypeName(name)) {
      throw new SchemaRefusal(`${declaration} encodes to the type name "${name}", which is reserved by the schema: rename it`);
    }
    this.claim(this.types, name, name, declaration, 'type name');
  }

  /** A type name the schema itself generates (`CodeFileConnection`), which no reserved suffix applies to. */
  claimGeneratedType(name: string, declaration: string): void {
    this.claim(this.types, name, name, declaration, 'type name');
  }

  /** A field name on one type, claimed by a declaration (`the field "commit_count" of the kind "code.file"`). */
  claimField(type: string, name: string, declaration: string): void {
    if (RESERVED_FIELD_NAMES.includes(name) || name.startsWith('__') || RESERVED_FIELD_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      throw new SchemaRefusal(`${declaration} encodes to the field name "${name}", which is reserved by the schema: rename it`);
    }
    this.claim(this.fields, `${type}.${name}`, name, declaration, `field name of the type "${type}"`);
  }

  /** A field the schema itself generates (`<field>Opinions`, `backlinks`), which no reserved suffix applies to. */
  claimGeneratedField(type: string, name: string, declaration: string): void {
    this.claim(this.fields, `${type}.${name}`, name, declaration, `field name of the type "${type}"`);
  }

  private claim(held: Map<string, string>, key: string, name: string, declaration: string, what: string): void {
    const previous = held.get(key);
    if (previous !== undefined) throw new SchemaRefusal(`${previous} and ${declaration} both encode to the ${what} "${name}": rename one of them`);
    held.set(key, declaration);
  }
}

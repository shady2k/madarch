/**
 * The names a GraphQL schema gives a product's kinds, edges and fields (decision 0036, section 1): a kind is
 * split on `.`, `-` and `_`, each part capitalised and joined, and a field or an edge is the same parts in
 * camelCase.
 *
 * A GraphQL schema holds one name space, and the engine's own types — the roots, the records it defines itself and the
 * scalars — share it with the types a product's kinds generate. The two are kept apart by a declared rule rather than by
 * refusing names (the owner's review of madarch-u3vw.16): every type generated for a kind carries the fixed prefix
 * `Kind`, and no type of the engine's own begins with it, so any catalogue kind name is usable. `code.file` is the type
 * `KindCodeFile`; a kind named `page.template` is `KindPageTemplate`, beside the bootstrap's own `PageTemplate`.
 *
 * Two declarations that encode to one name refuse the manifest naming both, so two machines always derive one schema
 * from one manifest.
 */

/** The scalars a contract field may name, by its declared type. */
export const SCALAR_NAMES: Readonly<Record<'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json', string>> = {
  text: 'String', integer: 'Int', bigint: 'BigInt', boolean: 'Boolean', timestamp: 'DateTime', json: 'JSON',
};

/** Field names the mechanism owns on every entity, and the suffixes it owns for its own fields. */
export const RESERVED_FIELD_NAMES: readonly string[] = ['id', 'kind', 'label', 'template', 'assertions', 'contested', 'backlinks'];
export const RESERVED_FIELD_SUFFIXES: readonly string[] = ['Of', 'Aggregate', 'Assertions'];

/** The prefix every type generated for a kind carries: the engine's own types never begin with it (see above). */
export const KIND_TYPE_PREFIX = 'Kind';

/** The parts of a kind, edge or field name: split on the separators section 1 names. */
function parts(name: string): string[] {
  return name.split(/[._-]/u).filter((part) => part !== '');
}

function capitalised(part: string): string {
  return part.slice(0, 1).toUpperCase() + part.slice(1);
}

/** The parts of a kind's name as one identifier: `code.file` → `CodeFile`, `doc.use-case` → `DocUseCase`. */
export function typeNameOf(name: string): string {
  return parts(name).map(capitalised).join('');
}

/**
 * The schema type of a kind, in the family the engine does not name: `code.file` → `KindCodeFile`. Every type generated
 * from a kind's name — its connections, filters and orders — stands on this one, so a catalogue kind named after one of
 * the engine's own types is no clash.
 */
export function kindTypeNameOf(name: string): string {
  return `${KIND_TYPE_PREFIX}${typeNameOf(name)}`;
}

/**
 * The field name of a contract field or an edge kind: `commit_count` → `commitCount`, `code.contains` → `codeContains`.
 * A name the schema reserves — `id`, `kind`, `label`, `template`, `assertions`, `contested`, `backlinks`, a name starting
 * `__`, or one ending `Of`, `Aggregate`, `Assertions` (decision 0036, section 1) — is encoded rather than refused, so an
 * existing product keeps opening: the reserved word takes the `Field` suffix (`id` → `idField`), and a name starting
 * `__` takes the `field` prefix (`__x` → `field__x`).
 */
export function fieldNameOf(name: string): string {
  const held = parts(name);
  const camel = held.map((part, at) => (at === 0 ? part.slice(0, 1).toLowerCase() + part.slice(1) : capitalised(part))).join('');
  if (camel.startsWith('__')) return `field${camel}`;
  return isReservedFieldName(camel) ? `${camel}Field` : camel;
}

/** Whether the schema owns a field name, so a contract field of that name is encoded (not refused). */
export function isReservedFieldName(name: string): boolean {
  return RESERVED_FIELD_NAMES.includes(name) || name.startsWith('__') || RESERVED_FIELD_SUFFIXES.some((suffix) => name.endsWith(suffix));
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
    this.claim(this.types, name, name, declaration, 'type name');
  }

  /** A type name the schema itself generates (`CodeFileConnection`), which no reserved suffix applies to. */
  claimGeneratedType(name: string, declaration: string): void {
    this.claim(this.types, name, name, declaration, 'type name');
  }

  /** A field name on one type, claimed by a declaration (`the field "commit_count" of the kind "code.file"`). */
  claimField(type: string, name: string, declaration: string): void {
    // A reserved contract field name is already encoded by `fieldNameOf`; two declarations may still encode to one name.
    this.claim(this.fields, `${type}.${name}`, name, declaration, `field name of the type "${type}"`);
  }

  /** A field the schema itself generates (`<field>Assertions`, `backlinks`), which no reserved suffix applies to. */
  claimGeneratedField(type: string, name: string, declaration: string): void {
    this.claim(this.fields, `${type}.${name}`, name, declaration, `field name of the type "${type}"`);
  }

  private claim(held: Map<string, string>, key: string, name: string, declaration: string, what: string): void {
    const previous = held.get(key);
    if (previous !== undefined) throw new SchemaRefusal(`${previous} and ${declaration} both encode to the ${what} "${name}": rename one of them`);
    held.set(key, declaration);
  }
}

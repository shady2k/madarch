/**
 * The repository conventions the extractors read as data, not as code: the folders
 * whose manifests declare someone else's unit, the folders that declare a series of
 * migrations, a Prisma schema's own place, and which parsed statements declare
 * tables. Each entry carries the reference that says where the convention comes from,
 * and one test checks each entry (`test/extract-repository-conventions.test.ts`).
 */
import { createHash } from 'node:crypto';
import source from './repository-conventions.json' with { type: 'text' };

/** The bytes of the registry, as the file carries them. */
const bytes = source as unknown as string;

export interface ForeignManifestFolder {
  readonly id: string;
  /** One path segment: a manifest under a folder of this name declares another project's unit. */
  readonly folder: string;
  readonly ecosystem: 'node' | 'go';
  readonly reference: string;
}

export interface MigrationSeries {
  readonly id: string;
  /** The folder a series lives in, one path segment. */
  readonly folder: string;
  /** The folder the series' folder must stand in, one path segment; null for any. */
  readonly parent: string | null;
  /** The file a migration is, or null for every file that carries the suffix. */
  readonly fileName: string | null;
  readonly fileSuffix: string;
  /** Where a migration's own name comes from: the file's name, or the folder that holds `migration.sql`. */
  readonly nameFrom: 'file' | 'parent';
  readonly ordered: 'path';
  readonly reference: string;
}

export interface PrismaSchemaPlace {
  readonly id: string;
  readonly folder: string;
  readonly fileName: string;
  readonly reference: string;
}

export interface SchemaScript {
  readonly id: string;
  readonly fileSuffix: string;
  /** The statement kinds of the SQL reader that declare tables: such a file is a schema, not a seed. */
  readonly declaresTables: readonly string[];
  readonly reference: string;
}

export interface ComposeServiceDeclaration {
  readonly id: string;
  /** The compose keys a service declares its build context with, outermost first. */
  readonly keys: readonly string[];
  readonly namesUnit: boolean;
  readonly reference: string;
}

export interface RepositoryConventions {
  readonly foreignManifestFolders: readonly ForeignManifestFolder[];
  readonly migrationSeries: readonly MigrationSeries[];
  readonly prismaSchemas: readonly PrismaSchemaPlace[];
  readonly schemaScripts: readonly SchemaScript[];
  readonly composeServices: readonly ComposeServiceDeclaration[];
}

const fail = (detail: string): never => {
  throw new Error(`repository conventions: ${detail}`);
};

const record = (value: unknown, keys: readonly string[], where: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(`${where}: an object is required`);
  const held = value as Record<string, unknown>;
  for (const key of Object.keys(held)) if (!keys.includes(key)) fail(`${where}: unknown field ${key}`);
  return held;
};

const exactText = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) return fail(`${where}: a non-empty exact string is required`);
  if ([...value].some((character) => character.codePointAt(0)! < 32)) return fail(`${where}: a control character is not allowed`);
  return value;
};

/** A path segment the conventions compare: one folder name, never a path. */
const segment = (value: unknown, where: string): string => {
  const text = exactText(value, where);
  if (text.includes('/') || text === '.' || text === '..') return fail(`${where}: one path segment is required`);
  return text;
};

const reference = (value: unknown, where: string): string => {
  const text = exactText(value, where);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(`${where}: a reference must be an absolute URL`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return fail(`${where}: an https reference without credentials is required`);
  return text;
};

const entries = (value: unknown, keys: readonly string[], where: string): readonly Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length === 0) return fail(`${where}: a non-empty array is required`);
  return value.map((entry, at) => record(entry, keys, `${where}[${at}]`));
};

const unique = (values: readonly string[], where: string): void => {
  if (new Set(values).size !== values.length) fail(`${where}: duplicate id`);
};

/** The conventions, validated: a field this schema does not name stops the read. */
export function validateRepositoryConventions(value: unknown): RepositoryConventions {
  const root = record(value, ['schemaVersion', 'foreignManifestFolders', 'migrationSeries', 'prismaSchemas', 'schemaScripts', 'composeServices'], 'root');
  if (root['schemaVersion'] !== 1) fail('root: schemaVersion must be 1');
  const foreignManifestFolders = entries(root['foreignManifestFolders'], ['id', 'folder', 'ecosystem', 'reference'], 'foreignManifestFolders').map((entry, at) => {
    const where = `foreignManifestFolders[${at}]`;
    const ecosystem = exactText(entry['ecosystem'], `${where}.ecosystem`);
    if (ecosystem !== 'node' && ecosystem !== 'go') fail(`${where}.ecosystem: node or go is required`);
    return { id: exactText(entry['id'], `${where}.id`), folder: segment(entry['folder'], `${where}.folder`), ecosystem: ecosystem as 'node' | 'go', reference: reference(entry['reference'], `${where}.reference`) };
  });
  const migrationSeries = entries(root['migrationSeries'], ['id', 'folder', 'parent', 'fileName', 'fileSuffix', 'nameFrom', 'ordered', 'reference'], 'migrationSeries').map((entry, at) => {
    const where = `migrationSeries[${at}]`;
    const nameFrom = exactText(entry['nameFrom'], `${where}.nameFrom`);
    if (nameFrom !== 'file' && nameFrom !== 'parent') fail(`${where}.nameFrom: file or parent is required`);
    if (exactText(entry['ordered'], `${where}.ordered`) !== 'path') fail(`${where}.ordered: path is the only order`);
    const parent = entry['parent'] === null ? null : segment(entry['parent'], `${where}.parent`);
    const fileName = entry['fileName'] === null ? null : exactText(entry['fileName'], `${where}.fileName`);
    if (nameFrom === 'parent' && fileName === null) fail(`${where}: a series named by its parent folder names the file it holds`);
    return {
      id: exactText(entry['id'], `${where}.id`), folder: segment(entry['folder'], `${where}.folder`), parent, fileName,
      fileSuffix: exactText(entry['fileSuffix'], `${where}.fileSuffix`), nameFrom: nameFrom as 'file' | 'parent', ordered: 'path' as const,
      reference: reference(entry['reference'], `${where}.reference`),
    };
  });
  const prismaSchemas = entries(root['prismaSchemas'], ['id', 'folder', 'fileName', 'reference'], 'prismaSchemas').map((entry, at) => {
    const where = `prismaSchemas[${at}]`;
    return { id: exactText(entry['id'], `${where}.id`), folder: segment(entry['folder'], `${where}.folder`), fileName: exactText(entry['fileName'], `${where}.fileName`), reference: reference(entry['reference'], `${where}.reference`) };
  });
  const schemaScripts = entries(root['schemaScripts'], ['id', 'fileSuffix', 'declaresTables', 'reference'], 'schemaScripts').map((entry, at) => {
    const where = `schemaScripts[${at}]`;
    if (!Array.isArray(entry['declaresTables']) || entry['declaresTables'].length === 0) fail(`${where}.declaresTables: a non-empty array is required`);
    const declaresTables = (entry['declaresTables'] as readonly unknown[]).map((kind, index) => exactText(kind, `${where}.declaresTables[${index}]`));
    unique(declaresTables, `${where}.declaresTables`);
    return { id: exactText(entry['id'], `${where}.id`), fileSuffix: exactText(entry['fileSuffix'], `${where}.fileSuffix`), declaresTables, reference: reference(entry['reference'], `${where}.reference`) };
  });
  const composeServices = entries(root['composeServices'], ['id', 'keys', 'namesUnit', 'reference'], 'composeServices').map((entry, at) => {
    const where = `composeServices[${at}]`;
    if (!Array.isArray(entry['keys']) || entry['keys'].length === 0) fail(`${where}.keys: a non-empty array is required`);
    const keys = (entry['keys'] as readonly unknown[]).map((key, index) => segment(key, `${where}.keys[${index}]`));
    unique(keys, `${where}.keys`);
    if (typeof entry['namesUnit'] !== 'boolean') fail(`${where}.namesUnit: a boolean is required`);
    return { id: exactText(entry['id'], `${where}.id`), keys, namesUnit: entry['namesUnit'] as boolean, reference: reference(entry['reference'], `${where}.reference`) };
  });
  unique([...foreignManifestFolders, ...prismaSchemas, ...schemaScripts, ...composeServices, ...migrationSeries].map((entry) => entry.id), 'root');
  return { foreignManifestFolders, migrationSeries, prismaSchemas, schemaScripts, composeServices };
}

export const repositoryConventions: RepositoryConventions = validateRepositoryConventions(JSON.parse(bytes));

/** The digest of these bytes: part of the extractors' interpretation identity. */
export function repositoryConventionsDigest(): string {
  return createHash('sha256').update(bytes).digest('hex');
}

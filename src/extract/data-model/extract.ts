/**
 * The data-model extractor (madarch-o0eq.2): one repository tree in, the
 * records of decision 0028 out. It reads the SQL migrations of every service
 * in their applied order and every Prisma schema, and says which code reads or
 * writes which table. Pure: no database, no network, no clock - the same tree
 * gives the same `Extraction` anywhere (records.ts).
 *
 * What it emits, all under the engine's `code.` prefix:
 *
 * - `code.database` per service that holds one (a `migrations` folder or a
 *   `prisma` schema), `code.table`, `code.column` (type, nullability,
 *   default), `code.index` (partial indexes with their WHERE included), and
 *   `code.migration` per applied migration with its ordinal.
 * - `code.foreign-key` edges from the referencing to the referenced table,
 *   with the column, the target column, the referential actions and the
 *   cardinality (`many-to-one`: one order has many order_items).
 * - `code.logical-reference` edges for a column that names another service's
 *   table without a foreign key (`payments.order_id`), never a foreign key.
 * - `code.reads-table` and `code.writes-table` edges from the function that
 *   holds the access - from SQL literals and Prisma client calls, and, through
 *   the Go call roll-up of `go-calls.ts`, from the repository methods that
 *   reach a table only through a helper or the outbox writer.
 *
 * A table an access names that no migration declares is a gap, never a
 * silence; so is an SQL file in scope without a readable statement, a schema
 * without models, and bytes that are not text.
 */
import {byCodePoint} from '../../model/order.js';
import type {ExtractedEdge, ExtractedNode, Extraction, ExtractionGap, SourceSpan, TreeReader} from '../records.js';
import {extractFileAccess, type AccessSite, type FileAccess, type FunctionRegion} from './access.js';
import {indexGoPackage, resolveGoCalls, type GoPackageFile, type ResolvedCall} from './go-calls.js';
import {DATA_MODEL_PRODUCER, columnKey, databaseKey, fileKey, functionKey, indexKey, migrationKey, tableKey} from './keys.js';
import {parsePrismaSchema, type PrismaModel} from './prisma.js';
import {parseSqlScript, type SqlColumnDecl, type SqlIndexDecl, type SqlStatement, type SqlTableDecl} from './sql.js';
import {ByteText} from './text-scan.js';

const READS = 'code.reads-table' as const;
const WRITES = 'code.writes-table' as const;

interface MigrationFile {
  readonly database: string;
  readonly name: string;
  readonly path: string;
  readonly prisma: boolean;
}

interface MergedColumn {
  readonly name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primaryKey: boolean;
  unique: boolean;
  check?: string;
  span?: SourceSpan;
}

interface MergedForeignKey {
  readonly column: string;
  readonly targetTable: string;
  readonly targetColumn?: string;
  readonly onDelete?: string;
  readonly onUpdate?: string;
  readonly constraint?: string;
}

interface MergedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
  readonly span?: SourceSpan;
}

interface MergedTable {
  readonly name: string;
  readonly schema: string;
  readonly columns: Map<string, MergedColumn>;
  readonly primaryKey: string[];
  readonly foreignKeys: MergedForeignKey[];
  readonly indexes: Map<string, MergedIndex>;
  span?: SourceSpan;
}

interface MergedDatabase {
  readonly name: string;
  readonly tables: Map<string, MergedTable>;
  readonly migrations: MigrationFile[];
}

/** A table access resolved to its database: the ends an access edge carries. */
interface ResolvedAccess {
  readonly verb: 'read' | 'write';
  readonly to: string;
  readonly via: string;
}

interface AccessEdgeDraft {
  readonly type: 'code.reads-table' | 'code.writes-table';
  readonly from: string;
  readonly to: string;
  readonly via: string;
  readonly callee?: string;
  readonly sites: SourceSpan[];
}

type TextOrGap = {readonly ok: true; readonly text: string} | {readonly ok: false; readonly reason: string};

/**
 * Extracts the data model and the table access of one repository tree.
 */
export async function extractDataModel(tree: TreeReader): Promise<Extraction> {
  const databases = new Map<string, MergedDatabase>();
  const gaps: ExtractionGap[] = [];
  const migrations: MigrationFile[] = [];
  const prismaSchemas = new Map<string, string>();
  const codePaths: string[] = [];
  const scriptPaths: string[] = [];

  for (const path of [...tree.paths].sort(byCodePoint)) {
    const service = serviceOf(path);
    if (/^services\/[^/]+\/migrations\/[^/]+\.sql$/.test(path) && service !== undefined) {
      migrations.push({database: service, name: path.slice(path.lastIndexOf('/') + 1), path, prisma: false});
      continue;
    }
    const prismaMigration = /^services\/([^/]+)\/prisma\/migrations\/([^/]+)\/migration\.sql$/.exec(path);
    if (prismaMigration !== null) {
      migrations.push({database: prismaMigration[1]!, name: prismaMigration[2]!, path, prisma: true});
      continue;
    }
    if (/^services\/[^/]+\/prisma\/schema\.prisma$/.test(path) && service !== undefined) {
      prismaSchemas.set(service, path);
      continue;
    }
    if (/^scripts\/[^/]+\.sql$/.test(path)) {
      scriptPaths.push(path);
      continue;
    }
    if (service !== undefined && languageOf(path) !== null) codePaths.push(path);
  }

  // ---- the migrations, in their applied order ------------------------------
  const topLevel = migrations.filter((migration) => !migration.prisma).sort((left, right) => byCodePoint(left.database, right.database) || byCodePoint(left.name, right.name));
  const prismaLevel = migrations.filter((migration) => migration.prisma).sort((left, right) => byCodePoint(left.database, right.database) || byCodePoint(left.name, right.name));
  const ordered = [...topLevel, ...prismaLevel];
  const migrationOrdinals = new Map<string, number>();
  const perDatabase = new Map<string, number>();
  for (const migration of ordered) {
    const next = (perDatabase.get(migration.database) ?? 0) + 1;
    perDatabase.set(migration.database, next);
    migrationOrdinals.set(migration.path, next);
    databaseOf(databases, migration.database).migrations.push(migration);
  }

  // ---- the DDL of the migrations, applied in order --------------------------
  for (const migration of ordered) {
    const read = readUtf8(tree, migration.path);
    if (!read.ok) {
      gaps.push({path: migration.path, reason: read.reason});
      continue;
    }
    const script = parseSqlScript(migration.path, read.text);
    applyStatements(databaseOf(databases, migration.database), script.statements, gaps);
    if (!script.statements.some((statement) => statement.kind !== 'other')) {
      gaps.push({path: migration.path, reason: 'no table or column statement could be read'});
    }
  }

  // ---- the Prisma schemas ---------------------------------------------------
  const prismaFieldSpans = new Map<string, Map<string, SourceSpan>>();
  const prismaModelTables = new Map<string, Map<string, string>>();
  for (const [service, path] of [...prismaSchemas].sort((left, right) => byCodePoint(left[0], right[0]))) {
    const read = readUtf8(tree, path);
    if (!read.ok) {
      gaps.push({path, reason: read.reason});
      continue;
    }
    const models = parsePrismaSchema(path, read.text);
    if (models.length === 0) {
      gaps.push({path, reason: 'no model could be read from the Prisma schema'});
      continue;
    }
    const database = databaseOf(databases, service);
    const fieldSpans = new Map<string, SourceSpan>();
    const modelTables = new Map<string, string>();
    const modelColumns = new Map<string, Map<string, string>>();
    for (const model of models) {
      modelTables.set(model.model, model.table);
      modelTables.set(modelPropertyOf(model.model), model.table);
      const columns = new Map<string, string>();
      for (const field of model.fields) columns.set(field.field, field.column);
      modelColumns.set(model.model, columns);
    }
    for (const model of models) {
      const table = tableOf(database, model.table);
      // A table the schema declares is cited at the model block, where @@map stands.
      table.span = model.span;
      applyPrismaModel(table, model, modelTables, modelColumns, fieldSpans);
    }
    prismaFieldSpans.set(service, fieldSpans);
    prismaModelTables.set(service, modelTables);
  }

  // ---- the code's table access ---------------------------------------------
  interface CodeFile {
    readonly path: string;
    readonly access: FileAccess;
    readonly text: string;
  }
  const codeFiles: CodeFile[] = [];
  for (const path of codePaths) {
    const read = readUtf8(tree, path);
    if (!read.ok) {
      gaps.push({path, reason: read.reason});
      continue;
    }
    const access = await extractFileAccess(path, tree.read(path));
    codeFiles.push({path, access, text: read.text});
    for (const gap of access.unread) gaps.push({path: gap.what, reason: `code could not be read: ${gap.reason}`});
    const database = databaseOf(databases, serviceOf(path)!);
    for (const declaration of access.tableDeclarations) {
      // A table the code itself creates (the migration runner's schema_migrations).
      const table = tableOf(database, declaration.table);
      if (table.span === undefined) table.span = declaration.span;
    }
  }

  // What each region accesses directly, resolved to its database.
  const regionAccesses = new Map<string, ResolvedAccess[]>();
  const edgeDrafts: AccessEdgeDraft[] = [];
  const endpointKeys = new Set<string>();
  const noteGap = (path: string, reason: string): void => {
    gaps.push({path, reason});
  };

  const resolveSite = (file: CodeFile, site: AccessSite): string | undefined => {
    const service = serviceOf(file.path)!;
    if (site.via === 'prisma-client') {
      const table = prismaModelTables.get(service)?.get(site.table);
      if (table === undefined) {
        noteGap(file.path, `the Prisma model ${site.table} is not declared by the service's schema`);
        return undefined;
      }
      return tableKey(service, table);
    }
    const database = databases.get(service);
    if (database?.tables.has(site.table)) return tableKey(database.name, site.table);
    const elsewhere = [...databases.values()].filter((candidate) => candidate.tables.has(site.table));
    if (elsewhere.length === 1) return tableKey(elsewhere[0]!.name, site.table);
    noteGap(file.path, `the table ${site.table} the code names is not declared by exactly one database of the tree`);
    return undefined;
  };

  for (const file of codeFiles) {
    const immediate = new Map<string, AccessEdgeDraft>();
    for (const site of file.access.sites) {
      const to = resolveSite(file, site);
      if (to === undefined) continue;
      const type = site.verb === 'read' ? READS : WRITES;
      // A site no function region holds belongs to the file itself.
      const from = site.region === '' ? fileKey(file.path) : functionKey(file.path, site.region);
      const key = `${type} ${from} ${to}`;
      const held = immediate.get(key);
      if (held !== undefined) {
        if (!held.sites.some((candidate) => candidate.byteStart === site.span.byteStart)) held.sites.push({...site.span});
        continue;
      }
      immediate.set(key, {type, from, to, via: site.via, sites: [{...site.span}]});
      if (site.region !== '') {
        const accesses = regionAccesses.get(site.region) ?? [];
        accesses.push({verb: site.verb, to, via: site.via});
        regionAccesses.set(site.region, accesses);
      }
    }
    edgeDrafts.push(...immediate.values());
    for (const draft of immediate.values()) endpointKeys.add(draft.from);
  }

  // ---- the Go packages' call roll-up ----------------------------------------
  const goDirectories = new Map<string, CodeFile[]>();
  for (const file of codeFiles) {
    if (file.access.language !== 'go') continue;
    const directory = file.path.slice(0, file.path.lastIndexOf('/') + 1);
    const held = goDirectories.get(directory) ?? [];
    held.push(file);
    goDirectories.set(directory, held);
  }
  for (const [directory, files] of [...goDirectories].sort((left, right) => byCodePoint(left[0], right[0]))) {
    const packageFiles: GoPackageFile[] = files.map((file) => ({path: file.path, text: file.text, regions: file.access.regions}));
    const index = indexGoPackage(packageFiles);
    const resolvedByCaller = new Map<string, {caller: FunctionRegion; calls: ResolvedCall[]}[]>();
    for (const file of files) {
      const resolved = resolveGoCalls({path: file.path, text: file.text, regions: file.access.regions}, index);
      for (const region of file.access.regions) {
        const calls = resolved.filter((call) => call.site.path === file.path && within(call, region));
        if (calls.length === 0) continue;
        const held = resolvedByCaller.get(file.path) ?? [];
        held.push({caller: region, calls});
        resolvedByCaller.set(file.path, held);
      }
    }
    for (const [path, callers] of [...resolvedByCaller].sort((left, right) => byCodePoint(left[0], right[0]))) {
      const database = databases.get(serviceOf(path)!);
      for (const {caller, calls} of callers) {
        // One roll-up per first hop: the accesses the hop's callee reaches,
        // directly or through its own resolved calls (a bounded breadth, the
        // caller's own name ending the walk).
        const byFirstHop = new Map<string, ResolvedCall[]>();
        for (const call of calls) {
          const held = byFirstHop.get(call.callee.qualifiedName) ?? [];
          held.push(call);
          byFirstHop.set(call.callee.qualifiedName, held);
        }
        for (const [firstHop, sites] of [...byFirstHop].sort((left, right) => byCodePoint(left[0], right[0]))) {
          const collected = new Map<string, ResolvedAccess>();
          const visited = new Set<string>([caller.qualifiedName]);
          const stack = [firstHop];
          while (stack.length > 0) {
            const name = stack.pop()!;
            if (visited.has(name)) continue;
            visited.add(name);
            for (const access of regionAccesses.get(name) ?? []) {
              collected.set(`${access.verb} ${access.to}`, access);
            }
            const further = [...resolvedByCaller.values()].flat().find((entry) => entry.caller.qualifiedName === name);
            if (further !== undefined) {
              for (const call of further.calls) stack.push(call.callee.qualifiedName);
            }
          }
          const from = functionKey(path, caller.qualifiedName);
          for (const access of [...collected.values()].sort((left, right) => byCodePoint(`${left.verb} ${left.to}`, `${right.verb} ${right.to}`))) {
            edgeDrafts.push({
              type: access.verb === 'read' ? READS : WRITES,
              from,
              to: access.to,
              via: access.via,
              callee: firstHop,
              sites: sites.map((call) => ({...call.site})),
            });
          }
          endpointKeys.add(from);
          void database;
        }
      }
    }
  }

  // ---- the seed scripts ------------------------------------------------------
  for (const path of scriptPaths) {
    const read = readUtf8(tree, path);
    if (!read.ok) {
      gaps.push({path, reason: read.reason});
      continue;
    }
    const writes = scanScriptWrites(path, read.text);
    const recognized = /\b(CREATE|ALTER|INSERT|UPDATE|DELETE|SELECT)\b/i.test(read.text);
    if (writes.length === 0 && !recognized && read.text.trim() !== '') {
      gaps.push({path, reason: 'no CREATE, ALTER, INSERT, UPDATE, DELETE or SELECT statement could be read'});
    }
    for (const write of writes) {
      const owners = [...databases.values()].filter((candidate) => candidate.tables.has(write.table));
      if (owners.length !== 1) {
        noteGap(path, `the table ${write.table} the script fills is not declared by exactly one database of the tree`);
        continue;
      }
      edgeDrafts.push({type: WRITES, from: fileKey(path), to: tableKey(owners[0]!.name, write.table), via: 'sql', sites: [write.span]});
      endpointKeys.add(fileKey(path));
    }
  }

  // ---- the logical references ------------------------------------------------
  const logicalEdges: ExtractedEdge[] = [];
  for (const database of [...databases.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
    for (const table of [...database.tables.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
      for (const column of [...table.columns.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
        if (!column.name.endsWith('_id')) continue;
        if (table.foreignKeys.some((foreignKey) => foreignKey.column === column.name)) continue;
        const entity = column.name.slice(0, -'_id'.length);
        for (const candidate of [entity, `${entity}s`, `${entity}es`]) {
          const targets = [...databases.values()].filter((other) => other.name !== database.name && other.tables.has(candidate));
          if (targets.length !== 1) continue;
          const target = targets[0]!.tables.get(candidate)!;
          const targetColumn = target.primaryKey.length === 1 ? target.primaryKey[0]! : target.columns.has('id') ? 'id' : undefined;
          const fieldSpan = prismaFieldSpans.get(database.name)?.get(`${table.name}.${column.name}`);
          logicalEdges.push({
            type: 'code.logical-reference',
            from: tableKey(database.name, table.name, table.schema),
            to: tableKey(targets[0]!.name, target.name, target.schema),
            discriminator: column.name,
            properties: {
              column: column.name,
              ...(targetColumn !== undefined ? {targetColumn} : {}),
              targetDatabase: targets[0]!.name,
            },
            ...(fieldSpan !== undefined ? {span: fieldSpan} : column.span !== undefined ? {span: column.span} : {}),
          });
          break;
        }
      }
    }
  }

  // ---- the nodes --------------------------------------------------------------
  const nodes: ExtractedNode[] = [];
  for (const database of [...databases.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
    nodes.push({key: databaseKey(database.name), kind: 'code.database', label: database.name, properties: {service: database.name}});
    for (const migration of database.migrations) {
      nodes.push({
        key: migrationKey(database.name, migration.name),
        kind: 'code.migration',
        label: migration.name,
        properties: {path: migration.path, ordinal: migrationOrdinals.get(migration.path) ?? 0},
      });
    }
    for (const table of [...database.tables.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
      nodes.push({
        key: tableKey(database.name, table.name, table.schema),
        kind: 'code.table',
        label: table.name,
        properties: {schema: table.schema, database: database.name},
        ...(table.span !== undefined ? {span: table.span} : {}),
      });
      for (const column of [...table.columns.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
        nodes.push({
          key: columnKey(database.name, table.name, column.name, table.schema),
          kind: 'code.column',
          label: column.name,
          properties: {
            type: column.type,
            nullable: column.nullable,
            ...(column.default !== undefined ? {default: column.default} : {}),
            ...(column.primaryKey ? {primaryKey: true} : {}),
            ...(column.unique ? {unique: true} : {}),
            ...(column.check !== undefined ? {check: column.check} : {}),
          },
          ...(column.span !== undefined ? {span: column.span} : {}),
        });
      }
      for (const index of [...table.indexes.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
        nodes.push({
          key: indexKey(database.name, table.name, index.name, table.schema),
          kind: 'code.index',
          label: index.name,
          properties: {
            columns: [...index.columns].sort(byCodePoint),
            unique: index.unique,
            ...(index.where !== undefined ? {where: index.where} : {}),
          },
          ...(index.span !== undefined ? {span: index.span} : {}),
        });
      }
    }
  }
  for (const key of [...endpointKeys].sort(byCodePoint)) {
    if (key.startsWith('code.file:')) {
      const filePath = key.slice('code.file:'.length);
      const role = /\.sql$/.test(filePath) ? 'sql-script' : 'code';
      nodes.push({key: fileKey(filePath), kind: 'code.file', label: filePath.slice(filePath.lastIndexOf('/') + 1), properties: {role}});
      continue;
    }
    const separator = key.indexOf('#');
    const filePath = key.slice('code.function:'.length, separator);
    const qualifiedName = key.slice(separator + 1);
    const region = codeFiles.map((file) => file.access).find((access) => access.path === filePath)?.regions.find((candidate) => candidate.qualifiedName === qualifiedName);
    nodes.push({
      key: functionKey(filePath, qualifiedName),
      kind: 'code.function',
      label: qualifiedName,
      properties: {language: region?.language ?? '', symbolKind: region?.symbolKind ?? ''},
      ...(region !== undefined ? {span: region.span} : {}),
    });
  }

  // ---- the foreign keys --------------------------------------------------------
  const foreignEdges: ExtractedEdge[] = [];
  for (const database of [...databases.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
    for (const table of [...database.tables.values()].sort((left, right) => byCodePoint(left.name, right.name))) {
      for (const foreignKey of table.foreignKeys) {
        const targetTable = database.tables.get(foreignKey.targetTable);
        if (targetTable === undefined) {
          gaps.push({
            path: table.span?.path ?? `databases/${database.name}`,
            reason: `the foreign key of ${table.name}.${foreignKey.column} targets ${foreignKey.targetTable}, which no migration of ${database.name} declares`,
          });
          continue;
        }
        const targetColumn = foreignKey.targetColumn ?? (targetTable.primaryKey.length === 1 ? targetTable.primaryKey[0]! : undefined);
        foreignEdges.push({
          type: 'code.foreign-key',
          from: tableKey(database.name, table.name, table.schema),
          to: tableKey(database.name, targetTable.name, targetTable.schema),
          discriminator: foreignKey.constraint ?? foreignKey.column,
          properties: {
            column: foreignKey.column,
            ...(targetColumn !== undefined ? {targetColumn} : {}),
            ...(foreignKey.constraint !== undefined ? {constraint: foreignKey.constraint} : {}),
            ...(foreignKey.onDelete !== undefined ? {onDelete: foreignKey.onDelete} : {}),
            ...(foreignKey.onUpdate !== undefined ? {onUpdate: foreignKey.onUpdate} : {}),
            cardinality: 'many-to-one',
          },
          ...(table.span !== undefined ? {span: table.span} : {}),
        });
      }
    }
  }

  const edges: ExtractedEdge[] = [...foreignEdges, ...logicalEdges, ...edgeDrafts.map(toEdge)].sort(edgeOrder);
  return {
    producer: DATA_MODEL_PRODUCER,
    nodes: [...nodes].sort((left, right) => byCodePoint(left.key, right.key)),
    edges,
    gaps: [...gaps].sort((left, right) => byCodePoint(left.path, right.path) || byCodePoint(left.reason, right.reason)),
  };
}

function toEdge(draft: AccessEdgeDraft): ExtractedEdge {
  return {
    type: draft.type,
    from: draft.from,
    to: draft.to,
    discriminator: draft.callee ?? '',
    properties: {
      via: draft.via,
      ...(draft.callee !== undefined ? {callee: draft.callee} : {}),
      sites: [...draft.sites]
        .sort((left, right) => left.byteStart - right.byteStart)
        .map((site) => ({path: site.path, byteStart: site.byteStart, byteEnd: site.byteEnd, lineStart: site.lineStart, lineEnd: site.lineEnd})),
    },
    span: draft.sites[0],
  };
}

function edgeOrder(left: ExtractedEdge, right: ExtractedEdge): number {
  return byCodePoint(`${left.type} ${left.from} ${left.to} ${left.discriminator}`, `${right.type} ${right.from} ${right.to} ${right.discriminator}`);
}

function within(call: ResolvedCall, region: FunctionRegion): boolean {
  return call.site.byteStart >= region.span.byteStart && call.site.byteEnd <= region.span.byteEnd;
}

function serviceOf(path: string): string | undefined {
  const match = /^services\/([^/]+)\//.exec(path);
  return match?.[1];
}

function languageOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return ['.go', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'].includes(extension) ? extension.slice(1) : null;
}

function databaseOf(databases: Map<string, MergedDatabase>, name: string): MergedDatabase {
  const held = databases.get(name);
  if (held !== undefined) return held;
  const created: MergedDatabase = {name, tables: new Map(), migrations: []};
  databases.set(name, created);
  return created;
}

function tableOf(database: MergedDatabase, name: string, schema = 'public'): MergedTable {
  // Keyed by the table's own name: the code names tables without their schema,
  // and a database of one service holds one table of a name.
  const held = database.tables.get(name);
  if (held !== undefined) return held;
  const created: MergedTable = {name, schema, columns: new Map(), primaryKey: [], foreignKeys: [], indexes: new Map()};
  database.tables.set(name, created);
  return created;
}

/** Reads a path's bytes as text; the reason is the gap when they cannot be read. */
function readUtf8(tree: TreeReader, path: string): TextOrGap {
  let bytes: Uint8Array;
  try {
    bytes = tree.read(path);
  } catch (error) {
    return {ok: false, reason: `could not be read: ${error instanceof Error ? error.message : String(error)}`};
  }
  try {
    return {ok: true, text: new TextDecoder('utf-8', {fatal: true}).decode(bytes)};
  } catch {
    return {ok: false, reason: 'the bytes are not UTF-8 text'};
  }
}

function applyStatements(database: MergedDatabase, statements: readonly SqlStatement[], gaps: ExtractionGap[]): void {
  for (const statement of statements) {
    if (statement.kind === 'create-table') {
      applyTable(database, statement.table);
      continue;
    }
    if (statement.kind === 'alter-table-add-column') {
      const table = database.tables.get(statement.table);
      if (table === undefined) {
        gaps.push({path: statement.column.span.path, reason: `ALTER TABLE ${statement.table} names a table no migration of ${database.name} declares`});
        continue;
      }
      applyColumn(table, statement.column, table.primaryKey);
      continue;
    }
    if (statement.kind === 'alter-table-add-foreign-key') {
      const table = database.tables.get(statement.table);
      if (table === undefined) continue;
      table.foreignKeys.push(statement.foreignKey);
      continue;
    }
    if (statement.kind === 'create-index') {
      const table = database.tables.get(statement.table);
      if (table === undefined) continue;
      applyIndex(table, statement.index);
    }
  }
}

function applyTable(database: MergedDatabase, declaration: SqlTableDecl): void {
  const table = tableOf(database, declaration.name, declaration.schema);
  if (table.span === undefined) table.span = declaration.span;
  if (declaration.primaryKey.length > 0 && table.primaryKey.length === 0) table.primaryKey.push(...declaration.primaryKey);
  for (const column of declaration.columns) {
    applyColumn(table, column, table.primaryKey);
    if (column.foreignKey !== undefined) table.foreignKeys.push(column.foreignKey);
  }
  for (const foreignKey of declaration.foreignKeys) table.foreignKeys.push(foreignKey);
}

function applyColumn(table: MergedTable, declaration: SqlColumnDecl, primaryKey: readonly string[]): void {
  const held = table.columns.get(declaration.name);
  if (held !== undefined) return;
  table.columns.set(declaration.name, {
    name: declaration.name,
    type: declaration.type,
    nullable: declaration.nullable,
    ...(declaration.default !== undefined ? {default: declaration.default} : {}),
    primaryKey: declaration.primaryKey || (primaryKey.length === 1 && primaryKey[0] === declaration.name),
    unique: declaration.unique,
    ...(declaration.check !== undefined ? {check: declaration.check} : {}),
    span: declaration.span,
  });
}

function applyIndex(table: MergedTable, declaration: SqlIndexDecl): void {
  if (table.indexes.has(declaration.name)) return;
  table.indexes.set(declaration.name, {...declaration});
  if (declaration.unique && declaration.columns.length === 1) {
    const column = table.columns.get(declaration.columns[0]!);
    if (column !== undefined) column.unique = true;
  }
}

/** The property name a Prisma client answers a model by (`Payment` is `payment`). */
function modelPropertyOf(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function applyPrismaModel(
  table: MergedTable,
  model: PrismaModel,
  modelTables: ReadonlyMap<string, string>,
  modelColumns: ReadonlyMap<string, ReadonlyMap<string, string>>,
  fieldSpans: Map<string, SourceSpan>,
): void {
  const columnByField = new Map<string, string>();
  for (const field of model.fields) columnByField.set(field.field, field.column);
  for (const field of model.fields) {
    if (field.isRelation) continue;
    fieldSpans.set(`${table.name}.${field.column}`, field.span);
    const held = table.columns.get(field.column);
    if (held !== undefined) {
      if (field.primaryKey) held.primaryKey = true;
      if (field.unique) held.unique = true;
      continue;
    }
    table.columns.set(field.column, {
      name: field.column,
      type: field.type,
      nullable: field.nullable,
      ...(field.default !== undefined ? {default: field.default} : {}),
      primaryKey: field.primaryKey,
      unique: field.unique,
    });
  }
  if (table.primaryKey.length === 0) {
    const keys = [...table.columns.values()].filter((column) => column.primaryKey).map((column) => column.name);
    if (keys.length > 0) table.primaryKey.push(...keys);
  }
  for (const field of model.fields) {
    const relation = field.relation;
    if (relation === undefined || relation.fields.length === 0) continue;
    const targetTable = modelTables.get(field.type) ?? field.type;
    const column = columnByField.get(relation.fields[0]!) ?? relation.fields[0]!;
    if (table.foreignKeys.some((held) => held.column === column && held.targetTable === targetTable)) continue;
    const targetColumns = modelColumns.get(field.type);
    const targetColumn = targetColumns?.get(relation.references[0] ?? 'id') ?? relation.references[0] ?? 'id';
    table.foreignKeys.push({
      column,
      targetTable,
      targetColumn,
      ...(relation.onDelete !== undefined ? {onDelete: relation.onDelete} : {}),
      ...(relation.onUpdate !== undefined ? {onUpdate: relation.onUpdate} : {}),
    });
  }
  for (const index of model.indexes) {
    const columns = index.columns.map((field) => columnByField.get(field) ?? field);
    if (indexColumnsHeld(table, columns)) continue;
    const name = index.name ?? `${table.name}_${columns.join('_')}_idx`;
    table.indexes.set(name, {name, columns, unique: false, span: table.span});
  }
  for (const index of model.uniqueIndexes) {
    const columns = index.columns.map((field) => columnByField.get(field) ?? field);
    if (indexColumnsHeld(table, columns)) continue;
    const name = index.name ?? `${table.name}_${columns.join('_')}_key`;
    table.indexes.set(name, {name, columns, unique: true, span: table.span});
    if (columns.length === 1) {
      const column = table.columns.get(columns[0]!);
      if (column !== undefined) column.unique = true;
    }
  }
}

function indexColumnsHeld(table: MergedTable, columns: readonly string[]): boolean {
  const wanted = [...columns].sort(byCodePoint).join(',');
  return [...table.indexes.values()].some((held) => [...held.columns].sort(byCodePoint).join(',') === wanted);
}

/** The writes one seed script holds: one per INSERT statement, at its own span. */
function scanScriptWrites(path: string, text: string): readonly {readonly table: string; readonly span: SourceSpan}[] {
  const bytes = new ByteText(text);
  const writes: {table: string; span: SourceSpan}[] = [];
  for (const match of text.matchAll(/\bINSERT\s+INTO\s+"?(\w+)"?/gi)) {
    const start = match.index ?? 0;
    let end = text.indexOf(';', start);
    if (end === -1) end = text.length;
    const trimmed = text.slice(start, end).trimEnd();
    writes.push({
      table: match[1]!,
      span: {
        path,
        byteStart: bytes.byteAt(start),
        byteEnd: bytes.byteAt(start + trimmed.trimEnd().length),
        lineStart: bytes.lineOf(bytes.byteAt(start)),
        lineEnd: bytes.lineOf(bytes.byteAt(start + trimmed.trimEnd().length)),
      },
    });
  }
  return writes;
}

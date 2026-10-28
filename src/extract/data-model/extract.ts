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
import {serviceOfPath, serviceUnits, unitIndex, unitOfPath, type ServiceUnit, type UnitIndex} from '../service-units.js';
import {repositoryConventions} from '../library-models/repository-conventions.js';
import {parsePostgres, type ParseResult} from '../../parsers/postgres.js';
import {extractFileSyntax} from '../../fill/stages/syntax-extract.js';
import {readGoMod} from '../../fill/stages/manifest-format.js';
import {parseEnv} from 'node:util';
import {codeFactsOf, extractCodeWithFacts} from '../code/index.js';
import type {CodeExpressionFact, CodeFacts} from '../code/facts.js';
import {CodeFactView} from '../operations/code-facts.js';
import {evaluateLibraryModels} from '../library-models/evaluate.js';
import {environmentModels} from '../library-models/environment-models.js';
import type {ExtractedEdge, ExtractedNode, Extraction, ExtractionGap, SourceSpan, TreeReader} from '../records.js';
import {extractFileAccess, type AccessSite, type FileAccess, type FunctionRegion} from './access.js';
import {indexGoPackage, resolveGoCalls, type GoPackageFile, type ResolvedCall} from './go-calls.js';
import {DATA_MODEL_PRODUCER, columnKey, databaseKey, fileKey, functionKey, indexKey, migrationKey, tableKey} from './keys.js';
import {parsePrismaSchema, type PrismaModel} from './prisma.js';
import {parseSqlScript, type SqlColumnDecl, type SqlIndexDecl, type SqlStatement, type SqlTableDecl} from './sql.js';
import {ByteText} from './text-scan.js';
import {isMap, isScalar, LineCounter, parseDocument} from 'yaml';

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
  readonly evidence: StorageEvidence[];
}

interface StorageEvidence {
  readonly kind: string;
  readonly span: SourceSpan;
  readonly model?: string;
  readonly expression?: string;
  readonly holder?: string;
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
export async function extractDataModel(tree: TreeReader, suppliedCode?: Extraction, suppliedFacts?: CodeFacts): Promise<Extraction> {
  // A caller that already owns the code pass must lend its exact immutable facts.
  // Never parse a second tree to compensate for missing shared facts.
  const shared = suppliedCode === undefined && suppliedFacts === undefined ? await extractCodeWithFacts(tree) : undefined;
  const code = suppliedCode ?? shared?.extraction;
  const facts = suppliedFacts ?? shared?.facts ?? (suppliedCode === undefined ? undefined : codeFactsOf(suppliedCode, tree));
  const canonicalFunctions = (code?.nodes ?? []).filter((node) => node.kind === 'code.symbol' && node.span !== undefined && ['function', 'method', 'constructor'].includes(String(node.properties.symbolKind)));
  const databases = new Map<string, MergedDatabase>();
  const gaps: ExtractionGap[] = [];
  const migrations: MigrationFile[] = [];
  const prismaSchemas = new Map<string, string>();
  const codePaths: string[] = [];
  const scriptPaths: string[] = [];
  // The units the repository declares, and the question every loop below asks of a path.
  const units = unitIndex(serviceUnits(tree));
  const serviceOf = (path: string): string | undefined => serviceOfPath(units, path);

  for (const path of [...tree.paths].sort(byCodePoint)) {
    const service = serviceOf(path);
    const unit = unitOfPath(units, path);
    const segments = path.split('/');
    const file = segments[segments.length - 1] ?? '';
    // A migration is what its series declares it to be (repository-conventions.ts): a `.sql` inside a
    // `migrations` folder, or prisma's `<name>/migration.sql` beside its `schema.prisma`. The database is
    // the unit that holds the folder, or the folder itself when no unit does (madarch-mwhd.3).
    const series = migrationSeriesOf(segments, file);
    const databaseOfPath = (at: number): string => unit?.name ?? folderName(segments.slice(0, at).join('/'));
    if (series !== undefined) {
      migrations.push({database: databaseOfPath(series.at), name: series.name, path, prisma: series.series.nameFrom === 'parent'});
      continue;
    }
    const schemaPlace = repositoryConventions.prismaSchemas.find((entry) => entry.fileName === file && segments[segments.length - 2] === entry.folder);
    if (schemaPlace !== undefined) {
      prismaSchemas.set(databaseOfPath(segments.length - 2), path);
      continue;
    }
    if (file.endsWith('.sql')) {
      // A script that declares tables is that folder's schema, not a seed: the parser's own statement
      // kinds decide (repository-conventions.ts), so a file keeps its DDL wherever it stands.
      const declared = await declaresTables(path, tree);
      if (declared.kind === 'schema') {
        migrations.push({database: databaseOfPath(segments.length - 1), name: file, path, prisma: false});
      } else {
        if (declared.kind === 'unread') gaps.push(declared.gap);
        scriptPaths.push(path);
      }
      continue;
    }
    if (service !== undefined && languageOf(path) !== null) codePaths.push(path);
  }

  // Positive connection or driver evidence may describe a database without
  // declaring tables. A service directory, by itself, is never such evidence.
  await collectStorageEvidence(tree, units, databases, gaps, facts);

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
      // The failing line, named with the whole repository path: a migration that reads no statement is a
      // gap a person can open, never a silent empty schema (madarch-mwhd.3 review 5).
      const first = script.statements.find((statement) => statement.kind === 'other');
      const line = first === undefined ? 1 : first.span.lineStart;
      const detail = first === undefined ? 'the file holds no statement' : 'the statement is no CREATE, ALTER or INDEX this reader knows';
      gaps.push({path: migration.path, reason: `${migration.path}:${line}: no table or column declaration could be read: ${detail}`});
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
    for (const declaration of access.tableDeclarations) {
      // A service's source files alone say nothing about storage. Only an
      // actual CREATE declaration provides positive database evidence here.
      const database = databaseOf(databases, serviceOf(path)!);
      const table = tableOf(database, declaration.table);
      if (table.span === undefined) table.span = declaration.span;
    }
  }

  // What each region accesses directly, resolved to its database: keyed by
  // the file's directory first, so two packages' same-named functions never
  // lend each other an access.
  const regionAccesses = new Map<string, Map<string, ResolvedAccess[]>>();
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
    noteGap(file.path, `line ${site.span.lineStart}: table ${site.table} is not declared by service ${service}'s database; no connection evidence resolves it to a sibling database (${file.path})`);
    return undefined;
  };

  for (const file of codeFiles) {
    const immediate = new Map<string, AccessEdgeDraft>();
    for (const site of file.access.sites) {
      const to = resolveSite(file, site);
      if (to === undefined) continue;
      const type = site.verb === 'read' ? READS : WRITES;
      const owner = canonicalFunctions.filter((node) => node.span!.path === file.path && node.span!.byteStart <= site.span.byteStart && site.span.byteEnd <= node.span!.byteEnd)
        .sort((a, b) => (a.span!.byteEnd - a.span!.byteStart) - (b.span!.byteEnd - b.span!.byteStart))[0];
      if (owner === undefined && site.region !== '') {
        noteGap(file.path, `line ${site.span.lineStart}: table access has no canonical positioned function owner (${file.path})`);
        continue;
      }
      const from = owner?.key ?? fileKey(file.path);
      const key = `${type} ${from} ${to}`;
      const held = immediate.get(key);
      if (held !== undefined) {
        if (!held.sites.some((candidate) => candidate.byteStart === site.span.byteStart)) held.sites.push({...site.span});
        continue;
      }
      immediate.set(key, {type, from, to, via: site.via, sites: [{...site.span}]});
      const regionName = owner === undefined ? '' : String(owner.properties.qualifiedName);
      if (regionName !== '') {
        const directory = file.path.slice(0, file.path.lastIndexOf('/') + 1);
        const packageAccesses = regionAccesses.get(directory) ?? new Map<string, ResolvedAccess[]>();
        const accesses = packageAccesses.get(regionName) ?? [];
        accesses.push({verb: site.verb, to, via: site.via});
        packageAccesses.set(regionName, accesses);
        regionAccesses.set(directory, packageAccesses);
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
          const packageAccesses = regionAccesses.get(directoryOf(path)) ?? new Map<string, ResolvedAccess[]>();
          while (stack.length > 0) {
            const name = stack.pop()!;
            if (visited.has(name)) continue;
            visited.add(name);
            for (const access of packageAccesses.get(name) ?? []) {
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
    const script = await scanScriptWrites(path, read.text);
    if (script.gap !== undefined) {
      gaps.push(script.gap);
      continue;
    }
    if (!script.recognized && read.text.trim() !== '') {
      gaps.push({path, reason: `${path}:1: no PostgreSQL statement could be read`});
    }
    for (const write of script.writes) {
      const owners = [...databases.values()].flatMap((database) => [...database.tables.values()]
        .filter((table) => table.name === write.table
          && (write.schema === undefined || table.schema === write.schema)
          && (write.catalog === undefined || database.name === write.catalog))
        .map((table) => ({database, table})));
      // The existing migration model can merge same-named tables. Do not let
      // that lossy representation turn an ambiguous seed into a claimed write.
      const collapsed = owners.some(({database}) => {
        const schemas = new Set<string>();
        for (const migration of database.migrations) {
          const source = readUtf8(tree, migration.path);
          if (!source.ok) continue;
          for (const statement of parseSqlScript(migration.path, source.text).statements) {
            if (statement.kind === 'create-table' && statement.table.name === write.table) schemas.add(statement.table.schema);
          }
        }
        return schemas.size > 1;
      });
      if (owners.length !== 1 || collapsed) {
        const identity = [write.catalog, write.schema, write.table].filter((part) => part !== undefined).join('.');
        noteGap(path, `${path}:${write.span.lineStart}: the table ${identity} the script fills is not declared by exactly one database of the tree`);
        continue;
      }
      const owner = owners[0]!;
      edgeDrafts.push({type: WRITES, from: fileKey(path), to: tableKey(owner.database.name, owner.table.name, owner.table.schema), via: 'sql', sites: [write.span]});
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
    // The database's place is the first file that declares it — its first migration, its schema, or the folder it
    // stands in — and every migration names its own file (madarch-m38l.16: a node says where it stands).
    const declaredIn = database.migrations[0]?.path ?? prismaSchemas.get(database.name) ?? firstTablePath(database);
    const evidence = database.evidence[0];
    const span = declaredIn === undefined ? evidence?.span : wholeFile(tree, declaredIn);
    if (span === undefined) throw new Error(`data model: database ${database.name} has no positive storage evidence`);
    nodes.push({
      key: databaseKey(database.name),
      kind: 'code.database',
      label: database.name,
      properties: {service: database.name, path: span.path, evidenceKind: declaredIn === undefined ? evidence!.kind : 'schema', evidence: database.evidence.map((item) => ({kind: item.kind, path: item.span.path, line: item.span.lineStart}))},
      span,
    });
    for (const migration of database.migrations) {
      nodes.push({
        key: migrationKey(database.name, migration.name),
        kind: 'code.migration',
        label: migration.name,
        properties: {path: migration.path, ordinal: migrationOrdinals.get(migration.path) ?? 0},
        span: wholeFile(tree, migration.path),
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
    const filePath = key.slice('code.symbol:'.length, separator);
    const qualifiedName = key.slice(separator + 1);
    const canonical = canonicalFunctions.find((node) => node.key === key);
    if (canonical !== undefined) {nodes.push(canonical); continue;}
    const region = codeFiles.map((file) => file.access).find((access) => access.path === filePath)?.regions.find((candidate) => candidate.qualifiedName === qualifiedName);
    nodes.push({
      key: functionKey(filePath, qualifiedName),
      kind: 'code.symbol',
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

  const structuralEdges: ExtractedEdge[] = [];
  const structuralSeen = new Set<string>();
  // One relation between two records is published once: a migration that alters the same table in two statements says so
  // once, and the store refuses a second record of the same relation (madarch-m38l.16).
  const edge = (type: string, from: string, to: string, span?: SourceSpan, properties: ExtractedEdge['properties'] = {}): void => {
    const identity = `${type}\u0000${from}\u0000${to}`;
    if (structuralSeen.has(identity)) return;
    structuralSeen.add(identity);
    structuralEdges.push({ type: type as ExtractedEdge['type'], from, to, discriminator: '', properties, ...(span === undefined ? {} : {span}) });
  };
  for (const database of databases.values()) {
    const dbKey = databaseKey(database.name);
    const readings: StorageEvidence[] = [...database.evidence];
    for (const migration of database.migrations) {
      const read = readUtf8(tree, migration.path);
      if (read.ok) for (const statement of parseSqlScript(migration.path, read.text).statements) {
        if (statement.kind === 'other') continue;
        const span = statement.kind === 'create-table' ? statement.table.span : statement.kind === 'alter-table-add-column' ? statement.column.span : statement.kind === 'create-index' ? statement.index.span : statement.span;
        readings.push({kind: 'schema', span});
      }
    }
    const prismaPath = prismaSchemas.get(database.name);
    if (prismaPath !== undefined) for (const table of database.tables.values()) if (table.span?.path === prismaPath) readings.push({kind: 'schema', span: table.span});
    for (const table of database.tables.values()) if (table.span !== undefined && !readings.some((reading) => reading.span.path === table.span!.path && reading.span.byteStart === table.span!.byteStart && reading.span.byteEnd === table.span!.byteEnd)) readings.push({kind: 'schema', span: table.span});
    if (readings.length === 0) gaps.push({path: database.migrations[0]?.path ?? database.name, reason: `line 1: database ${database.name} has no contributing storage reading; service use is unresolved`});
    else structuralEdges.push({type: 'code.uses-database', from: `code.service:${database.name}`, to: dbKey, discriminator: '', properties: {via: readings.some((reading) => reading.kind === 'schema') ? 'schema' : readings[0]!.kind, origins: readings.map((reading) => ({sourceProducer: DATA_MODEL_PRODUCER, originalDiscriminator: '', sourceSpan: {...reading.span}, properties: {via: reading.kind, ...(reading.model === undefined ? {} : {environmentModel: reading.model}), ...(reading.expression === undefined ? {} : {expression: reading.expression}), ...(reading.holder === undefined ? {} : {holder: reading.holder})}}))}, span: readings[0]!.span});
    for (const migration of database.migrations) {
      const migrationId = migrationKey(database.name, migration.name);
      edge('code.contains', dbKey, migrationId);
      const read = readUtf8(tree, migration.path);
      if (!read.ok) continue;
      for (const statement of parseSqlScript(migration.path, read.text).statements) {
        if (statement.kind === 'create-table') {
          const tableId = tableKey(database.name, statement.table.name, statement.table.schema);
          edge('code.creates', migrationId, tableId, statement.table.span);
          for (const column of statement.table.columns) edge('code.creates', migrationId, columnKey(database.name, statement.table.name, column.name, statement.table.schema), column.span);
        } else if (statement.kind === 'alter-table-add-column') {
          edge('code.alters', migrationId, tableKey(database.name, statement.table, statement.schema), statement.column.span, {object: 'table'});
          edge('code.alters', migrationId, columnKey(database.name, statement.table, statement.column.name, statement.schema), statement.column.span, {object: 'column'});
        } else if (statement.kind === 'alter-table-add-foreign-key') {
          edge('code.alters', migrationId, tableKey(database.name, statement.table, statement.schema), statement.span, {object: 'table'});
          edge('code.alters', migrationId, columnKey(database.name, statement.table, statement.foreignKey.column, statement.schema), statement.span, {object: 'column'});
        } else if (statement.kind === 'create-index') {
          edge('code.creates', migrationId, indexKey(database.name, statement.table, statement.index.name, statement.schema), statement.index.span);
        }
      }
    }
    for (const table of database.tables.values()) {
      const tableId = tableKey(database.name, table.name, table.schema);
      edge('code.holds', dbKey, tableId, table.span);
      for (const column of table.columns.values()) edge('code.contains', tableId, columnKey(database.name, table.name, column.name, table.schema), column.span);
      for (const index of table.indexes.values()) {
        const indexId = indexKey(database.name, table.name, index.name, table.schema);
        edge('code.contains', tableId, indexId, index.span);
        for (const name of index.columns) edge('code.covers', indexId, columnKey(database.name, table.name, name, table.schema), index.span);
      }
    }
  }
  for (const node of nodes) if (node.kind !== 'code.file' && node.span !== undefined) edge('code.contains', fileKey(node.span.path), node.key, node.span);
  const edges: ExtractedEdge[] = [...structuralEdges, ...foreignEdges, ...logicalEdges, ...edgeDrafts.map(toEdge)].sort(edgeOrder);
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

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

function within(call: ResolvedCall, region: FunctionRegion): boolean {
  return call.site.byteStart >= region.span.byteStart && call.site.byteEnd <= region.span.byteEnd;
}

/** One migration the registry's series declare: its name, and the folder index the series stands at. */
interface MigrationPlace {
  readonly series: (typeof repositoryConventions.migrationSeries)[number];
  readonly name: string;
  /** The index of the series' folder among the path's segments. */
  readonly at: number;
}

/** The series one path belongs to, read from the registry's entries: folder, parent, file and suffix. */
function migrationSeriesOf(segments: readonly string[], file: string): MigrationPlace | undefined {
  // The most specific series first: prisma's `<name>/migration.sql` stands inside a `migrations`
  // folder too, and the folder that names its parent is the one that declares it.
  const ordered = [...repositoryConventions.migrationSeries].sort((left, right) => Number(right.parent !== null) - Number(left.parent !== null));
  for (const series of ordered) {
    if (!file.endsWith(series.fileSuffix)) continue;
    if (series.fileName !== null && file !== series.fileName) continue;
    const at = segments.lastIndexOf(series.folder);
    if (at < 0) continue;
    if (series.parent !== null && segments[at - 1] !== series.parent) continue;
    const name = series.nameFrom === 'file' ? file : segments[at + 1];
    if (name === undefined || name === '') continue;
    return {series, name, at};
  }
  return undefined;
}

/**
 * Whether one `.sql` file declares tables, decided by the SQL parser's own statement kinds
 * (repository-conventions.ts `schemaScripts`): a file that creates, alters or indexes a table is a
 * schema wherever it stands; a file that only writes rows is a seed.
 */
async function declaresTables(path: string, tree: TreeReader): Promise<{kind: 'schema'} | {kind: 'script'} | {kind: 'unread'; gap: ExtractionGap}> {
  const read = readUtf8(tree, path);
  if (!read.ok) return {kind: 'unread', gap: {path, reason: read.reason}};
  const kinds = new Set(repositoryConventions.schemaScripts.flatMap((entry) => (path.endsWith(entry.fileSuffix) ? entry.declaresTables : [])));
  if (kinds.size === 0) return {kind: 'script'};
  let parsed: ParseResult;
  try {
    parsed = await parsePostgres(read.text);
  } catch (error) {
    // The parser names its own position; the caller reports it with this file's path and line.
    const bytes = new ByteText(read.text);
    const details = error instanceof Error && 'sqlDetails' in error ? error.sqlDetails : undefined;
    const cursor = typeof details === 'object' && details !== null && 'cursorPosition' in details && typeof details.cursorPosition === 'number' ? details.cursorPosition : 0;
    const prefix = Array.from(read.text).slice(0, Math.max(0, cursor)).join('');
    const line = bytes.lineOf(new TextEncoder().encode(prefix).length);
    const message = error instanceof Error ? error.message : String(error);
    return {kind: 'unread', gap: {path, reason: `${path}:${line}: PostgreSQL parse failed: ${message}`}};
  }
  for (const raw of parsed.stmts ?? []) {
    const statement = raw.stmt as Record<string, unknown> | undefined;
    if (statement === undefined) continue;
    if (Object.keys(statement).some((key) => kinds.has(key))) return {kind: 'schema'};
  }
  return {kind: 'script'};
}

/** The last folder of a path, the name an unowned folder declares itself by. */
function folderName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

function languageOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return ['.go', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'].includes(extension) ? extension.slice(1) : null;
}

function databaseOf(databases: Map<string, MergedDatabase>, name: string): MergedDatabase {
  const held = databases.get(name);
  if (held !== undefined) return held;
  const created: MergedDatabase = {name, tables: new Map(), migrations: [], evidence: []};
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

/** The file a database without a migration is declared in: the file of its first table, or none. */
function firstTablePath(database: MergedDatabase): string | undefined {
  for (const table of database.tables.values()) if (table.span !== undefined) return table.span.path;
  return undefined;
}

/** The span of a whole file, or the first line where its bytes cannot be read: a database and a migration say where they stand. */
function wholeFile(tree: TreeReader, path: string): SourceSpan {
  const read = readUtf8(tree, path);
  const lines = read.ok && read.text !== '' ? read.text.split('\n').length : 1;
  const bytes = (() => {
    try {
      return tree.read(path).length;
    } catch {
      return 0;
    }
  })();
  return {path, byteStart: 0, byteEnd: bytes, lineStart: 1, lineEnd: lines};
}

/** Reads only explicit storage declarations; generic config files never imply a database. */
async function collectStorageEvidence(tree: TreeReader, units: UnitIndex, databases: Map<string, MergedDatabase>, gaps: ExtractionGap[], facts?: CodeFacts): Promise<void> {
  const serviceOf = (path: string): string | undefined => serviceOfPath(units, path);
  const spanAt = (path: string, text: string, start: number, end: number): SourceSpan => {
    const bytes = new ByteText(text);
    return {path, byteStart: bytes.byteAt(start), byteEnd: bytes.byteAt(end), lineStart: bytes.lineOf(bytes.byteAt(start)), lineEnd: bytes.lineOf(bytes.byteAt(end))};
  };
  const add = (service: string, kind: string, span: SourceSpan, metadata: Omit<StorageEvidence, 'kind' | 'span'> = {}): void => {
    databaseOf(databases, service).evidence.push({kind, span, ...metadata});
  };
  const environment = new Map(environmentModels.map(model => [model.variable, model]));
  if (facts !== undefined) collectEnvironmentReadEvidence(facts, units, databases, gaps);
  for (const path of [...tree.paths].sort(byCodePoint)) {
    const service = serviceOf(path);
    const codeSource = languageOf(path) !== null;
    const source = service !== undefined && (codeSource || /(?:\.json|\/go\.mod|\.?env(?:\.[^/]*)?)$/.test(path));
    const compose = /(?:^|\/)(?:docker-)?compose(?:\.[^/.]+)?\.ya?ml$/.test(path);
    if (!source && !compose) continue;
    const read = readUtf8(tree, path);
    if (!read.ok) { gaps.push({path, reason: read.reason}); continue; }
    const text = read.text;
    if (service !== undefined && source) {
      const driver = /^(?:pg|postgres|mysql2?|better-sqlite3|sqlite3|@prisma\/client|github\.com\/(?:jackc\/pgx(?:\/.*)?|lib\/pq|go-sql-driver\/mysql)|modernc\.org\/sqlite)$/;
      if (codeSource) {
        const syntax = await extractFileSyntax(path, tree.read(path));
        for (const imported of syntax.imports) if (driver.test(imported.specifier)) add(service, 'driver', {
          path, byteStart: imported.span.startByte, byteEnd: imported.span.endByte, lineStart: imported.span.startLine, lineEnd: imported.span.endLine,
        });
        if (facts === undefined) gaps.push({path, reason: `line 1: shared CodeFacts are absent; environment connection evidence is unresolved (${path})`});
      } else if (path.endsWith('/package.json')) {
        try {
          const manifest = JSON.parse(text) as {dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>};
          for (const name of Object.keys({...manifest.devDependencies, ...manifest.dependencies}).sort(byCodePoint)) if (driver.test(name)) {
            const at = text.indexOf(JSON.stringify(name)); add(service, 'driver', spanAt(path, text, at, at + name.length + 2));
          }
        } catch (error) { gaps.push({path, reason: `line 1: storage evidence cannot read package.json: ${error instanceof Error ? error.message : String(error)}`}); }
      } else if (path.endsWith('/go.mod')) {
        const manifest = readGoMod(text);
        if (manifest.ok) for (const entry of manifest.value.requires) if (driver.test(entry.path)) {
          const at = text.split('\n').slice(0, entry.line - 1).join('\n').length + (entry.line > 1 ? 1 : 0); add(service, 'driver', spanAt(path, text, at, at + (text.split('\n')[entry.line - 1]?.length ?? 0)));
        }
      } else if (path.slice(path.lastIndexOf('/') + 1).startsWith('.env') || path.endsWith('/env')) {
        try {
          const variables = parseEnv(text);
          if (Object.keys(variables).length === 0 && text.split('\n').some(line => line.trim() !== '' && !line.trimStart().startsWith('#'))) {
            gaps.push({path, reason: `line 1: environment parser returned no assignments for non-comment configuration; connection evidence is unresolved (${path})`});
          }
          for (const name of Object.keys(variables).sort(byCodePoint)) {
            const model = environment.get(name);
            if (model !== undefined && variables[name] !== '') add(service, 'connection-setting', wholeFile(tree, path), {model: model.id});
          }
        } catch (error) { gaps.push({path, reason: `line 1: environment configuration cannot be parsed: ${error instanceof Error ? error.message : String(error)} (${path})`}); }
      }
    }
    if (compose) {
      const lc = new LineCounter();
      const doc = parseDocument(text, {lineCounter: lc});
      if (doc.errors.length > 0) { for (const error of doc.errors) gaps.push({path, reason: `line ${lc.linePos(error.pos[0]).line}: ${error.message}`}); continue; }
      if (!isMap(doc.contents)) continue;
      const services = doc.contents.get('services', true);
      if (!isMap(services)) continue;
      for (const pair of services.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isMap(pair.value)) continue;
        const name = pair.key.value;
        // Associate only product services actually present in this tree, not
        // an arbitrary compose infrastructure service or image label.
        // A compose service is one this repository declares as a unit, by the name the unit declares.
        if (![...units.manifests.values(), ...units.others.values()].some((held) => held.name === name)) continue;
        const env = pair.value.get('environment', true);
        if (!isMap(env)) continue;
        for (const item of env.items) {
          if (!isScalar(item.key) || typeof item.key.value !== 'string') continue;
          const model = environment.get(item.key.value);
          if (model === undefined) continue;
          if (!isScalar(item.value) || typeof item.value.value !== 'string') continue;
          const range = item.value.range ?? item.key.range;
          if (range == null || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] <= range[0] || range[1] > text.length) {
            gaps.push({path, reason: `line 1: deployment connection setting ${String(item.key.value)} of service ${name} has no valid source range; no storage evidence is created`});
            continue;
          }
          add(name, 'deployment-connection', spanAt(path, text, range[0], range[1]), {model: model.id});
        }
      }
    }
  }
}

/** Resolve environment reads only from the already copied lexical facts. */
function collectEnvironmentReadEvidence(facts: CodeFacts, units: UnitIndex, databases: Map<string, MergedDatabase>, gaps: ExtractionGap[]): void {
  const serviceOf = (path: string): string | undefined => serviceOfPath(units, path);
  const view = new CodeFactView(facts);
  const environment = new Map(environmentModels.map(model => [model.variable, model]));
  const files = new Map(facts.files.map(file => [file.path, file]));
  const parents = new Map<string, CodeExpressionFact[]>();
  for (const expression of facts.expressions) for (const child of expression.children) {
    const held = parents.get(child) ?? []; held.push(expression); parents.set(child, held);
  }
  const gap = (expression: CodeExpressionFact, reason: string): void => {
    gaps.push({path: expression.path, reason: `line ${expression.span.lineStart}: ${reason} at bytes ${expression.span.byteStart}-${expression.span.byteEnd} (${expression.path})`});
  };
  const contains = (outer: SourceSpan, inner: SourceSpan): boolean => outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;
  const field = (expression: CodeExpressionFact, name: string): CodeExpressionFact | undefined => {
    const ids = expression.fields[name];
    return ids?.length === 1 ? view.expressions.get(ids[0]!) : undefined;
  };
  const member = (expression: CodeExpressionFact): {receiver: CodeExpressionFact; name?: string} | undefined => {
    if (expression.syntaxKind === 'member_expression' && expression.receiver !== undefined) {
      const receiver = view.expressions.get(expression.receiver);
      const object = field(expression, 'object'); const property = field(expression, 'property');
      if (receiver !== undefined && receiver.id === object?.id && expression.member === property?.name && contains(expression.span, receiver.span)) return {receiver, name: expression.member};
    }
    if (expression.syntaxKind === 'subscript_expression') {
      const receiver = field(expression, 'object'); const index = field(expression, 'index');
      if (receiver !== undefined && index !== undefined && contains(expression.span, receiver.span) && contains(expression.span, index.span)) {
        const value = view.value(index.id);
        return {receiver, ...(typeof value === 'string' ? {name: value} : {})};
      }
    }
    return undefined;
  };
  const isRead = (expression: CodeExpressionFact): boolean => {
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (seen.has(id)) return false; seen.add(id);
      for (const parent of parents.get(id) ?? []) {
        if (['assignment_expression', 'augmented_assignment_expression'].includes(parent.syntaxKind) && (parent.fields.left ?? []).includes(id)) return false;
        if (parent.syntaxKind === 'update_expression') return false;
        // Unary operators are not copied as tokens, so delete cannot be
        // distinguished from a read here. Do not invent read evidence.
        if (parent.syntaxKind === 'unary_expression') { gap(expression, 'unary environment access is unresolved'); return false; }
        if (['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression'].includes(parent.syntaxKind) && !visit(parent.id)) return false;
      }
      return true;
    };
    return visit(expression.id);
  };
  const record = (expression: CodeExpressionFact, name: unknown, holder?: string): void => {
    const service = serviceOf(expression.path);
    if (service === undefined) return;
    if (typeof name !== 'string') { gap(expression, 'environment variable name is unresolved'); return; }
    const model = environment.get(name); if (model === undefined) return;
    const owners = facts.symbols.filter(symbol => symbol.callable && contains(symbol.span, expression.span))
      .sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart) || byCodePoint(left.key, right.key));
    const owner = owners[0];
    if (owner !== undefined && owners.some(candidate => candidate.key !== owner.key && candidate.span.byteStart === owner.span.byteStart && candidate.span.byteEnd === owner.span.byteEnd)) {
      gap(expression, 'environment read has no unique canonical callable owner'); return;
    }
    const canonical = owner?.key ?? fileKey(expression.path);
    if (holder !== undefined && holder !== canonical) { gap(expression, 'environment effect disagrees with its canonical callable owner'); return; }
    databaseOf(databases, service).evidence.push({kind: 'connection-setting', span: expression.span, model: model.id, expression: expression.id, holder: canonical});
  };
  for (const expression of facts.expressions) {
    if (serviceOf(expression.path) === undefined || files.get(expression.path)?.language === 'go') continue;
    const selected = member(expression); if (selected === undefined) continue;
    const env = member(selected.receiver); if (env?.name !== 'env') continue;
    const process = env.receiver;
    if (process.syntaxKind !== 'identifier' || process.name !== 'process') continue;
    // A copied identity or any enclosing lexical reservation (including TDZ)
    // proves this is not the JS global. Never chase a local initializer.
    if (process.bindingId !== undefined || facts.bindings.some(binding => binding.path === process.path && binding.name === 'process' && binding.kind !== 'type' && contains(binding.scope, process.span))) continue;
    if (files.get(expression.path)?.parsed !== true) { gap(expression, 'environment source has no successful parse fact'); continue; }
    if (!isRead(expression)) continue;
    record(expression, selected.name);
  }
  // Go environment APIs already have validated library models and exact
  // imported-binding origins. Reuse their effects instead of spelling os.
  const library = evaluateLibraryModels(facts);
  for (const effect of library.effects) {
    if (effect.kind !== 'env-read' || files.get(effect.span.path)?.language !== 'go') continue;
    const expression = view.expressions.get(effect.expression); if (expression === undefined) continue;
    const selected = effect.arguments.find(argument => argument.name === 'name');
    record(expression, selected?.expression === undefined ? undefined : view.value(selected.expression), effect.holder);
  }
  // Facts and library diagnostics are already located. Retain them verbatim;
  // a parser failure or unresolved origin must not become a smaller success.
  for (const incoming of library.gaps) if (serviceOf(incoming.path) !== undefined && !gaps.some(held => held.path === incoming.path && held.reason === incoming.reason)) gaps.push(incoming);
}

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
      if (table === undefined) {
        gaps.push({path: statement.span.path, reason: `ALTER TABLE ${statement.table} names a table no migration of ${database.name} declares`});
        continue;
      }
      table.foreignKeys.push(statement.foreignKey);
      continue;
    }
    if (statement.kind === 'create-index') {
      const table = database.tables.get(statement.table);
      if (table === undefined) {
        gaps.push({path: statement.index.span.path, reason: `CREATE INDEX ${statement.index.name} names a table no migration of ${database.name} declares`});
        continue;
      }
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
      span: field.span,
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

interface ScriptWrite {
  readonly table: string;
  readonly schema?: string;
  readonly catalog?: string;
  readonly span: SourceSpan;
}

interface ScriptWrites {
  readonly writes: readonly ScriptWrite[];
  readonly recognized: boolean;
  readonly gap?: ExtractionGap;
}

/** PostgreSQL owns statement boundaries, identifiers and UTF-8 byte offsets. */
async function scanScriptWrites(path: string, text: string): Promise<ScriptWrites> {
  if (text.trim() === '') return {writes: [], recognized: false};
  const bytes = new ByteText(text);
  let parsed: ParseResult;
  try {
    parsed = await parsePostgres(text);
  } catch (error) {
    // libpg-query exposes a zero-based character cursor, unlike RawStmt's
    // UTF-8 byte locations. Never use PostgreSQL's internal C file/line here.
    const details = error instanceof Error && 'sqlDetails' in error ? error.sqlDetails : undefined;
    const cursor = typeof details === 'object' && details !== null && 'cursorPosition' in details
      && typeof details.cursorPosition === 'number' ? details.cursorPosition : 0;
    const prefix = Array.from(text).slice(0, Math.max(0, cursor)).join('');
    const line = bytes.lineOf(new TextEncoder().encode(prefix).length);
    const message = error instanceof Error ? error.message : String(error);
    return {writes: [], recognized: false, gap: {path, reason: `${path}:${line}: PostgreSQL parse failed: ${message}`}};
  }
  const writes: ScriptWrite[] = [];
  let nextByteStart = 0;
  for (const raw of parsed.stmts ?? []) {
    // RawStmt starts at the first SQL token, not its leading comments. Keep
    // those raw bytes, but calculate the end from the parser's own location.
    const byteStart = nextByteStart;
    // PostgreSQL omits zero fields. A zero length means the rest of the input,
    // including trailing comments; a positive length excludes the semicolon.
    const byteEnd = (raw.stmt_len ?? 0) > 0 ? (raw.stmt_location ?? 0) + raw.stmt_len! : bytes.byteLength;
    // Advance for every AST statement, even a SELECT that emits no write.
    nextByteStart = Math.min(byteEnd + 1, bytes.byteLength);
    const statement = raw.stmt;
    if (statement === undefined || !('InsertStmt' in statement)) continue;
    const target = statement.InsertStmt.relation;
    if (target?.relname === undefined) {
      return {writes: [], recognized: false, gap: {path, reason: `${path}:${bytes.lineOf(raw.stmt_location ?? 0)}: PostgreSQL INSERT has no target relation`}};
    }
    writes.push({
      table: target.relname,
      ...(target.schemaname === undefined ? {} : {schema: target.schemaname}),
      ...(target.catalogname === undefined ? {} : {catalog: target.catalogname}),
      span: {path, byteStart, byteEnd, lineStart: bytes.lineOf(byteStart), lineEnd: bytes.lineOf(byteEnd)},
    });
  }
  return {writes, recognized: (parsed.stmts ?? []).some((raw) => raw.stmt !== undefined)};
}

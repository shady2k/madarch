/**
 * The imports plugin (decision 0035, items 3, 8, 15 and 24; task madarch-o0eq.6): it reads the TypeScript and JavaScript
 * files the graph holds and states which file imports which — `code.imports` between two files of the repository — and
 * which package a file names — `code.imports-package` from the file to the package entity it creates. An edge repeats,
 * told apart by the line and column of the import, and carries the specifier as written, the form of the import and the
 * imported names.
 *
 * The files and their content are the graph's, which the host answers: the plugin reads no repository and walks no
 * folder (items 9 and 15). The parser is `@babel/parser` 7.29.13, the one the db-schema plugin already pins
 * (madarch-mwhd.3: no regular expression over source text, and it recovers from a file that is not valid as a whole), and
 * a specifier is resolved by the repository's own rules over the graph's file list and the tsconfig nearest the
 * importing file (`./resolve.js`), the package.json of a folder included. A relative specifier that names no file is
 * stated as an edge to the path it names, which no vertex holds: the graph records the unresolved reference with the
 * import's place, so the problem is reported, never dropped. A file the parser refuses, or whose content the graph does
 * not hold, is a problem with its place in the unit's answer; the other files are still read, and the host records the
 * problems beside the values.
 */
import { definePlugin, type EdgeResult, type ExtractContext, type Unit, type UnitResult, type VertexResult } from 'madarch-plugin-sdk';
import contract from './contract.json';
import { readRepository, type ImportProblem, type ImportRecord } from './read.js';
import { sourceExtensionOf } from './resolve.js';

/** The edge kinds the plugin states, and the kind of package entity it creates. */
const IMPORT_KIND = 'code.imports';
const PACKAGE_IMPORT_KIND = 'code.imports-package';
const PACKAGE_KIND = 'code.package';

/** The most file reads in flight: the host answers one request at a time, and a burst of them costs the fill nothing. */
const READ_CONCURRENCY = 8;

/** One file the plugin reads, by its graph key. */
interface WantedFile {
  readonly repository: string;
  readonly path: string;
  readonly kind: string;
  readonly key: import('madarch-plugin-sdk').KeyValues;
}

/** The place an import was read at, as the edge's discriminator: the same place is one reading, never two. */
function placeOf(record: { readonly line: number; readonly column: number }): string {
  return `${String(record.line)}:${String(record.column)}`;
}

/** The value an edge carries, in one shape for both edge kinds and for an unresolved import. */
function valuesOf(record: { readonly line: number; readonly column: number; readonly specifier: string; readonly form: string; readonly names?: readonly string[]; readonly typeOnly?: boolean }): Record<string, unknown> {
  return {
    place: placeOf(record),
    specifier: record.specifier,
    form: record.form,
    ...(record.names === undefined ? {} : { names: [...record.names] }),
    ...(record.typeOnly === true ? { type_only: true } : {}),
  };
}

/** The evidence one edge stands on: the file, its blob, and the lines the import stands on. */
function evidenceOf(repository: string, path: string, line: number, lineEnd: number, blob: string | undefined): { repository: string; path: string; lineStart: number; lineEnd: number; commitOrDigest?: string } {
  return { repository, path, lineStart: line, lineEnd, ...(blob === undefined ? {} : { commitOrDigest: blob }) };
}

/** One repository's answer, as the reader gives it, with the record's file and blob set. */
interface ReadRepositoryAnswer {
  readonly repository: string;
  readonly records: readonly (ImportRecord & { readonly repository: string })[];
  readonly packages: ReturnType<typeof readRepository>['packages'];
  readonly problems: readonly ImportProblem[];
}

/** The answer one unit states: the edges of every repository it read, and the package entities they name. */
async function extract(_unit: Unit, context: ExtractContext): Promise<UnitResult> {
  // Every path the graph holds is what a specifier resolves against, and every TypeScript or JavaScript source is read:
  // the plugin has no scope of its own yet, and a kind's `terms` is not where a producer's configuration belongs.
  const all = await context.graph.files('**/*');
  const paths = new Map<string, Set<string>>();
  const wanted = new Map<string, WantedFile>();
  for (const file of all) {
    const repository = String(file.key['repository'] ?? '');
    const path = String(file.key['path'] ?? '');
    const held = paths.get(repository) ?? new Set<string>();
    held.add(path);
    paths.set(repository, held);
    if (sourceExtensionOf(path) !== undefined) wanted.set(`${repository}\u0000${path}`, { repository, path, kind: file.kind, key: file.key });
  }
  // A tsconfig and a package.json are not sources the plugin parses, but their texts are what the repository's aliases
  // and a folder's entry are read from: every one the graph holds is read beside the sources, and the reader uses it
  // without parsing it as a file of imports.
  for (const repository of paths.keys()) {
    for (const path of paths.get(repository) ?? []) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!((name.startsWith('tsconfig') && name.endsWith('.json')) || name === 'package.json')) continue;
      wanted.set(`${repository}\u0000${path}`, { repository, path, kind: 'code.file', key: { repository, path } });
    }
  }
  const files = [...wanted.values()].sort((left, right) => (left.repository < right.repository ? -1 : left.repository > right.repository ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const texts = new Map<string, Map<string, string>>();
  const blobs = new Map<string, Map<string, string>>();
  const missing = new Set<string>();
  let next = 0;
  context.progress(0, files.length, 'reading the graph files');
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const index = next;
      next += 1;
      const file = files[index]!;
      const text = await context.graph.value<string | null>(file.kind, file.key, 'content');
      if (typeof text !== 'string') {
        missing.add(`${file.repository}\u0000${file.path}`);
      } else {
        const held = texts.get(file.repository) ?? new Map<string, string>();
        held.set(file.path, text);
        texts.set(file.repository, held);
      }
      const blob = await context.graph.value<string | null>(file.kind, file.key, 'blob');
      if (typeof blob === 'string') {
        const held = blobs.get(file.repository) ?? new Map<string, string>();
        held.set(file.path, blob);
        blobs.set(file.repository, held);
      }
      context.progress(index + 1, files.length, 'reading the graph files');
    }
  }));
  const answers: ReadRepositoryAnswer[] = [];
  for (const repository of [...paths.keys()].sort()) {
    const known = [...(paths.get(repository) ?? [])];
    // A wanted file whose content the graph does not hold is the reader's problem, with its place: it is left out of
    // the texts so the reader reports it rather than passing an empty file off as a file with no imports.
    const read = await readRepository({ repository, files: known, texts: texts.get(repository) ?? new Map(), blobs: blobs.get(repository) ?? new Map() });
    const unread = [...missing].filter((one) => one.startsWith(`${repository}\u0000`)).map((one) => one.slice(repository.length + 1));
    const problems = [...read.problems, ...unread.map((path): ImportProblem => ({ repository, path, line: 1, column: 1, lineEnd: 1, specifier: '', form: 'static', message: 'the file content is not in the graph' }))];
    answers.push({ repository, records: read.records.map((record) => ({ ...record, repository })), packages: read.packages, problems });
  }

  const edges: EdgeResult[] = [];
  // A package is keyed by its name and ecosystem alone, so the repositories' answers speak of one entity: the first
  // place in code point order is the one its evidence names.
  const packages = new Map<string, VertexResult>();
  for (const answer of answers) {
    for (const record of answer.records) {
      const blob = blobs.get(record.repository)?.get(record.from);
      const from = { kind: 'code.file', key: { repository: record.repository, path: record.from } };
      const edge = record.to.kind === 'file'
        ? { kind: IMPORT_KIND, from, to: { kind: 'code.file', key: { repository: record.repository, path: record.to.path } } }
        : { kind: PACKAGE_IMPORT_KIND, from, to: { kind: PACKAGE_KIND, key: { ecosystem: 'node', name: record.to.name } } };
      edges.push({ ...edge, discriminator: placeOf(record), values: valuesOf(record), evidence: evidenceOf(record.repository, record.from, record.line, record.lineEnd, blob) });
    }
    for (const held of answer.packages) {
      // The package's key is its name and ecosystem: a key field is the vertex's, never an opinion of one.
      const identity = `${held.key.ecosystem}\u0000${held.key.name}`;
      if (!packages.has(identity)) packages.set(identity, { kind: PACKAGE_KIND, key: held.key, evidence: held.evidence });
    }
  }
  const vertices = [...packages.values()];
  const problems = answers.flatMap((answer) => answer.problems);
  for (const problem of problems) {
    // A relative specifier that names no file is an edge to the file it names: the host resolves both ends, finds no
    // vertex for this one, and records an unresolved reference with the edge and the place — a problem, never a silence.
    if (problem.target === undefined || problem.target === '') continue;
    edges.push({
      kind: IMPORT_KIND,
      from: { kind: 'code.file', key: { repository: problem.repository, path: problem.path } },
      to: { kind: 'code.file', key: { repository: problem.repository, path: problem.target } },
      discriminator: placeOf(problem),
      values: valuesOf(problem),
      evidence: evidenceOf(problem.repository, problem.path, problem.line, problem.lineEnd, blobs.get(problem.repository)?.get(problem.path)),
    });
  }
  return {
    vertices,
    edges,
    // One file the parser refuses, or whose content the graph does not hold, is a problem with its place: the rest of
    // the repository is still answered, and the host records these beside the unit's values.
    problems: problems.map((problem) => ({
      repository: problem.repository,
      path: problem.path,
      line: problem.line,
      ...(problem.column > 0 ? { column: problem.column } : {}),
      message: problem.message,
    })),
    end: { state: 'complete' },
  };
}

await definePlugin({
  name: 'imports',
  version: '1.0.0',
  // The graph's file vertices and their content, and no repository: the files producer alone reads the source.
  graph: true,
  contract: contract.outputs as never,
  extract,
});

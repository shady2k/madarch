/**
 * What a syntax reading published about the specifiers a file wrote, and the
 * rule the plans that depend on that answer apply (madarch-tzte.21.9).
 *
 * **Which two facts.** The `import` edges stage 3 tied to files of the
 * repository, and the gaps of its coverage — a specifier it could not tie to a
 * file among them, which is no edge at all (madarch-tzte.21.3).
 *
 * **Why one module and one helper.** Two plans read these facts: stage 4's,
 * which resolves the names an import binds against the symbols of the file it
 * names (madarch-tzte.21.6), and stage 3's own, which writes the edge and the
 * gap. A specifier's answer is no property of either reading: a file that
 * appears under a specifier an unchanged file already wrote moves what that
 * specifier names (`./x` answers the `x.ts` beside it until an `x` appears), and
 * both stages have to read the file that wrote it again — stage 4 because its
 * resolution read symbols it did not read before, stage 3 because the gap or the
 * edge it published no longer answers what the specifier names at the pinned
 * commit. One helper is what keeps the two plans from drifting apart on a rule
 * neither of them can state alone; the row readers beside it are stage 3's own
 * shapes, so the graph answers the two stages the same rows.
 *
 * **The rules.** A plan reads a file again when
 *
 * - its published coverage names a specifier that ties to a file of the pinned
 *   commit now: a file appeared under a specifier the file already wrote;
 * - its published `import` edge does not answer its specifier at the pinned
 *   commit: a file appeared beside the old target (`./x.js` written beside the
 *   `x.ts` it resolved to) and the specifier answers the new file, or the file
 *   the edge named is gone from the tree and the specifier answers none of it.
 *
 * **What keeps the rules quiet.** A rule fires from what the graph holds, so the
 * stage whose own published facts are these two — stage 3 — needs no further
 * bound: its re-read replaces the stale gap with an edge, or the stale edge with
 * the one the specifier names now, and the next run of an unchanged commit finds
 * both agreeing with the tree. A stage that reads them for its own
 * incrementality passes `answered`, what its own last reading already resolved,
 * so a target it already read plans that file once and not on every later run of
 * an unchanged commit.
 */
import { isRepositoryPath } from '../facts.js';
import { fileIdIn, refuseRow, rowRecord, unknownKeys } from './draft.js';
import { fileFactIdOf, resolveSpecifier } from './syntax-facts.js';

/** The read the plan makes: the `import` edges the graph holds for one repository. */
export const PUBLISHED_IMPORTS_READ = 'stage-4-published-imports';

/** The read the plan makes: what stage 3 could not tie to a node, by the file it stood in. */
export const PUBLISHED_GAPS_READ = 'stage-3-coverage-gaps';

/**
 * The read the plan makes: the `import` edges stage 3 published for one
 * repository, which tell which files' reading took another file's meaning in.
 * The name is the one a wiring answers and a run records, and it does not move
 * with the code that reads it: two plans read this answer.
 */
export function publishedImportsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_IMPORTS_READ, repository });
}

/**
 * The read the plan makes: what stage 3 published as a gap for one repository —
 * a specifier it could not tie to a file among them. A file's reading can move
 * without the file's own bytes moving: a specifier that named nothing when stage
 * 3 read the file names a file once one appears.
 */
export function publishedGapsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_GAPS_READ, repository });
}

/** One row of the plan's read: an `import` edge between two files of the repository, by fact id. */
export interface PublishedImportRow {
  readonly kind: 'import';
  readonly from: string;
  readonly to: string;
  /** The specifier the importer wrote (`./order.js`), which tells whether it names the same file at the pinned commit. */
  readonly specifier: string;
}

/** One row of the plan's gap read: one thing stage 3 could not tie to a node, in the file it stood in. */
export interface PublishedGapRow {
  readonly kind: 'coverage';
  /** The file the gap stands in. */
  readonly file: string;
  /** What could not be read: a specifier, a path, or a question the reader could not answer. */
  readonly what: string;
}

/** The keys a row of the plan's read holds, and no others. */
const IMPORT_ROW_FIELDS: readonly string[] = ['from', 'kind', 'specifier', 'to'];

/** The keys a gap row holds, and no others. */
const GAP_ROW_FIELDS: readonly string[] = ['file', 'kind', 'what'];

/**
 * The plan's read, read: each row is an `import` edge of this repository, an
 * object naming the kind and the two file facts it joins. A row that names
 * another kind, an id that is no fact id of a `file`, or a key this read does
 * not define is refused, naming the read, the row and the field — a row read
 * past would plan a wrong unit in silence, and a row dropped would leave a
 * stale resolution behind.
 */
export function publishedImportRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedImportRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'an import edge of the repository');
    unknownKeys(held, IMPORT_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'import') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "import" edges`);
    const specifier = held['specifier'];
    if (typeof specifier !== 'string' || specifier.trim() === '') {
      throw refuseRow(read, index, repository, `its specifier ${JSON.stringify(specifier)} is no specifier: an import edge names the text the importing file wrote`);
    }
    return {
      kind: 'import',
      from: fileIdIn(held['from'], read, index, repository, 'from'),
      to: fileIdIn(held['to'], read, index, repository, 'to'),
      specifier,
    };
  });
}

/**
 * The plan's gap read, read: each row is one gap of stage 3's coverage of a file
 * — a specifier it could not tie to a file, a language it could not read, a
 * question it could not answer. A row naming another kind, a file that is no
 * repository path, or a key this read does not define is refused, naming the
 * read, the row and the field: a row read past would leave a file's resolution
 * stale in silence.
 */
export function publishedGapRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedGapRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'a gap of a file\'s coverage');
    unknownKeys(held, GAP_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" gaps`);
    const file = held['file'];
    if (typeof file !== 'string' || !isRepositoryPath(file)) {
      throw refuseRow(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a gap stands in a file of the repository`);
    }
    const what = held['what'];
    if (typeof what !== 'string' || what.trim() === '') {
      throw refuseRow(read, index, repository, `its what ${JSON.stringify(what)} is no gap: a gap names what the reader could not read`);
    }
    return { kind: 'coverage', file, what };
  });
}

/** One plan's request of the rule: the two published facts, the pinned tree, and what the caller already answered. */
export interface SpecifierMovesRequest {
  /** The product's own name for the repository: a file fact's id is the digest of the repository and the path. */
  readonly repository: string;
  /** Every path the pinned commit holds, which is what a specifier is tied against (stage 3's own resolution). */
  readonly paths: ReadonlySet<string>;
  /** Every path the graph holds a `file` fact for, so an edge's two ends are read back as the files they join. */
  readonly published: Iterable<string>;
  /**
   * The `import` edges one repository's files wrote, as `publishedImportRows`
   * read them — an edge whose target the graph holds no `file` fact for among
   * them, since the read filters by the edge's importer (`stage-reads.ts`).
   */
  readonly imports: readonly PublishedImportRow[];
  /** What stage 3 published as a gap of a file's coverage, as `publishedGapRows` read them. */
  readonly gaps: readonly PublishedGapRow[];
  /**
   * Whether the caller's own last reading already answers a file's specifier with
   * this target. A caller whose own published facts are the two above passes
   * none: its re-read is what makes the rule quiet again, so a target it named
   * once cannot plan the file a second time. A caller that reads them for its own
   * incrementality — stage 4 — passes what its own coverage says it read.
   */
  readonly answered?: (file: string, target: string) => boolean;
}

/**
 * The files of one repository whose reading a moved specifier plans again, by
 * the two rules above: the file that wrote a gap the pinned tree answers now, and
 * the file whose published edge does not answer its specifier at the pinned
 * commit. A path the commit no longer holds is not a move of this rule — the
 * retraction of a vanished path is the plan's own — and a gap that names no file
 * now is no move either. The same file is answered once, whichever rule names it.
 */
export function movedBySpecifiers(request: SpecifierMovesRequest): ReadonlySet<string> {
  const moves = new Set<string>();
  const pathOf = new Map<string, string>();
  for (const path of request.published) pathOf.set(fileFactIdOf(request.repository, path), path);
  const answered = request.answered ?? (() => false);
  for (const edge of request.imports) {
    const importer = pathOf.get(edge.from);
    // An edge whose importer the tree no longer holds is no edge of a live file:
    // the plan retracts that file's facts itself.
    if (importer === undefined || !request.paths.has(importer)) continue;
    const now = resolveSpecifier(importer, edge.specifier, request.paths);
    // The edge answers the specifier: it names the file the specifier names at
    // the pinned commit. Anything else is a move — another file answers the
    // specifier now, or no file of the repository answers it at all, and the edge
    // names a file the pinned tree no longer holds.
    if (now !== undefined && now === pathOf.get(edge.to)) continue;
    if (now !== undefined && answered(importer, now)) continue;
    moves.add(importer);
  }
  for (const gap of request.gaps) {
    if (!request.paths.has(gap.file)) continue;
    // Only a gap that is a specifier tying to a file now is a move: a gap naming
    // a language this reader has no grammar for, or a declaration it could not
    // name, names no file however the tree changes.
    const now = resolveSpecifier(gap.file, gap.what, request.paths);
    if (now === undefined) continue;
    if (answered(gap.file, now)) continue;
    moves.add(gap.file);
  }
  return moves;
}

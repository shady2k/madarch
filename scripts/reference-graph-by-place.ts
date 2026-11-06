/**
 * The fair match of a filled graph against the reference graph: a record is
 * found by where it stands, not by how it is spelled.
 *
 * A node matches when the kind is equal, the file is equal, and the record's
 * place overlaps one of the entry's evidence lines. Where several records of a
 * kind overlap one entry, the one whose own name equals the name the entry
 * states wins; where that does not single one out, the entry is matched once —
 * to the nearest place, then the lowest key — and the match is counted as
 * ambiguous for its kind, with the remaining records left unmatched. An entry
 * is matched at most once and a record at most once.
 *
 * A record that states no place is never matched by a fallback: it is counted
 * per kind as `no place`. The one exception is a fact that has no file at all —
 * a commit, a task, an author, a repository — which is matched by the identity
 * it states (and the entry names in its id); `IDENTITY_KINDS` lists them and
 * why.
 *
 * An edge matches when the relation is equal and both of its ends are records
 * matched to the entries the edge names. Nothing here reads a repository's
 * content: places come from the reference's evidence and the graph's own span.
 */

/** One evidence item of a reference entry: the lines of a file, or a git command. */
export interface EvidenceItem {
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly command?: string;
}

/** A reference entry, as much of it as the match needs. */
export interface ReferenceEntry {
  readonly id: string;
  readonly kind: string;
  readonly evidence: readonly EvidenceItem[];
  /** `scored: false` keeps the entry (and every edge touching it) out of every count. */
  readonly scored?: boolean;
}

/** A line range of a file. */
export interface Place {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A graph record, as much of it as the match needs. */
export interface NodeRecord {
  readonly key: string;
  readonly kind: string;
  /** The name the record states for itself, where it states one. */
  readonly name?: string;
  /** Where the record stands; absent when it states no place. */
  readonly place?: Place;
  /** The identity the record states, for a kind of `IDENTITY_KINDS`. */
  readonly identity?: string;
}

/**
 * The kinds whose facts have no file, so no place can find them, with the
 * property that carries the identity the entry names in its id, and why.
 */
export const IDENTITY_KINDS: Readonly<Record<string, { readonly property: string; readonly why: string }>> = {
  'code.commit': { property: 'commit', why: 'a commit is named by its hash; its evidence is the git command that prints it, not a line of a file' },
  'code.task': { property: 'key', why: 'a task is named by its tracker key, which a commit message states: no file holds it' },
  'code.author': { property: 'email', why: 'an author is named by an email address, which git records: no file holds it' },
  'code.repository': { property: 'repository', why: 'the repository is the whole, not a place in it; the record states its own name' },
};

/** The identity an entry names: the part of its id after the kind. */
export function identityOfEntry(entry: ReferenceEntry): string {
  const colon = entry.id.indexOf(':');
  return colon < 0 ? entry.id : entry.id.slice(colon + 1);
}

/** The place an entry's evidence states, one per file it cites. */
export function placesOf(entry: ReferenceEntry): Place[] {
  const out: Place[] = [];
  for (const item of entry.evidence) {
    if (typeof item.path !== 'string') continue;
    const start = typeof item.startLine === 'number' ? item.startLine : 1;
    const end = typeof item.endLine === 'number' ? item.endLine : start;
    out.push({ path: item.path, startLine: Math.min(start, end), endLine: Math.max(start, end) });
  }
  return out;
}

/**
 * The place a record states, from its own fields: its `span`, the place of its
 * provenance, a `file` with a `line` (or a `lineStart` and `lineEnd`), or — a
 * file record, which is the whole file — its `path` from line 1 to its end.
 * A record that states none of these states no place.
 */
export function placeOfProperties(kind: string, properties: Readonly<Record<string, unknown>>): Place | undefined {
  const fromSpan = placeOfValue(properties['span']);
  if (fromSpan !== undefined) return fromSpan;
  const provenance = properties['provenance'];
  if (provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance)) {
    const fromProvenance = placeOfValue((provenance as Record<string, unknown>)['place']);
    if (fromProvenance !== undefined) return fromProvenance;
  }
  const file = properties['file'];
  if (typeof file === 'string') {
    const line = properties['line'];
    if (typeof line === 'number' && Number.isInteger(line) && line >= 1) return { path: file, startLine: line, endLine: line };
    const start = properties['lineStart'];
    const end = properties['lineEnd'] ?? start;
    if (typeof start === 'number' && typeof end === 'number') return { path: file, startLine: Math.min(start, end), endLine: Math.max(start, end) };
  }
  const path = properties['path'];
  if (kind === 'code.file' && typeof path === 'string') return { path, startLine: 1, endLine: Number.MAX_SAFE_INTEGER };
  return undefined;
}

/** A `{ path, lineStart, lineEnd }` or `{ file, range }` value, whichever shape a record states. */
function placeOfValue(value: unknown): Place | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const held = value as Record<string, unknown>;
  const range = held['range'];
  if (range !== null && typeof range === 'object' && !Array.isArray(range)) {
    const inside = range as Record<string, unknown>;
    const file = held['file'];
    const start = inside['startLine'];
    const end = inside['endLine'] ?? start;
    if (typeof file === 'string' && typeof start === 'number' && typeof end === 'number') {
      return { path: file, startLine: Math.min(start, end), endLine: Math.max(start, end) };
    }
    return undefined;
  }
  const path = held['path'];
  const start = held['lineStart'] ?? held['startLine'];
  const end = held['lineEnd'] ?? held['endLine'] ?? start;
  if (typeof path === 'string' && typeof start === 'number' && typeof end === 'number') {
    return { path, startLine: Math.min(start, end), endLine: Math.max(start, end) };
  }
  return undefined;
}

/** The name an entry states: the part of its id after its last `#`, or after its kind. */
export function statedName(entry: ReferenceEntry): string {
  const body = identityOfEntry(entry);
  const hash = body.lastIndexOf('#');
  return hash < 0 ? body : body.slice(hash + 1);
}

export interface Ambiguity {
  readonly kind: string;
  readonly entries: number;
  readonly records: number;
}

export interface NodeMatch {
  /** Reference id → the record's key. */
  readonly entryToRecord: ReadonlyMap<string, string>;
  /** The record's key → the reference's id. */
  readonly recordToEntry: ReadonlyMap<string, string>;
  /** Per kind, the entries several records overlapped and no name singled one out. */
  readonly ambiguous: ReadonlyMap<string, Ambiguity>;
  /** Per kind, the records that state no place and were not matched by identity. */
  readonly noPlace: ReadonlyMap<string, number>;
  /** Per kind, the entries matched by their stated identity. */
  readonly identity: ReadonlyMap<string, number>;
  readonly unmatchedEntries: readonly string[];
  readonly unmatchedRecords: readonly string[];
  /** The entries `scored: false` took out of every count. */
  readonly unscored: readonly ReferenceEntry[];
}

function overlaps(place: Place, evidence: Place): boolean {
  return place.path === evidence.path && place.startLine <= evidence.endLine && evidence.startLine <= place.endLine;
}

/** The entries grouped by kind, in id order, scored only. */
function entriesByKind(entries: readonly ReferenceEntry[]): Map<string, ReferenceEntry[]> {
  const out = new Map<string, ReferenceEntry[]>();
  for (const entry of [...entries].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
    if (entry.scored === false) continue;
    out.set(entry.kind, [...(out.get(entry.kind) ?? []), entry]);
  }
  return out;
}

/** The records grouped by kind, in key order. */
function recordsByKind(records: readonly NodeRecord[]): Map<string, NodeRecord[]> {
  const out = new Map<string, NodeRecord[]>();
  for (const record of [...records].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
    out.set(record.kind, [...(out.get(record.kind) ?? []), record]);
  }
  return out;
}

/**
 * Matches the reference's entries to a graph's records by place, and by the
 * identity a fact without a file states.
 */
export function matchNodes(entries: readonly ReferenceEntry[], records: readonly NodeRecord[]): NodeMatch {
  const entryToRecord = new Map<string, string>();
  const recordToEntry = new Map<string, string>();
  const usedRecords = new Set<string>();
  const ambiguous = new Map<string, { entries: number; records: number }>();
  const identity = new Map<string, number>();
  const byKind = entriesByKind(entries);
  const recordsOf = recordsByKind(records);

  const mark = (kind: string, count: number): void => {
    const held = ambiguous.get(kind) ?? { entries: 0, records: 0 };
    ambiguous.set(kind, { entries: held.entries + 1, records: held.records + count });
  };

  for (const [kind, kindEntries] of byKind) {
    const kindRecords = recordsOf.get(kind) ?? [];
    const identityKind = IDENTITY_KINDS[kind];
    if (identityKind !== undefined) {
      for (const entry of kindEntries) {
        const wanted = identityOfEntry(entry);
        const found = kindRecords.filter((record) => !usedRecords.has(record.key) && record.identity === wanted);
        if (found.length === 0) continue;
        const chosen = found[0]!;
        entryToRecord.set(entry.id, chosen.key);
        recordToEntry.set(chosen.key, entry.id);
        usedRecords.add(chosen.key);
        identity.set(kind, (identity.get(kind) ?? 0) + 1);
        if (found.length > 1) mark(kind, found.length - 1);
      }
    }
    for (const entry of kindEntries) {
      if (entryToRecord.has(entry.id)) continue;
      const places = placesOf(entry);
      if (places.length === 0) continue;
      const candidates = kindRecords.filter((record) => {
        if (usedRecords.has(record.key) || record.place === undefined) return false;
        return places.some((evidence) => overlaps(record.place!, evidence));
      });
      if (candidates.length === 0) continue;
      let chosen = candidates.length === 1 ? candidates[0]! : undefined;
      if (chosen === undefined) {
        const named = candidates.filter((record) => record.name !== undefined && record.name === statedName(entry));
        if (named.length === 1) chosen = named[0]!;
        else {
          const nearest = [...candidates].sort((left, right) => (left.place!.startLine - right.place!.startLine) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
          chosen = nearest[0]!;
          mark(kind, candidates.length - 1);
        }
      }
      entryToRecord.set(entry.id, chosen.key);
      recordToEntry.set(chosen.key, entry.id);
      usedRecords.add(chosen.key);
    }
  }

  const noPlace = new Map<string, number>();
  for (const [kind, kindRecords] of recordsOf) {
    if (byKind.get(kind) === undefined) continue;
    for (const record of kindRecords) {
      if (usedRecords.has(record.key) || record.place !== undefined) continue;
      if (IDENTITY_KINDS[kind] !== undefined && record.identity !== undefined) continue;
      noPlace.set(kind, (noPlace.get(kind) ?? 0) + 1);
    }
  }

  const unmatchedEntries = [...byKind.values()].flat().filter((entry) => !entryToRecord.has(entry.id)).map((entry) => entry.id);
  const unmatchedRecords = [...recordsOf.values()].flat().filter((record) => !usedRecords.has(record.key) && byKind.get(record.kind) !== undefined).map((record) => record.key);
  return {
    entryToRecord,
    recordToEntry,
    ambiguous: new Map([...ambiguous.entries()].map(([kind, held]) => [kind, { kind, ...held }])),
    noPlace,
    identity,
    unmatchedEntries,
    unmatchedRecords,
    unscored: entries.filter((entry) => entry.scored === false),
  };
}

/** One edge of a graph, as much as the match needs. */
export interface GraphEdge {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
}

/** A reference edge, as much as the match needs. */
export interface ReferenceEdge {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
  readonly scored?: boolean;
  /** `direct` (or absent) is scored; any other value is reported apart. */
  readonly scope?: string;
}

export interface EdgeMatch {
  /** Reference edges the graph states, as `relation\u0000from\u0000to`. */
  readonly matched: ReadonlySet<string>;
  /** Graph edges that stand for no reference edge, by the same key. */
  readonly extra: ReadonlySet<string>;
  /** Reference edges no graph edge states. */
  readonly missing: ReadonlySet<string>;
  /** The edges a scope other than `direct` keeps out of the direct counts, by scope. */
  readonly scopedApart: ReadonlyMap<string, number>;
  /** The edges `scored: false` entries take out of every count. */
  readonly unscored: number;
}

export function edgeKey(relation: string, from: string, to: string): string {
  return `${relation}\u0000${from}\u0000${to}`;
}

/** Matches the reference's edges through the records the nodes matched. */
export function matchEdges(
  reference: readonly ReferenceEdge[],
  graph: readonly GraphEdge[],
  recordToEntry: ReadonlyMap<string, string>,
): EdgeMatch {
  const wanted = new Set<string>();
  const scopedApart = new Map<string, number>();
  let unscored = 0;
  for (const edge of reference) {
    if (edge.scored === false) { unscored += 1; continue; }
    if (edge.scope !== undefined && edge.scope !== 'direct') {
      scopedApart.set(edge.scope, (scopedApart.get(edge.scope) ?? 0) + 1);
      continue;
    }
    wanted.add(edgeKey(edge.relation, edge.from, edge.to));
  }
  const seen = new Set<string>();
  const extra = new Set<string>();
  for (const edge of graph) {
    const from = recordToEntry.get(edge.from);
    const to = recordToEntry.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const key = edgeKey(edge.relation, from, to);
    if (wanted.has(key)) seen.add(key);
    else extra.add(key);
  }
  const missing = new Set([...wanted].filter((key) => !seen.has(key)));
  return { matched: seen, extra, missing, scopedApart, unscored };
}

/** One name's entry in a reference's `SCORING.md`. */
export interface Scoring {
  /** Whether the reference asks to be recalled on this name; `false` prints `n/a`. */
  readonly recall?: boolean;
  /** Whether the name is scored at all; `false` keeps both sides out of every count. */
  readonly scored?: boolean;
  readonly why?: string;
}

/**
 * Reads a reference's `SCORING.md`: a table with a `name` column and, optionally,
 * `recall`, `scored` and `why` columns, each row naming a kind or a relation.
 * A name the file does not mention is scored and recalled as usual.
 */
export function readScoring(text: string): Map<string, Scoring> {
  const out = new Map<string, Scoring>();
  const lines = text.split('\n');
  const header = lines.find((line) => line.trim().startsWith('|') && /\bname\b/u.test(line));
  if (header === undefined) return out;
  const columns = header.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
  const at = (name: string): number => columns.indexOf(name);
  for (const line of lines) {
    if (line === header || !line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
    if (cells.length < columns.length) continue;
    const bare = (cells[at('name')] ?? '').replace(/^`|`$/gu, '');
    // The separator row is dashes; a name holds a letter, a digit, and no space.
    if (!/^[\w.-]*[A-Za-z0-9][\w.-]*$/u.test(bare)) continue;
    const recallCell = at('recall') < 0 ? undefined : cells[at('recall')];
    const scoredCell = at('scored') < 0 ? undefined : cells[at('scored')];
    const whyCell = at('why') < 0 ? undefined : cells[at('why')];
    out.set(bare, {
      ...(recallCell === 'yes' ? { recall: true } : recallCell === 'no' ? { recall: false } : {}),
      ...(scoredCell === 'yes' ? { scored: true } : scoredCell === 'no' ? { scored: false } : {}),
      ...(whyCell === undefined || whyCell === '' ? {} : { why: whyCell }),
    });
  }
  return out;
}

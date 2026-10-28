/**
 * The writer's unit graph (decision 0032, section 1; madarch-ztyq.4): the kinds of unit the
 * writer runs, what each of them reads and writes, and the order they run in — derived from
 * those declarations, never written out as a list.
 *
 * A unit kind declares the artifacts it reads and the artifacts it writes. The order is the
 * topological order of that graph, ties broken in code point order of the kind's name, so the
 * same declarations always give the same order and a declaration decides where a kind stands.
 * Three things are refused here, each naming the declaration it was read from:
 *
 * - an artifact two kinds write: one artifact has one producer, or a reader cannot say which
 *   unit's output it reads;
 * - a read nobody writes: a unit would wait for a producer that does not exist;
 * - a cycle: two kinds that read each other's output have no order at all.
 *
 * What each kind's *content* is comes from the kind's own module (`run.ts`, `prompts.ts`), and
 * where a later task defines that content (madarch-ztyq.5 to .9, madarch-mwhd.1) the unit writes
 * the minimal page now: the `contentOwner` of a kind names the task that replaces it.
 */
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';

/** The module every declaration here names when it refuses a declaration. */
const DECLARATIONS = 'src/writer/graph.ts';

/** One artifact of the writer: a body of content one unit kind produces and later kinds may read. */
export type WriterArtifact =
  | 'document-readings'
  | 'validation-verdicts'
  | 'product-page'
  | 'domain-declarations'
  | 'rule-enrichments'
  | 'decision-enrichments'
  | 'scenario-enrichments'
  | 'domain-pages'
  | 'guides'
  | 'overview-page'
  | 'editorial-findings';

/** Every artifact, in code point order: what a graph problem may name. */
export const WRITER_ARTIFACTS: readonly WriterArtifact[] = [
  'decision-enrichments', 'document-readings', 'domain-declarations', 'domain-pages', 'editorial-findings',
  'guides', 'overview-page', 'product-page', 'rule-enrichments', 'scenario-enrichments', 'validation-verdicts',
];

/** The kinds of unit the writer runs, in code point order of their names. */
export type WriterUnitKindName =
  | 'document-interpretation'
  | 'domains'
  | 'editorial'
  | 'graph-validation'
  | 'guides'
  | 'overview'
  | 'product'
  | 'rules-and-decisions'
  | 'scenarios';

/** One artifact a kind reads, and whether its absence stops the kind. */
export interface WriterUnitRead {
  readonly artifact: WriterArtifact;
  /**
   * True when the kind cannot run without it: the unit is then reported as blocked, naming the
   * artifact and the kind that owes it, and never run on a smaller input. False when the kind
   * runs without it and says so in the run's report.
   */
  readonly required: boolean;
}

/** One kind of writer unit, as the graph reads it. */
export interface WriterUnitKind {
  /** The kind's name, which is also the id prefix of its units and its stage id in the fill's registry. */
  readonly kind: WriterUnitKindName;
  /** The kind's own version, bumped when what its units read, write or are told changes. */
  readonly version: number;
  readonly reads: readonly WriterUnitRead[];
  readonly writes: readonly WriterArtifact[];
  /**
   * The task that defines this kind's page content, where the page is minimal now (decision 0032,
   * section 1, "units whose page content later tasks define"). A kind with an owner still runs
   * and still writes its page: what the owner replaces is the content, not the unit.
   */
  readonly contentOwner?: string;
}

/**
 * The writer's kinds (decision 0032, section 1, the unit table), each with the artifacts it reads
 * and writes. The order below is not the order they run in: `writerUnitOrder()` derives that, and
 * these declarations are its only input.
 */
export const WRITER_UNIT_KINDS: readonly WriterUnitKind[] = [
  {
    // Documents read by meaning (0032, section 4; madarch-ztyq.3 read them, this unit enriches the
    // passages whose reading is still open) — the reading is stored apart from the document.
    kind: 'document-interpretation',
    version: 1,
    reads: [],
    writes: ['document-readings'],
  },
  {
    // Every node and edge carries a disposition (0032, section 3): most from deterministic rules,
    // and only flagged items go further. The rules themselves are madarch-mwhd.1's.
    kind: 'graph-validation',
    version: 1,
    reads: [],
    writes: ['validation-verdicts'],
    contentOwner: 'madarch-mwhd.1',
  },
  {
    // The product page, which also declares the product's domains; a later task rewrites its
    // structure (madarch-ztyq.6, ztyq.7), the declaration stays here.
    kind: 'product',
    version: 1,
    reads: [{ artifact: 'document-readings', required: false }],
    writes: ['product-page', 'domain-declarations'],
  },
  {
    // Rules and decisions (0032, section 1): each keeps its own structure and its implementation
    // links, stored apart from the person's ADR or rule section.
    kind: 'rules-and-decisions',
    version: 1,
    reads: [{ artifact: 'document-readings', required: false }],
    writes: ['rule-enrichments', 'decision-enrichments'],
    contentOwner: 'madarch-ztyq.5',
  },
  {
    // Scenarios consume the enriched rules and decisions instead of rediscovering them.
    kind: 'scenarios',
    version: 1,
    reads: [
      { artifact: 'rule-enrichments', required: false },
      { artifact: 'decision-enrichments', required: false },
    ],
    writes: ['scenario-enrichments'],
    contentOwner: 'madarch-ztyq.5',
  },
  {
    // Domains summarise the enriched scenarios and the product's own page; the product page is
    // required, because a domain page without the product's declaration is a page of nothing.
    kind: 'domains',
    version: 1,
    reads: [
      { artifact: 'product-page', required: true },
      { artifact: 'scenario-enrichments', required: false },
      { artifact: 'rule-enrichments', required: false },
      { artifact: 'decision-enrichments', required: false },
    ],
    writes: ['domain-pages'],
    contentOwner: 'madarch-ztyq.6',
  },
  {
    // The administrator guide and the user guide (0032, section 7).
    kind: 'guides',
    version: 1,
    reads: [{ artifact: 'domain-pages', required: false }],
    writes: ['guides'],
  },
  {
    // The home page, written last of the pages a reader opens first (0032, section 11).
    kind: 'overview',
    version: 1,
    reads: [
      { artifact: 'product-page', required: false },
      { artifact: 'domain-pages', required: false },
      { artifact: 'validation-verdicts', required: false },
    ],
    writes: ['overview-page'],
    contentOwner: 'madarch-ztyq.7',
  },
  {
    // The editorial pass reads what the run wrote and sends bounded revision requests (section 6).
    kind: 'editorial',
    version: 1,
    reads: [
      { artifact: 'product-page', required: false },
      { artifact: 'domain-pages', required: false },
      { artifact: 'guides', required: false },
      { artifact: 'overview-page', required: false },
    ],
    writes: ['editorial-findings'],
    contentOwner: 'madarch-ztyq.9',
  },
];

/** The kind a name is, or undefined when no kind carries it. */
export function writerUnitKind(name: string): WriterUnitKind | undefined {
  return WRITER_UNIT_KINDS.find((kind) => kind.kind === name);
}

/** Where a declaration stands, for an error that names it: the module, the entry, the field. */
function site(index: number, field: string, detail?: string): string {
  return `${DECLARATIONS}: kinds[${index}].${field}${detail === undefined ? '' : ` (${detail})`}`;
}

/** The unit id of one unit of a kind: `<kind>:<scope>`, the same id across runs (decision 0026). */
export function writerUnitId(kind: WriterUnitKindName, scope: string): string {
  return `${kind}:${scope}`;
}

/** The stage id a kind's units are recorded under in the fill's own unit tables (`writer.<kind>`). */
export function writerStageId(kind: WriterUnitKindName): string {
  return `writer.${kind}`;
}

/**
 * What a kind can say about itself: its id, its version and what it reads and writes, as the
 * stage registry of decision 0027 declares a stage. The writer's kinds are not stages of the
 * fill's fact graph (they publish Markdown, not facts), so this is the declaration the run uses
 * and the shape the registry would need if they became stages.
 */
export function writerKindDeclaration(kind: WriterUnitKind): { readonly id: string; readonly version: number; readonly consumes: readonly string[]; readonly produces: readonly string[] } {
  return {
    id: writerStageId(kind.kind),
    version: kind.version,
    consumes: [...new Set(kind.reads.map((read) => read.artifact))].sort(byCodePoint),
    produces: [...new Set(kind.writes)].sort(byCodePoint),
  };
}

/** The problems a set of declarations has: a duplicate producer, a read nobody writes, a cycle. */
export function writerGraphProblems(kinds: readonly WriterUnitKind[] = WRITER_UNIT_KINDS): readonly string[] {
  const problems: string[] = [];
  const producers = new Map<WriterArtifact, { kind: WriterUnitKindName; index: number; write: number }[]>();
  const seenKinds = new Map<string, number>();
  for (const [index, kind] of kinds.entries()) {
    if (kind.kind.trim() === '' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(kind.kind)) {
      problems.push(`${site(index, 'kind')}: ${JSON.stringify(kind.kind)} is not a unit kind: a kind is lower-case words joined by hyphens`);
    }
    const first = seenKinds.get(kind.kind);
    if (first !== undefined) problems.push(`${site(index, 'kind')}: the kind ${JSON.stringify(kind.kind)} is declared twice (the first declaration is kinds[${first}])`);
    else seenKinds.set(kind.kind, index);
    if (!Number.isInteger(kind.version) || kind.version < 1) problems.push(`${site(index, 'version')}: ${String(kind.version)} is not a whole version of 1 or more`);
    if (kind.writes.length === 0) problems.push(`${site(index, 'writes')}: a kind writes at least one artifact, or nothing waits for it`);
    const written = new Set<WriterArtifact>();
    for (const [write, artifact] of kind.writes.entries()) {
      if (!WRITER_ARTIFACTS.includes(artifact)) problems.push(`${site(index, 'writes', `[${write}]`)}: ${JSON.stringify(artifact)} is not a writer artifact: the artifacts are ${WRITER_ARTIFACTS.join(', ')}`);
      if (written.has(artifact)) problems.push(`${site(index, 'writes', `[${write}]`)}: the kind ${JSON.stringify(kind.kind)} writes ${JSON.stringify(artifact)} twice`);
      written.add(artifact);
      const held = producers.get(artifact) ?? [];
      held.push({ kind: kind.kind, index, write });
      producers.set(artifact, held);
    }
    for (const read of kind.reads) if (written.has(read.artifact)) {
      problems.push(`${site(index, 'reads')}: the kind ${JSON.stringify(kind.kind)} reads ${JSON.stringify(read.artifact)}, which it writes itself: no order exists for a kind that waits for itself`);
    }
  }
  for (const [artifact, held] of [...producers].sort(([left], [right]) => byCodePoint(left, right))) {
    if (held.length < 2) continue;
    problems.push(`${site(held[0]!.index, 'writes')}: ${JSON.stringify(artifact)} is written by ${held.map((one) => `${JSON.stringify(one.kind)} (kinds[${one.index}])`).join(' and ')}: one artifact has one producer, or a reader cannot say whose output it reads`);
  }
  for (const [index, kind] of kinds.entries()) {
    for (const read of kind.reads) {
      if (!producers.has(read.artifact)) problems.push(`${site(index, 'reads')}: the kind ${JSON.stringify(kind.kind)} reads ${JSON.stringify(read.artifact)}, which no kind writes: its producer does not exist`);
    }
  }
  return problems.sort(byCodePoint);
}

/** The order the declared kinds run in: their topological order, ties in code point order. */
export interface WriterUnitOrder {
  /** The kinds, in the order their units run. */
  readonly order: readonly WriterUnitKindName[];
  /** What the declarations refuse; empty when the graph stands. */
  readonly problems: readonly string[];
}

/**
 * Derives the run order from reads and writes alone (decision 0032, section 1: "the order derived
 * from declared reads/writes rather than a hardcoded list"). A kind is ready when every artifact it
 * reads is written by a kind already ordered; among the ready kinds the smallest name in code point
 * order goes next, so the same declarations always give the same order. Kinds that never become
 * ready are a cycle, named in code point order.
 */
export function writerUnitOrder(kinds: readonly WriterUnitKind[] = WRITER_UNIT_KINDS): WriterUnitOrder {
  const problems = writerGraphProblems(kinds);
  if (problems.length > 0) return { order: [], problems };
  const producers = new Map<WriterArtifact, WriterUnitKindName>();
  for (const kind of kinds) for (const artifact of kind.writes) producers.set(artifact, kind.kind);
  const done = new Set<WriterUnitKindName>();
  const order: WriterUnitKindName[] = [];
  let remaining = [...kinds].sort((left, right) => byCodePoint(left.kind, right.kind));
  for (;;) {
    const ready = remaining.filter((kind) => kind.reads.every((read) => done.has(producers.get(read.artifact)!)));
    if (ready.length === 0) break;
    const next = ready[0]!;
    order.push(next.kind);
    done.add(next.kind);
    remaining = remaining.filter((kind) => kind.kind !== next.kind);
  }
  if (remaining.length > 0) {
    // Every remaining kind waits for one of the remaining kinds, so the wait is a cycle: name it as the
    // kinds that never became ready, in code point order, with what each still waits for.
    const waiting = remaining.map((kind) => `${JSON.stringify(kind.kind)} waits for ${kind.reads.filter((read) => !done.has(producers.get(read.artifact)!)).map((read) => JSON.stringify(read.artifact)).sort(byCodePoint).join(', ') || 'nothing'}`);
    return { order: [], problems: [`${DECLARATIONS}: the kinds ${remaining.map((kind) => JSON.stringify(kind.kind)).sort(byCodePoint).join(', ')} have no order: ${waiting.join('; ')}`] };
  }
  return { order, problems: [] };
}

/** The run order, or the refusal naming every declaration that stops it. */
export function writerRunOrder(kinds: readonly WriterUnitKind[] = WRITER_UNIT_KINDS): readonly WriterUnitKindName[] {
  const derived = writerUnitOrder(kinds);
  if (derived.problems.length > 0) throw new Error(derived.problems.join('\n'));
  return derived.order;
}

/**
 * The inputs digest of one unit (decision 0026, "Updates"; 0027's publication): the unit is
 * addressed by what it read and what it was told, so a second run with the same inputs keeps what
 * the first wrote and a run with other inputs writes again. Nothing here reads a clock.
 */
export function writerUnitDigest(input: {
  readonly kind: WriterUnitKindName;
  readonly version: number;
  readonly scope: string;
  readonly language: string;
  readonly inputs: readonly string[];
}): string {
  return canonicalJsonDigest({
    kind: input.kind,
    version: input.version,
    scope: input.scope,
    language: input.language,
    inputs: [...new Set(input.inputs)].sort(byCodePoint),
  });
}

/** The bytes of a text, for a digest input that must notice a rewritten document. */
export function textDigest(text: string): string {
  return canonicalJsonDigest({ text, bytes: new TextEncoder().encode(text).length });
}

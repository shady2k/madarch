/**
 * The entities that live in Markdown documents, read by meaning (madarch-ztyq.3, decision 0032 section 4; decision 0029:
 * what is not rebuilt from code is Markdown, and the manifest says which kinds the wiki shows).
 *
 * One reader decides what a document is made of: `doc-tree.ts` parses it, `anchors.ts` names its parts and their
 * extents from that tree, and nothing here looks at a line of text to find a heading, a block or a meaning. A section is
 * a heading with the blocks it holds; a block is a list item or a paragraph; its text and its title come from the node.
 *
 * Sections are classified in three passes, each recorded on the entity it decided:
 *
 * 1. `metadata` — the document's front matter (`sections:`), a kind's `identifier` prefixes (`UC` takes `UC-2`) and a
 *    kind's `terms` patterns (a glossary's leading bold words).
 * 2. `structure` — a kind's `headings`: the blocks of the section a heading names, numbered or not; and a kind's
 *    `structure`, the sections a section of it holds.
 * 3. `classifier` — the typed classifier of `semantics.ts`, which the production host fills from jev and the agent.
 *
 * The passes decide BLOCK by BLOCK: a section that holds an identified rule and an unnumbered one keeps both, the
 * numbered one decided by its identifier and the other by its heading, and a block no pass decides is offered to the
 * classifier — and, when it is still unread, is a finding of its own, never a passage that disappears.
 *
 * A number such as `UC-1`, and the anchor a section stands at, are aliases: the identity is `stableId`, minted once and
 * kept beside the product (`doc-identities.ts`), and the page id a link names is built from it — so renaming a heading or
 * removing a `UC-`/`BR-` alias keeps every link. The anchor stays a display and resolution detail.
 */
import { byCodePoint } from '../model/order.js';
import { anchorExtent, anchorsOfTree, identifierOf, slugOf } from './anchors.js';
import { assignIdentities, documentKey, type DocIdentities, type DocumentIdentities, type SectionIdentity } from './doc-identities.js';
import { boldLead, leadText, openingParagraph, readDocTree, sectionBlocks, type DocNode, type DocSection, type DocumentSource } from './doc-tree.js';
import { globToRegExp, type Finding, type FindingKind, type KindDecl, type KindsManifest } from './kinds.js';
import { normaliseHeading, type PassageRequest, type PassageReading, type SemanticClassifier, type SemanticKind } from './semantics.js';

export type { DocumentSource } from './doc-tree.js';
export { IDENTITIES_FILE, readDocIdentities, writeDocIdentities, documentKey } from './doc-identities.js';
export type { DocIdentities, DocumentIdentities, DocIdentity } from './doc-identities.js';
export { identifierOf } from './anchors.js';

/** Which pass decided what a section is. */
export type DecidingPass = 'metadata' | 'structure' | 'classifier';

export interface DocEntity {
  /** The page id, `doc:<path>#<stableId>`: built from the durable identity, never from the anchor (finding 2). */
  id: string;
  kind: string;
  /** What a reader calls it: the identifier and its name (`UC-2 Pay`), or the words of its first passage. */
  title: string;
  /** The alias the document writes (`UC-2`); null for a section that numbers nothing. Never the identity. */
  identifier: string | null;
  repo: string | null;
  path: string;
  /** The anchor the document gives it now: what a ground names and a page shows, never what the page is called. */
  anchor: string;
  /** The 1-based line the passage starts at, and the last line it covers. */
  line: number;
  endLine: number;
  /** The passage's Markdown without the line that names it (the heading, the bold identifier or the list mark). */
  text: string;
  /** The durable identity: the page id's fragment, which a rename or a renumbering does not change. */
  stableId: string;
  /** The general kind the section was read as. */
  semantics: SemanticKind;
  /** The pass that decided the kind: the manifest and the metadata, the structure, or the classifier. */
  pass: DecidingPass;
  /** The heading texts that enclose it, from the document's first heading down to it. */
  headingPath: string[];
}

/** The id of the entity a passage is: its document and its durable identity, not the anchor a heading may change. */
export function docEntityId(repo: string | null, path: string, stableId: string): string {
  return `doc:${repo === null ? '' : `@${repo}/`}${path}#${stableId}`;
}

/**
 * A document address in its parts: `doc:<path>#<fragment>` in the product repository, or `doc:@<repository>/<path>#<fragment>`
 * in a connected one (madarch-ztyq.3, the review of finding C(a)). The fragment is either a source anchor — the part the
 * document gives that anchor now — or a durable identity, which no anchor can spell.
 */
export interface DocumentAddress {
  readonly repo: string | null;
  readonly path: string;
  readonly fragment: string;
}

/** The parts of a document address, or undefined when the address names a whole document or is no document address. */
export function parseDocumentAddress(address: string): DocumentAddress | undefined {
  if (!address.startsWith('doc:')) return undefined;
  const rest = address.slice('doc:'.length);
  const hash = rest.indexOf('#');
  if (hash < 0) return undefined;
  const where = rest.slice(0, hash);
  const fragment = rest.slice(hash + 1);
  if (where.startsWith('@')) {
    const slash = where.indexOf('/');
    if (slash < 0) return undefined;
    return { repo: where.slice(1, slash), path: where.slice(slash + 1), fragment };
  }
  return { repo: null, path: where, fragment };
}

/** The collection of entities a page or a link names: the map the wiki renders from. */
export interface HasDocEntities { get(id: string): DocEntity | undefined; values(): IterableIterator<DocEntity> }

/**
 * The entity a document address names, whichever kind of address it is: a source anchor opens the passage the document
 * gives that anchor now, a durable identity opens the passage it was minted for. Both are looked up by what the address
 * says, so a page written before an identity was minted still opens its passage (madarch-ztyq.3, the review of A).
 */
export function entityAtAddress(entities: HasDocEntities, address: string): DocEntity | undefined {
  const exact = entities.get(address);
  if (exact !== undefined) return exact;
  const parsed = parseDocumentAddress(address);
  if (parsed === undefined) return undefined;
  for (const entity of entities.values()) {
    if (entity.repo !== parsed.repo || entity.path !== parsed.path) continue;
    if (entity.stableId === parsed.fragment) return entity;
    if (entity.anchor === parsed.fragment.toLowerCase()) return entity;
  }
  return undefined;
}

export interface ReadDocOptions {
  /** The third pass: the classifier the host fills from jev and the agent. Without one, only the manifest decides. */
  readonly classifier?: SemanticClassifier;
  /** The durable identities of earlier reads, from the product's store; absent means the documents were never read. */
  readonly identities?: DocIdentities;
}

export interface DocRead {
  entities: DocEntity[];
  findings: Finding[];
  /** The identities as this read leaves them: the caller keeps them beside the product, never in the repository. */
  identities: Map<string, DocumentIdentities>;
}

/** A passage that may become an entity, before it has an identity or a page. */
interface Candidate {
  kind: KindDecl;
  semantics: SemanticKind;
  pass: DecidingPass;
  anchor: string;
  title: string;
  identifier: string | null;
  line: number;
  endLine: number;
  text: string;
  headingPath: string[];
}

const DIGIT = (code: number): boolean => code >= 0x30 && code <= 0x39;

/** A passage's own words, quoted for a finding: shortened to 140 characters, never paraphrased. */
function quote(words: string): string {
  const characters = [...words];
  const cut = characters.length <= 140 ? words : `${characters.slice(0, 139).join('')}…`;
  return `«${cut}»`;
}

/** The trimming every title and body does, by character: marks and separators are dropped, never a word. */
function trimStart(text: string): string {
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '.' || char === ':' || char === '-' || char === '–' || char === '—' || char === ')') at += 1;
    else break;
  }
  return text.slice(at);
}

function trimEnd(text: string): string {
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '.' || char === ':') end -= 1;
    else break;
  }
  return text.slice(0, end);
}

/** A text with its whitespace collapsed and its ends trimmed. */
function flat(text: string): string {
  let collapsed = '';
  for (const char of text) {
    const space = char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
    if (space && (collapsed === '' || collapsed.endsWith(' '))) continue;
    collapsed += space ? ' ' : char;
  }
  return collapsed.trimEnd();
}

/** The name after an identifier: `UC-2 Pay.` gives `Pay`, `ADR-0001: Kafka is the broker` gives `Kafka is the broker`. */
function nameAfter(phrase: string, identifier: string): string {
  return trimEnd(trimStart(flat(phrase).slice(identifier.length))).trim();
}

/** The words a listing calls a passage: up to its first sentence end or its first colon. */
function firstWords(text: string): string {
  const plain = flat(text);
  for (let at = 0; at < plain.length; at += 1) {
    const char = plain[at]!;
    if (char === ':' && plain[at + 1] === ' ') return trimEnd(plain.slice(0, at)).trim();
    if (char !== '.' && char !== '!' && char !== '?') continue;
    const after = plain[at + 1];
    if (after !== undefined && after !== ' ') continue;
    // A full stop between two digits is a decimal point, not the end of a sentence.
    if (char === '.' && DIGIT((plain[at - 1] ?? ' ').codePointAt(0)!) && DIGIT((after ?? ' ').codePointAt(0)!)) continue;
    return trimEnd(plain.slice(0, at)).trim();
  }
  return trimEnd(plain).trim();
}

/** The text of a block without the phrase that names it, its list mark and indentation aside. */
function bodyOf(block: DocNode): string {
  if (block.type !== 'listItem') return block.raw.trim();
  const paragraph = openingParagraph(block);
  if (paragraph === undefined) return block.children.map((child) => child.raw.trimEnd()).join('\n').trim();
  const rest = block.children.filter((child) => child !== paragraph).map((child) => child.raw.trimEnd());
  const bold = boldLead(block);
  const first = bold === undefined ? trimStart(paragraph.raw) : trimStart(paragraph.raw.slice(bold.endOffset - paragraph.startOffset));
  return [first, ...rest].join('\n').trim();
}

/** What a listing calls the block: its bold phrase, the identifier and its name, or the words of its first sentence. */
function titleOf(block: DocNode, identifier: string | null): string {
  const bold = boldLead(block);
  if (identifier !== null) {
    const phrase = bold?.plain ?? leadText(block);
    return `${identifier} ${nameAfter(phrase, identifier)}`.trim();
  }
  if (bold !== undefined) return trimEnd(flat(bold.plain)).trim();
  return firstWords(leadText(block));
}

/** The anchors that name a block, in the order the anchor reader met them. */
function anchorsOfNode(names: ReadonlyMap<DocNode, readonly string[]>, block: DocNode): readonly string[] {
  return names.get(block) ?? [];
}

/** The prose of a paragraph a reading names, validated against the block's own source. */
function passageOf(block: DocNode, reading: PassageReading, document: readonly string[]): { text: string; line: number; endLine: number } | null {
  if (reading.line < block.line || reading.endLine > block.endLine || reading.line > reading.endLine) return null;
  const source = document.slice(reading.line - 1, reading.endLine).join('\n');
  const wanted = flat(reading.text);
  if (wanted === '' || !flat(source).includes(wanted)) return null;
  return { text: reading.text.trim(), line: reading.line, endLine: reading.endLine };
}

/** Every entity of the manifest's document kinds in the documents, in code point order of their ids; and what could not be read. */
export function readDocEntities(sources: readonly DocumentSource[], manifest: KindsManifest, options: ReadDocOptions = {}): DocRead {
  const kinds = [...manifest.kinds.values()].filter((kind) => kind.source === 'document');
  const findings: Finding[] = [];
  const entities: DocEntity[] = [];
  // The identities of the documents this read does not see stand as they were: a document that was not read for a
  // moment keeps its links.
  const identities = new Map<string, DocumentIdentities>(options.identities ?? []);
  if (kinds.length === 0) return { entities, findings, identities };
  const bySemantics = new Map<SemanticKind, KindDecl>();
  for (const kind of kinds) if (kind.semantics !== undefined && !bySemantics.has(kind.semantics)) bySemantics.set(kind.semantics, kind);
  for (const source of sources) {
    const key = documentKey(source.repo, source.path);
    const where = source.repo === null ? source.path : `repos/${source.repo}/${source.path}`;
    // Every diagnostic of this document names both places it stands in: the identity a reader navigates by and the file.
    const report = (line: number, message: string, kind?: FindingKind): void => { findings.push({ file: where, line, message, ...(kind === undefined ? {} : { kind }), ...(source.origin === undefined ? {} : { source: source.origin }) }); };
    const tree = readDocTree(source);
    findings.push(...tree.findings);
    const reading = anchorsOfTree(tree);
    const names = new Map<DocNode, string[]>();
    for (const [anchor, node] of reading.nodes) {
      const held = names.get(node);
      if (held === undefined) names.set(node, [anchor]);
      else held.push(anchor);
    }
    const lines = source.text.split('\n');
    const declared = frontSections(tree.meta, tree.front, kinds, report);
    const terms = kindOfTerms(kinds, source.path);
    const candidates: Candidate[] = [];
    const covered: { line: number; endLine: number }[] = [];
    const isCovered = (section: DocSection): boolean => covered.some((range) => section.line >= range.line && section.endLine <= range.endLine);
    const anchorsOfBlock = (block: DocNode, identifier: string | null, place: number): string | undefined => {
      const held = anchorsOfNode(names, block);
      if (place > 1) return held.length === 0 ? undefined : `${held[0]}.${String(place)}`;
      // An identifier the document writes is the anchor a reader would name, even when an earlier block already took it:
      // the second one is then a second section of the same name, and the finding below says so.
      if (identifier !== null && identifier !== '') {
        const written = identifier.toLowerCase();
        if (held.includes(written) || reading.lines.has(written)) return written;
      }
      if (held.length > 0) return held[0];
      return reading.blocks.get(block.line);
    };
    for (const section of tree.sections) {
      if (isCovered(section)) continue;
      // Pass 1, a heading that opens with an identifier: the whole section is the entity (an ADR keeps its parts).
      if (section.heading !== null) {
        const identifier = identifierOf(section.heading.plain);
        const kind = identifier === null ? undefined : kindOfIdentifier(kinds, identifier);
        if (identifier !== null && kind !== undefined) {
          const anchor = anchorsOfBlock(section.heading, identifier, 1);
          if (anchor === undefined) { report(section.line, 'the heading names no anchor a link could carry, so no page shows this section'); continue; }
          candidates.push({ kind, semantics: kind.semantics ?? 'other', pass: 'metadata', anchor, title: titleOf(section.heading, identifier), identifier, line: section.line, endLine: section.endLine, text: section.text, headingPath: [...section.headingPath] });
          covered.push({ line: section.line, endLine: section.endLine });
          const missing = kind.structure === undefined ? [] : missingStructure(section, kind.structure, tree.sections);
          if (missing.length > 0) report(section.line, `this "${kind.name}" holds no ${missing.join(', no ')}, which the manifest declares its structure: the section is shown as the document writes it, and what it lacks is said here`);
          continue;
        }
      }
      // Passes 1 and 2, block by block: an identifier or a term names one, else the heading the manifest declares takes
      // the block. A block neither decides is kept for the classifier — one identified rule does not hide its neighbour.
      const sectionKind = section.heading === null ? undefined : declared.get(normaliseHeading(section.heading.plain));
      const byHeading = section.heading === null ? undefined : kinds.find((kind) => kind.headings?.some((heading) => normaliseHeading(heading) === normaliseHeading(section.heading!.plain)));
      const pending: DocNode[] = [];
      for (const block of sectionBlocks(section)) {
        const lead = leadText(block);
        const identifier = identifierOf(lead);
        const byIdentifier = identifier === null ? undefined : kindOfIdentifier(kinds, identifier);
        const bold = boldLead(block) !== undefined;
        let kind: KindDecl | undefined;
        let pass: DecidingPass = 'metadata';
        if (identifier !== null && byIdentifier !== undefined) kind = byIdentifier;
        else if (sectionKind !== undefined) kind = sectionKind;
        else if (terms !== undefined && bold) kind = terms;
        else if (byHeading !== undefined) { kind = byHeading; pass = 'structure'; }
        if (kind === undefined) { pending.push(block); continue; }
        const anchor = anchorsOfBlock(block, identifier, 1);
        if (anchor === undefined) { report(block.line, 'this passage stands before the document\'s first heading, so it has no anchor a link could name: it is not shown as an entity'); continue; }
        candidates.push({ kind, semantics: kind.semantics ?? 'other', pass, anchor, title: titleOf(block, identifier), identifier, line: block.line, endLine: block.endLine, text: bodyOf(block), headingPath: [...section.headingPath] });
      }
      // Pass 3, the classifier: only the blocks the first two passes left, and every reading keeps its own span.
      if (pending.length > 0 && options.classifier !== undefined) {
        const request: PassageRequest = {
          repo: source.repo, path: source.path, headingPath: [...section.headingPath], text: section.text, line: section.line, endLine: section.endLine,
          blocks: pending.map((block) => ({ line: block.line, endLine: block.endLine, text: bodyOf(block) })),
        };
        const readings = options.classifier.classify(request);
        // The passages of one block: the first keeps the block's own anchor, each later one its place in the block.
        const places = new Map<DocNode, number>();
        if (readings.length === 0) {
          report(section.line, 'no classifier has read this section yet, so what it means is not shown: the manifest declares no kind for it, and this is said rather than dropped', 'unread-passage');
          continue;
        }
        for (const passage of readings) {
          const block = pending.find((candidate) => passage.line >= candidate.line && passage.endLine <= candidate.endLine);
          const span = block === undefined ? null : passageOf(block, passage, lines);
          if (block === undefined || span === null) {
            report(passage.line, `the classifier read a ${passage.kind} here, and the passage it names is not a passage of this section: no page shows it`);
            continue;
          }
          // A passage the classifier read as no general kind of the product is read: nothing is shown and nothing is missing.
          if (passage.kind === 'other') { places.set(block, (places.get(block) ?? 0) + 1); continue; }
          // The block has been read, whatever the manifest makes of the reading: it is not a block nobody read.
          const place = (places.get(block) ?? 0) + 1;
          places.set(block, place);
          const kind = bySemantics.get(passage.kind);
          if (kind === undefined) {
            report(passage.line, `this passage is a ${passage.kind} and the manifest declares no kind with "semantics: ${passage.kind}", so no page shows it`);
            continue;
          }
          const identifier = identifierOf(leadText(block));
          const anchor = anchorsOfBlock(block, identifier, place);
          if (anchor === undefined) {
            report(passage.line, `the ${passage.kind} this classifier read has no anchor a link could name, so no page shows it`);
            continue;
          }
          candidates.push({ kind, semantics: passage.kind, pass: 'classifier', anchor, title: place === 1 ? titleOf(block, identifier) : firstWords(span.text), identifier: place === 1 ? identifier : null, line: span.line, endLine: span.endLine, text: span.text, headingPath: [...section.headingPath] });
        }
        for (const block of pending) if (!places.has(block)) report(block.line, `the classifier read no meaning of this passage, so no page shows it: ${quote(firstWords(leadText(block)))}`, 'unread-passage');
      } else if (pending.length > 0) {
        // Without a classifier every passage the first two passes left is said, with its own words: the wiki shows what
        // it could not decide instead of a smaller picture of the documents (madarch-ztyq.3, the review of finding 5).
        for (const block of pending) {
          const words = firstWords(leadText(block));
          report(block.line, `no kind of the manifest and no classifier read this passage, so no page shows it: ${quote(words)}`, 'unread-passage');
        }
      }
    }
    // A number names one section: a second section with the same anchor has no page, and the finding says where the first is.
    const kept: Candidate[] = [];
    const seen = new Map<string, number>();
    for (const candidate of candidates) {
      const first = seen.get(candidate.anchor);
      if (first !== undefined) {
        const what = candidate.identifier ?? (candidate.semantics === 'term' ? `the term "${candidate.title}"` : `the section "${candidate.title}"`);
        report(candidate.line, `${what} opens a second section of this document (the first is at line ${first}); an identifier names one section, so this one has no page`);
        continue;
      }
      seen.set(candidate.anchor, candidate.line);
      kept.push(candidate);
    }
    // The durable identities of the passages, so a renumbered or renamed one keeps the links it had.
    const sections: SectionIdentity[] = kept.map((candidate) => ({ anchor: candidate.anchor, kind: candidate.kind.name, title: candidate.title, text: candidate.text }));
    const assigned = assignIdentities(key, sections, options.identities?.get(key));
    identities.set(key, assigned.next);
    kept.forEach((candidate, index) => {
      const stableId = assigned.ids[index]!;
      entities.push({
        id: docEntityId(source.repo, source.path, stableId),
        kind: candidate.kind.name,
        title: candidate.title,
        identifier: candidate.identifier,
        repo: source.repo,
        path: source.path,
        anchor: candidate.anchor,
        line: candidate.line,
        endLine: candidate.endLine,
        text: candidate.text,
        stableId,
        semantics: candidate.semantics,
        pass: candidate.pass,
        headingPath: candidate.headingPath,
      });
    });
  }
  // What the documents lack: a kind the product expects and no document holds is said, with the manifest's file and line.
  const held = new Set(entities.map((entity) => entity.kind));
  for (const expected of manifest.expect ?? []) {
    if (held.has(expected.kind)) continue;
    const kind = manifest.kinds.get(expected.kind);
    const what = kind?.semantics === undefined ? '' : ` (a ${kind.semantics})`;
    findings.push({ file: manifest.file, line: expected.line, message: `the documents hold no entity of kind "${expected.kind}"${what}, which "documents.expect" says they must: no section of any document is read as it, so the wiki says what the documents lack and this is one of the lacks` });
  }
  return { entities: entities.sort((a, b) => byCodePoint(a.path, b.path) || a.line - b.line || byCodePoint(a.anchor, b.anchor)), findings, identities };
}

/** The kind whose identifier prefixes take one: the prefix a kind names wins over a kind that takes any other prefix. */
function kindOfIdentifier(kinds: readonly KindDecl[], identifier: string): KindDecl | undefined {
  const prefix = identifier.slice(0, identifier.indexOf('-')).toUpperCase();
  return kinds.find((kind) => kind.identifier?.some((entry) => entry.toUpperCase() === prefix))
    ?? kinds.find((kind) => kind.identifier?.includes('*'));
}

/** The kind whose `terms` patterns name the document: a glossary's leading bold words. */
function kindOfTerms(kinds: readonly KindDecl[], path: string): KindDecl | undefined {
  return kinds.find((kind) => kind.terms?.some((pattern) => globToRegExp(pattern).test(path)));
}

/** The line of the front matter a field stands on, or the first line of the document's body. */
function frontLine(front: string | null, needle: string): number {
  if (front === null) return 2;
  const lines = front.split('\n');
  for (const [index, line] of lines.entries()) if (line.includes(needle)) return index + 2;
  return 2;
}

/** What the document's front matter says its sections are (`sections: { Qualities: doc.quality }`), by heading. */
function frontSections(meta: Record<string, unknown> | null, front: string | null, kinds: readonly KindDecl[], report: (line: number, message: string) => void): Map<string, KindDecl> {
  const declared = new Map<string, KindDecl>();
  const raw = meta?.['sections'];
  if (raw === undefined || raw === null) return declared;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    report(frontLine(front, 'sections'), 'the front matter\'s "sections" maps a heading to the kind its sections are, such as { Qualities: doc.quality }');
    return declared;
  }
  for (const [heading, value] of Object.entries(raw as Record<string, unknown>)) {
    const line = frontLine(front, heading);
    if (typeof value !== 'string' || value.trim() === '') {
      report(line, `the front matter names the section ${JSON.stringify(heading)} as ${JSON.stringify(value)}: a section names the kind its passages are`);
      continue;
    }
    const kind = kinds.find((candidate) => candidate.name === value) ?? kinds.find((candidate) => candidate.semantics === value);
    if (kind === undefined) {
      report(line, `the front matter names the section ${JSON.stringify(heading)} as ${JSON.stringify(value)}, and the manifest declares no kind or general kind of that name: the kinds are ${kinds.map((candidate) => candidate.name).join(', ') || 'none'}`);
      continue;
    }
    declared.set(normaliseHeading(heading), kind);
  }
  return declared;
}

/**
 * The sections a section of its kind declares (an ADR's Status, Context, Decision and Consequences) that it does not
 * hold: each is a child heading, or a paragraph that opens with the name and a colon. What is missing is answered, for
 * the finding that says the section is incomplete.
 */
function missingStructure(section: DocSection, structure: readonly string[], sections: readonly DocSection[]): string[] {
  const headings = new Set<string>();
  const labels = new Set<string>();
  const read = (nodes: readonly DocNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') headings.add(normaliseHeading(node.plain));
      else if (node.type === 'paragraph') {
        const text = flat(node.plain);
        const at = text.indexOf(':');
        if (at > 0) labels.add(normaliseHeading(text.slice(0, at)));
      }
    }
  };
  read(section.nodes);
  // A section of a section is part of it: an ADR's Context, Decision and Consequences are its sub-sections.
  for (const inner of sections) if (inner !== section && inner.heading !== null && inner.line > section.line && inner.endLine <= section.endLine) { headings.add(normaliseHeading(inner.heading.plain)); read(inner.nodes); }
  return structure.filter((name) => !headings.has(normaliseHeading(name)) && !labels.has(normaliseHeading(name)));
}

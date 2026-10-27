/**
 * The entities that live in Markdown documents, read by meaning
 * (madarch-ztyq.3, decision 0032 section 4; decision 0029: what is not rebuilt
 * from code is Markdown, and the manifest says which kinds the wiki shows).
 *
 * A document is parsed into a tree of headings, paragraphs and lists with the
 * exact lines and offsets of every node (`doc-tree.ts`), and its sections are
 * classified in three passes, in this order, each recording which one decided:
 *
 * 1. `metadata` — explicit declarations: the document's front matter, a kind's
 *    `identifier` prefixes (`UC` takes `UC-2`), and a kind's `terms` patterns
 *    (the leading bold word of a glossary's items).
 * 2. `structure` — what the document's shape says without a number: a kind's
 *    `headings` (each list item or paragraph under `## Qualities` is an entity
 *    of the kind), and a kind's `structure` (the sections an ADR holds).
 * 3. `classifier` — the typed classifier of `semantics.ts`, which the production
 *    host fills from jev and the agent: a passage that holds several meanings is
 *    split by it, and a passage of a general kind no kind names is a finding.
 *
 * No expression over the text and no list of headings, prefixes or words lives
 * here: the conventions are the product's own, in `madarch/kinds.yaml`. A number
 * such as `UC-1` is an alias — `identifier`, never the identity: the identity is
 * `stableId`, kept beside the product in the store (`doc-identities.ts`), so a
 * renumbered or renamed section keeps its links. The wiki's page id stays
 * `doc:<path>#<anchor>`, the anchor being one `anchors.ts` names.
 *
 * What the documents lack is said: a kind the manifest lists in
 * `documents.expect` that no document holds is a finding naming the manifest's
 * file, line and full path, and a passage that cannot be shown says so.
 */
import { byCodePoint } from '../model/order.js';
import { anchorLines, blockAnchors, slugOf } from './anchors.js';
import { assignStableIds, documentKey, type DocIdentities, type DocumentIdentities, type SectionIdentity } from './doc-identities.js';
import { readDocTree, type DocNode, type DocSection, type DocumentSource } from './doc-tree.js';
import { globToRegExp, type Finding, type KindDecl, type KindsManifest } from './kinds.js';
import { normaliseHeading, type PassageRequest, type SemanticClassifier, type SemanticKind } from './semantics.js';

export type { DocumentSource } from './doc-tree.js';
export { IDENTITIES_FILE, readDocIdentities, writeDocIdentities, documentKey } from './doc-identities.js';
export type { DocIdentities, DocumentIdentities, DocIdentity } from './doc-identities.js';

/** Which pass decided what a section is. */
export type DecidingPass = 'metadata' | 'structure' | 'classifier';

export interface DocEntity {
  /** `doc:<path>#<anchor>`, or `doc:@<repository>/<path>#<anchor>` in a connected repository: the wiki's page id. */
  id: string;
  kind: string;
  /** What a reader calls it: the identifier and its name (`UC-2 Pay`), or the words of its first passage. */
  title: string;
  /** The alias the document writes (`UC-2`); null for a section that numbers nothing. Never the identity. */
  identifier: string | null;
  repo: string | null;
  path: string;
  anchor: string;
  /** The 1-based line the section starts at, and the last line it covers. */
  line: number;
  endLine: number;
  /** The section's Markdown without the line that names it (the heading, the bold identifier or the list mark). */
  text: string;
  /** The identity a link keeps when the heading or the number changes. */
  stableId: string;
  /** The general kind the section was read as. */
  semantics: SemanticKind;
  /** The pass that decided the kind: the manifest and the metadata, the structure, or the classifier. */
  pass: DecidingPass;
  /** The heading texts that enclose it, from the document's first heading down to it. */
  headingPath: string[];
}

/** The id of the entity a section is. */
export function docEntityId(repo: string | null, path: string, anchor: string): string {
  return `doc:${repo === null ? '' : `@${repo}/`}${path}#${anchor}`;
}

export interface ReadDocOptions {
  /** The third pass: the classifier the host fills from jev and the agent. Without one, only the manifest decides. */
  readonly classifier?: SemanticClassifier;
  /** The stable identities of earlier reads, from the product's store; absent means the documents were never read. A document this read does not see keeps the identity it had. */
  readonly identities?: DocIdentities;
}

export interface DocRead {
  entities: DocEntity[];
  findings: Finding[];
  /** The identities as this read leaves them: the caller keeps them beside the product, never in the repository. */
  identities: Map<string, DocumentIdentities>;
}

/** What a section may become, before it has an anchor, an identity or a page. */
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

const LETTER = (code: number): boolean => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const DIGIT = (code: number): boolean => code >= 0x30 && code <= 0x39;
const WORD = (char: string | undefined): boolean => {
  if (char === undefined) return false;
  const code = char.codePointAt(0)!;
  return LETTER(code) || DIGIT(code) || char === '_';
};

/** A text with the Markdown marks removed, its whitespace collapsed, trimmed. */
const plainText = (text: string): string => text.replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();

/**
 * The identifier a text opens with (`UC-2`, `ADR-0001`), or null: letters, a
 * hyphen and digits, then a boundary — read by walking the characters, so no
 * expression over the document's text decides what a section is.
 */
export function identifierOf(text: string): string | null {
  const plain = plainText(text);
  let at = 0;
  while (at < plain.length && LETTER(plain.codePointAt(at)!)) at += 1;
  const letters = plain.slice(0, at);
  if (letters === '' || plain[at] !== '-') return null;
  at += 1;
  const start = at;
  while (at < plain.length && DIGIT(plain.codePointAt(at)!)) at += 1;
  const digits = plain.slice(start, at);
  if (digits === '' || WORD(plain[at])) return null;
  return `${letters.toUpperCase()}-${digits}`;
}

/** The name after an identifier: `UC-2 Pay.` gives `Pay`, `ADR-0001: Kafka is the broker` gives `Kafka is the broker`. */
function nameAfter(phrase: string, identifier: string): string {
  const plain = phrase.replace(/[`*_~]/g, '').trim();
  return plain.slice(identifier.length).replace(/^[\s:.\-–—)]+/, '').replace(/[\s.:]+$/, '');
}

/** The words a listing calls a passage: up to its first sentence end or its first colon. */
function nameOf(text: string): string {
  const plain = plainText(text);
  for (let at = 0; at < plain.length; at += 1) {
    const char = plain[at]!;
    if (char === ':' && plain[at + 1] === ' ') return plain.slice(0, at).replace(/[\s,;]+$/, '');
    if (char !== '.' && char !== '!' && char !== '?') continue;
    const after = plain[at + 1];
    if (after !== undefined && after !== ' ') continue;
    // A full stop between two digits is a decimal point, not the end of the sentence.
    if (char === '.' && /\d/.test(plain[at - 1] ?? '') && /\d/.test(after ?? '')) continue;
    return plain.slice(0, at).replace(/[\s,;]+$/, '');
  }
  return plain.replace(/[\s.:]+$/, '');
}

/** The blocks a section holds itself: the top-level items of its lists, and its paragraphs. */
function ownBlocks(section: DocSection): DocNode[] {
  const blocks: DocNode[] = [];
  for (const node of section.nodes) {
    if (node.type === 'list') for (const item of node.children) blocks.push(item);
    else if (node.type === 'paragraph') blocks.push(node);
  }
  return blocks;
}

/** The paragraph a block opens with: an item's first paragraph, or the paragraph itself. */
function opening(block: DocNode): DocNode | undefined {
  return block.type === 'listItem' ? block.children.find((child) => child.type === 'paragraph') : block;
}

/** The bold phrase a block opens with, when it opens with one; that phrase names the block. */
function boldLead(block: DocNode): DocNode | undefined {
  const lead = opening(block)?.children[0];
  return lead !== undefined && lead.type === 'strong' ? lead : undefined;
}

/** The block's text without the phrase that names it, its list mark and indentation aside. */
function bodyOf(block: DocNode): string {
  if (block.type !== 'listItem') return block.raw.trim();
  const paragraph = opening(block);
  if (paragraph === undefined) return block.children.map((child) => child.raw.replace(/\s+$/, '')).join('\n').trim();
  const rest = block.children.filter((child) => child !== paragraph).map((child) => child.raw.replace(/\s+$/, ''));
  const bold = boldLead(block);
  const first = bold === undefined ? paragraph.raw : paragraph.raw.slice(bold.endOffset - paragraph.startOffset);
  return [first.replace(bold === undefined ? /^\s+/ : /^[\s.:\-–—]+/, ''), ...rest].join('\n').trim();
}

/** What a listing calls the block: its bold phrase, the identifier and its name, or the words of its first passage. */
function titleOf(block: DocNode, identifier: string | null): string {
  const bold = boldLead(block);
  const phrase = bold?.plain ?? opening(block)?.plain ?? block.plain;
  if (identifier !== null) return `${identifier} ${nameAfter(phrase, identifier)}`.trim();
  if (bold !== undefined) return plainText(bold.plain).replace(/[\s.:]+$/, '');
  return nameOf(phrase);
}

/** The anchor `anchors.ts` names the block by: its bold phrase, its identifier, or the heading above it and its place there. */
function anchorOf(block: DocNode, identifier: string | null, blocks: ReadonlyMap<number, string>): string | null {
  if (identifier !== null && boldLead(block) !== undefined) return identifier.toLowerCase();
  const bold = boldLead(block);
  if (bold !== undefined) return slugOf(plainText(bold.plain).replace(/[.:]\s*$/, ''));
  if (identifier !== null) return identifier.toLowerCase();
  return blocks.get(block.line) ?? null;
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
  const at = front.split('\n').findIndex((line) => line.includes(needle));
  return at < 0 ? 2 : at + 2;
}

/** What the document's front matter says its sections are (`sections: { Qualities: doc.quality }`), by heading. */
function frontSections(meta: Record<string, unknown> | null, front: string | null, where: string, kinds: readonly KindDecl[], findings: Finding[]): Map<string, KindDecl> {
  const declared = new Map<string, KindDecl>();
  const raw = meta?.['sections'];
  if (raw === undefined || raw === null) return declared;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    findings.push({ file: where, line: frontLine(front, 'sections'), message: 'the front matter\'s "sections" maps a heading to the kind its sections are, such as { Qualities: doc.quality }' });
    return declared;
  }
  for (const [heading, value] of Object.entries(raw as Record<string, unknown>)) {
    const line = frontLine(front, heading);
    if (typeof value !== 'string' || value.trim() === '') {
      findings.push({ file: where, line, message: `the front matter names the section ${JSON.stringify(heading)} as ${JSON.stringify(value)}: a section names the kind its passages are` });
      continue;
    }
    const kind = kinds.find((candidate) => candidate.name === value) ?? kinds.find((candidate) => candidate.semantics === value);
    if (kind === undefined) {
      findings.push({ file: where, line, message: `the front matter names the section ${JSON.stringify(heading)} as ${JSON.stringify(value)}, and the manifest declares no kind or general kind of that name: the kinds are ${kinds.map((candidate) => candidate.name).join(', ') || 'none'}` });
      continue;
    }
    declared.set(normaliseHeading(heading), kind);
  }
  return declared;
}

/**
 * Whether a section holds the structure its kind declares (an ADR's Status,
 * Context, Decision and Consequences): each named section is a child heading, or
 * a paragraph that opens with the name and a colon. The ones that are missing
 * are answered, for the finding that says the section is incomplete.
 */
function missingStructure(section: DocSection, structure: readonly string[], sections: readonly DocSection[]): string[] {
  const headings = new Set<string>();
  const labels = new Set<string>();
  const read = (nodes: readonly DocNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') headings.add(normaliseHeading(node.plain));
      else if (node.type === 'paragraph') {
        const text = plainText(node.plain);
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

/** Every entity of the manifest's document kinds in the documents, in code point order of their ids; and what could not be read. */
export function readDocEntities(sources: readonly DocumentSource[], manifest: KindsManifest, options: ReadDocOptions = {}): DocRead {
  const kinds = [...manifest.kinds.values()].filter((kind) => kind.source === 'document');
  const findings: Finding[] = [];
  const entities: DocEntity[] = [];
  // The identities of the documents this read does not see stand as they were: a document that was not read for a moment keeps its links.
  const identities = new Map<string, DocumentIdentities>(options.identities ?? []);
  if (kinds.length === 0) return { entities, findings, identities };
  const bySemantics = new Map<SemanticKind, KindDecl>();
  for (const kind of kinds) if (kind.semantics !== undefined && !bySemantics.has(kind.semantics)) bySemantics.set(kind.semantics, kind);
  for (const source of sources) {
    const key = documentKey(source.repo, source.path);
    const where = source.repo === null ? source.path : `repos/${source.repo}/${source.path}`;
    const tree = readDocTree(source);
    findings.push(...tree.findings);
    const anchors = anchorLines(source.text);
    const blocks = blockAnchors(source.text);
    const atLine = new Map<number, string[]>();
    for (const [anchor, line] of anchors) {
      const held = atLine.get(line);
      if (held === undefined) atLine.set(line, [anchor]);
      else held.push(anchor);
    }
    const blockValues = new Set(blocks.values());
    const declared = frontSections(tree.meta, tree.front, where, kinds, findings);
    const terms = kindOfTerms(kinds, source.path);
    const candidates: Candidate[] = [];
    const decided = new Set<DocNode>();
    const decidedSections = new Set<DocSection>();
    const covered: { line: number; endLine: number }[] = [];
    const isCovered = (section: DocSection): boolean => covered.some((range) => section.line >= range.line && section.endLine <= range.endLine);
    const candidateOf = (kind: KindDecl, pass: DecidingPass, block: DocNode, identifier: string | null): Candidate | null => {
      const anchor = anchorOf(block, identifier, blocks);
      if (anchor === null) {
        findings.push({ file: where, line: block.line, message: `this ${block.type === 'listItem' ? 'list item' : 'paragraph'} stands before the document's first heading, so it has no anchor a link could name: it is not shown as an entity of kind "${kind.name}"` });
        return null;
      }
      return { kind, semantics: kind.semantics ?? 'other', pass, anchor, title: titleOf(block, identifier), identifier, line: block.line, endLine: block.endLine, text: bodyOf(block), headingPath: [] };
    };
    for (const section of tree.sections) {
      if (isCovered(section)) continue;
      // Pass 1, the metadata the document itself writes: a heading that opens with an identifier is its whole section (ADR-0001).
      if (section.heading !== null) {
        const identifier = identifierOf(section.heading.plain);
        const kind = identifier === null ? undefined : kindOfIdentifier(kinds, identifier);
        if (identifier !== null && kind !== undefined) {
          const anchor = identifier.toLowerCase();
          candidates.push({ kind, semantics: kind.semantics ?? 'other', pass: 'metadata', anchor, title: titleOf(section.heading, identifier), identifier, line: section.line, endLine: section.endLine, text: section.text, headingPath: [...section.headingPath] });
          covered.push({ line: section.line, endLine: section.endLine });
          const missing = kind.structure === undefined ? [] : missingStructure(section, kind.structure, tree.sections);
          if (missing.length > 0) findings.push({ file: where, line: section.line, message: `this "${kind.name}" holds no ${missing.join(', no ')}, which the manifest declares its structure: the section is shown as the document writes it, and what it lacks is said here` });
          continue;
        }
      }
      // Pass 1, each block the document itself names: an identifier, or a glossary term's bold word.
      const sectionKind = section.heading === null ? undefined : declared.get(normaliseHeading(section.heading.plain));
      let decidedHere = false;
      for (const block of ownBlocks(section)) {
        const identifier = identifierOf(opening(block)?.plain ?? block.plain);
        const byIdentifier = identifier === null ? undefined : kindOfIdentifier(kinds, identifier);
        if (identifier !== null && byIdentifier !== undefined) {
          const candidate = candidateOf(byIdentifier, 'metadata', block, identifier);
          if (candidate !== null) { candidate.headingPath = [...section.headingPath]; candidates.push(candidate); decided.add(block); decidedHere = true; }
          continue;
        }
        if (sectionKind !== undefined) {
          const candidate = candidateOf(sectionKind, 'metadata', block, identifier);
          if (candidate !== null) { candidate.headingPath = [...section.headingPath]; candidates.push(candidate); decided.add(block); decidedHere = true; }
          continue;
        }
        if (terms !== undefined && boldLead(block) !== undefined) {
          const candidate = candidateOf(terms, 'metadata', block, identifier);
          if (candidate !== null) { candidate.headingPath = [...section.headingPath]; candidates.push(candidate); decided.add(block); decidedHere = true; }
        }
      }
      if (decidedHere) { decidedSections.add(section); continue; }
      // Pass 2, what the document's shape says: the headings a kind declares take their list items, or their paragraphs.
      if (section.heading === null) continue;
      const name = normaliseHeading(section.heading.plain);
      const byHeading = kinds.find((kind) => kind.headings?.some((heading) => normaliseHeading(heading) === name));
      if (byHeading === undefined) continue;
      for (const block of ownBlocks(section)) {
        if (decided.has(block)) continue;
        const identifier = identifierOf(opening(block)?.plain ?? block.plain);
        const candidate = candidateOf(byHeading, 'structure', block, identifier);
        if (candidate === null) continue;
        candidate.headingPath = [...section.headingPath];
        candidates.push(candidate);
        decided.add(block);
        decidedHere = true;
      }
      if (decidedHere) decidedSections.add(section);
    }
    // Pass 3, the classifier: a passage that holds several meanings is split by it, and the document's own text stands.
    if (options.classifier !== undefined) {
      for (const section of tree.sections) {
        if (isCovered(section) || section.heading === null || decidedSections.has(section)) continue;
        const open = ownBlocks(section);
        if (open.length === 0) continue;
        const request: PassageRequest = {
          repo: source.repo, path: source.path, headingPath: [...section.headingPath], text: section.text, line: section.line, endLine: section.endLine,
          blocks: open.map((block) => ({ line: block.line, endLine: block.endLine, text: bodyOf(block) })),
        };
        const readings = options.classifier.classify(request);
        if (readings.length === 0) {
          findings.push({ file: where, line: section.line, message: `no classifier has read this section yet, so what it means is not shown: the manifest declares no kind for it, and this is said rather than dropped` });
          continue;
        }
        // A block no reading covers is a passage whose meaning nobody read: it is said, never dropped.
        if (readings.length < open.length) {
          for (const block of open) {
            if (readings.some((reading) => reading.endLine >= block.line && reading.line <= block.endLine)) continue;
            findings.push({ file: where, line: block.line, message: `the classifier read no meaning of this ${block.type === 'listItem' ? 'list item' : 'paragraph'}, so no page shows it: this is said rather than dropped` });
          }
        }
        for (const reading of readings) {
          const kind = bySemantics.get(reading.kind);
          if (kind === undefined) {
            findings.push({ file: where, line: reading.line, message: `this passage is a ${reading.kind} and the manifest declares no kind with "semantics: ${reading.kind}", so no page shows it` });
            continue;
          }
          const block = open.find((candidate) => candidate.line === reading.line);
          const identifier = block === undefined ? identifierOf(reading.text) : identifierOf(opening(block)?.plain ?? block.plain);
          const anchor = block !== undefined ? anchorOf(block, identifier, blocks) : (atLine.get(reading.line)?.find((candidate) => !blockValues.has(candidate)) ?? blocks.get(reading.line) ?? null);
          if (anchor === null) {
            findings.push({ file: where, line: reading.line, message: `the ${reading.kind} this classifier read has no anchor a link could name, so no page shows it` });
            continue;
          }
          candidates.push({
            kind, semantics: reading.kind, pass: 'classifier', anchor,
            title: block !== undefined ? titleOf(block, identifier) : nameOf(reading.text),
            identifier, line: reading.line, endLine: reading.endLine,
            text: block === undefined ? reading.text : bodyOf(block), headingPath: [...section.headingPath],
          });
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
        findings.push({ file: where, line: candidate.line, message: `${what} opens a second section of this document (the first is at line ${first}); an identifier names one section, so this one has no page` });
        continue;
      }
      seen.set(candidate.anchor, candidate.line);
      kept.push(candidate);
    }
    // The identities of the sections, so a renumbered or renamed one keeps the links it had.
    const sections: SectionIdentity[] = kept.map((candidate) => ({ anchor: candidate.anchor, kind: candidate.kind.name, title: candidate.title, text: candidate.text }));
    const assigned = assignStableIds(key, sections, options.identities?.get(key));
    identities.set(key, assigned.next);
    kept.forEach((candidate, index) => {
      entities.push({
        id: docEntityId(source.repo, source.path, candidate.anchor),
        kind: candidate.kind.name,
        title: candidate.title,
        identifier: candidate.identifier,
        repo: source.repo,
        path: source.path,
        anchor: candidate.anchor,
        line: candidate.line,
        endLine: candidate.endLine,
        text: candidate.text,
        stableId: assigned.ids[index]!,
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
  return { entities: entities.sort((a, b) => byCodePoint(a.id, b.id)), findings, identities };
}

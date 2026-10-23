/**
 * The entities that live in Markdown documents (madarch-m38l.6; decision 0029:
 * what is not rebuilt from code is Markdown, the manifest says which kinds the
 * wiki shows). A manifest kind whose source is `document` names the sections it
 * takes:
 *
 * - `identifier: UC` takes a heading or a list item or paragraph that opens with
 *   that identifier (`## UC-2 Pay`, `- **UC-2 Pay.** ...`, `# ADR-0001: Broker`);
 *   `identifier: "*"` takes every other identifier;
 * - `terms: ["**\/glossary.md"]` takes the leading bold term of every list item of
 *   the documents the patterns name (`- **Outbox** - the table ...`).
 *
 * The reading is deterministic and local to a document: the same text gives the
 * same entities anywhere. An entity's id is `doc:<path>#<anchor>` in the product
 * repository and `doc:@<repository>/<path>#<anchor>` in a connected one; the
 * anchor is the one a `madarch:doc:` ground names (`anchors.ts`), so a ground to
 * the section opens the entity's page.
 */
import { byCodePoint } from '../model/order.js';
import { slugOf } from './anchors.js';
import { globToRegExp, type Finding, type KindDecl, type KindsManifest } from './kinds.js';

/** A Markdown document as read: where it is and its text. */
export interface DocumentSource {
  /** The code repository's name; null for the product repository. */
  repo: string | null;
  path: string;
  text: string;
}

export interface DocEntity {
  id: string;
  kind: string;
  /** What a reader calls it: the identifier and its name (`UC-2 Pay`), or the term. */
  title: string;
  /** `UC-2`; null for a term. */
  identifier: string | null;
  repo: string | null;
  path: string;
  anchor: string;
  /** The 1-based line the section starts at, and the last line it covers. */
  line: number;
  endLine: number;
  /** The section's Markdown without the line that names it (the bold identifier or the heading). */
  text: string;
}

/** The id of the entity a section is. */
export function docEntityId(repo: string | null, path: string, anchor: string): string {
  return `doc:${repo === null ? '' : `@${repo}/`}${path}#${anchor}`;
}

const IDENTIFIER = /^([A-Za-z]+)-(\d+)\b/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)(.+?)(?:\*\*|__)(.*)$/;
const LIST_MARK = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

const plain = (text: string): string => text.replace(/[`*_~]/g, '').trim();

/** The name after an identifier: `UC-2 Pay.` gives `Pay`, `ADR-0001: Kafka is the broker` gives `Kafka is the broker`. */
function nameAfter(phrase: string, identifier: string): string {
  return plain(phrase).slice(identifier.length).replace(/^[\s:.\-–—)]+/, '').replace(/[\s.:]+$/, '');
}

interface Raw {
  identifier: string | null;
  anchor: string;
  title: string;
  line: number;
  endLine: number;
  text: string;
  termOnly: boolean;
}

/** The sections of one document that open with an identifier or a bold term, before kinds are matched. */
function sectionsOf(text: string, allowTerms: boolean): Raw[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Raw[] = [];
  let fenced = false;
  const fence: boolean[] = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return true; }
    return fenced;
  });
  const headings: { level: number; line: number }[] = [];
  lines.forEach((line, index) => {
    if (fence[index]) return;
    const heading = HEADING.exec(line);
    if (heading !== null) headings.push({ level: heading[1]!.length, line: index + 1 });
  });
  for (let index = 0; index < lines.length; index += 1) {
    if (fence[index]) continue;
    const line = lines[index]!;
    const number = index + 1;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      const lead = IDENTIFIER.exec(plain(heading[2]!));
      if (lead === null) continue;
      const identifier = `${lead[1]!.toUpperCase()}-${lead[2]}`;
      const next = headings.find((entry) => entry.line > number && entry.level <= level);
      const end = next === undefined ? lines.length : next.line - 1;
      const body = lines.slice(index + 1, end);
      out.push({ identifier, anchor: identifier.toLowerCase(), title: `${identifier} ${nameAfter(heading[2]!, lead[0]).trim()}`.trim(), line: number, endLine: trimEnd(lines, end), text: body.join('\n').trim(), termOnly: false });
      continue;
    }
    const item = ITEM.exec(line);
    if (item === null) continue;
    const indent = item[1]!.length;
    const isListItem = LIST_MARK.test(line);
    // A bold phrase in the middle of a paragraph is not a lead; a paragraph's lead is its first words.
    if (!isListItem && !line.trimStart().startsWith('**') && !line.trimStart().startsWith('__')) continue;
    const phrase = item[2]!;
    const lead = IDENTIFIER.exec(plain(phrase));
    if (lead === null && !allowTerms) continue;
    const identifier = lead === null ? null : `${lead[1]!.toUpperCase()}-${lead[2]}`;
    const name = identifier === null ? plain(phrase).replace(/[\s.:]+$/, '') : nameAfter(phrase, lead![0]);
    // The item runs to the next item of its level, the next heading, or the end of its indented continuation.
    let end = index;
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      const next = lines[probe]!;
      if (fence[probe]) { end = probe; continue; }
      if (next.trim() === '') {
        const after = lines.slice(probe + 1).findIndex((candidate) => candidate.trim() !== '');
        if (after < 0) break;
        const following = lines[probe + 1 + after]!;
        if (isListItem && following.length - following.trimStart().length > indent) { end = probe; continue; }
        break;
      }
      if (HEADING.test(next) || /^\s*<!--/.test(next)) break;
      const mark = LIST_MARK.exec(next);
      if (mark !== null && mark[1]!.length <= indent) break;
      if (!isListItem && ITEM.test(next) && !/^\s+/.test(next)) break;
      end = probe;
    }
    const first = `${item[3] ?? ''}`.replace(/^[\s.:\-–—]+/, '');
    const rest = lines.slice(index + 1, end + 1).map((value) => value.replace(new RegExp(`^\\s{0,${indent + 2}}`), ''));
    out.push({
      identifier,
      anchor: identifier === null ? slugOf(name) : identifier.toLowerCase(),
      title: identifier === null ? name : `${identifier} ${name}`.trim(),
      line: number,
      endLine: trimEnd(lines, end + 1),
      text: [first, ...rest].join('\n').trim(),
      termOnly: identifier === null,
    });
  }
  return out;
}

/** The last non-blank line (1-based) at or before `end` (1-based, inclusive). */
function trimEnd(lines: readonly string[], end: number): number {
  let last = Math.min(end, lines.length);
  while (last > 1 && lines[last - 1]!.trim() === '') last -= 1;
  return last;
}

/** The kind of the manifest that takes a section, or undefined. A kind naming the identifier wins over a catch-all. */
function kindOfSection(kinds: readonly KindDecl[], raw: Raw, path: string): KindDecl | undefined {
  if (raw.identifier !== null) {
    const prefix = raw.identifier.slice(0, raw.identifier.indexOf('-')).toUpperCase();
    return kinds.find((kind) => kind.identifier?.some((entry) => entry.toUpperCase() === prefix))
      ?? kinds.find((kind) => kind.identifier?.includes('*'));
  }
  return kinds.find((kind) => kind.terms?.some((pattern) => globToRegExp(pattern).test(path)));
}

/** Every entity of the manifest's document kinds in the documents, in code point order of their ids; and what could not be read. */
export function readDocEntities(sources: readonly DocumentSource[], manifest: KindsManifest): { entities: DocEntity[]; findings: Finding[] } {
  const kinds = [...manifest.kinds.values()].filter((kind) => kind.source === 'document');
  const findings: Finding[] = [];
  if (kinds.length === 0) return { entities: [], findings };
  const entities: DocEntity[] = [];
  for (const source of sources) {
    const allowTerms = kinds.some((kind) => kind.terms?.some((pattern) => globToRegExp(pattern).test(source.path)));
    const seen = new Map<string, number>();
    const where = source.repo === null ? source.path : `repos/${source.repo}/${source.path}`;
    for (const raw of sectionsOf(source.text, allowTerms)) {
      const kind = kindOfSection(kinds, raw, source.path);
      if (kind === undefined) continue;
      const first = seen.get(raw.anchor);
      if (first !== undefined) {
        findings.push({ file: where, line: raw.line, message: `${raw.identifier ?? `the term "${raw.title}"`} opens a second section of this document (the first is at line ${first}); an identifier names one section, so this one has no page` });
        continue;
      }
      seen.set(raw.anchor, raw.line);
      entities.push({
        id: docEntityId(source.repo, source.path, raw.anchor), kind: kind.name, title: raw.title, identifier: raw.identifier,
        repo: source.repo, path: source.path, anchor: raw.anchor, line: raw.line, endLine: raw.endLine, text: raw.text,
      });
    }
  }
  return { entities: entities.sort((a, b) => byCodePoint(a.id, b.id)), findings };
}

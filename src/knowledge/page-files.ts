/**
 * The agent's view of a page (madarch-m38l.25): the same `PageModel` the app
 * draws, serialised as Markdown and as a documented JSON document. Nothing is
 * read a second time and no template is rendered here: the blocks the page
 * already holds are written out.
 *
 * The addresses are siblings of the HTML page: `/k/e/<id>.md`, `/k/e/<id>.json`,
 * `/k/kind/<kind>.md`, `/k/kind/<kind>.json`, and the product's `/llms.txt`.
 * A server mounted under a product home passes its prefix, so every address a
 * document holds stays inside that product.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Block, CodeLocation, EntityRef, KindSummary, PageModel } from './model.js';
import type { Resolution } from './resolve.js';
import { entityAddress, kindAddress } from './resolve.js';

/** The versioned name of the page document. A change of shape is a new name. */
export const PAGE_SCHEMA = 'madarch.page.v1';
/** The versioned name of a kind's list document. */
export const KIND_SCHEMA = 'madarch.kind.v1';

export interface PageFileLink {
  title: string;
  /** The address in the wiki, or null when the kind has no page. */
  url: string | null;
  kind?: string;
  id?: string;
  /** Why the link resolves to nothing, when it does not. */
  broken?: string;
}

export interface PageFileItem extends PageFileLink {
  note?: string;
  count?: number;
  hops?: number;
  badge?: string;
  /** Where the entity itself stands. */
  place?: PageFilePlace;
  /** Where this page's call to the entity stands, when that is a different place. */
  site?: PageFilePlace;
  figures?: { kind: string; value: string }[];
}

export interface PageFileGroup {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  items: PageFileItem[];
}

export interface PageFilePlace {
  /** The code repository's name; null for the product's own repository. */
  repository: string | null;
  path: string;
  line: number;
  endLine: number;
  /** The wiki's source view at the first line. */
  url: string;
  /** The same place on the repository's web page, when its address is known. */
  web?: string;
}

export interface PageFileDiagram {
  title: string;
  label: string;
  query: string;
  renderers: string[];
  /** The diagram in Mermaid's own words; empty when the view has nothing to draw. */
  mermaid: string;
  /** Why the view is empty, when it is. */
  empty: string | null;
  notes: string[];
  items: PageFileItem[];
  edges: PageFileEdge[];
}

export interface PageFileEdge {
  from: string;
  to: string;
  relation: string;
  count: number;
}

export type PageFileSectionType =
  | 'text'
  | 'links'
  | 'relations'
  | 'items'
  | 'properties'
  | 'source'
  | 'diagram'
  | 'history'
  | 'contract'
  | 'problem'
  | 'deferred';

export interface PageFileSection {
  title: string;
  type: PageFileSectionType;
  /** Markdown text for a text-like section; a source's code for `source`. */
  text?: string;
  links?: PageFileLink[];
  items?: PageFileItem[];
  groups?: PageFileGroup[];
  properties?: { name: string; value: string }[];
  place?: PageFilePlace;
  language?: string;
  /** The contract's format (`openapi`, `proto`, ...). */
  format?: string;
  views?: PageFileDiagram[];
  edges?: PageFileEdge[];
  total?: number;
  shown?: number;
  depth?: number;
  /** The product file a body or problem block was read from. */
  file?: string;
  /** The 1-based line in that file a problem block stands at. */
  line?: number;
  statements?: number;
  ungrounded?: { text: string; line: number }[];
  diagnostics?: { file: string; line: number; path: string; code: string; message: string }[];
  /** The block the page could not draw, when it names one. */
  block?: string;
  /** A note the section adds: why it is empty, what it holds back, a caution. */
  message?: string;
  notes?: string[];
}

export interface PageFileDocument {
  schema: typeof PAGE_SCHEMA;
  id: string;
  kind: string;
  title: string;
  /** The HTML page. */
  address: string;
  /** This document's address. */
  json: string;
  /** The Markdown sibling's address. */
  markdown: string;
  trail: PageFileLink[];
  sections: PageFileSection[];
  findings: { file: string; line: number; message: string; kind?: string; source?: string }[];
  notes: string[];
  planned?: {
    entity: 'scope' | 'impact' | null;
    statements: { sentence: string; how: 'scope' | 'impact'; task: { id: string; slug: string; title: string; file: string } }[];
    note?: string;
  };
}

export interface KindFileDocument {
  schema: typeof KIND_SCHEMA;
  kind: string;
  title: string;
  description?: string;
  address: string;
  json: string;
  markdown: string;
  /** How many entities the lists hold: every one is in `entries`. */
  total: number;
  entries: PageFileItem[];
}

/** A prefix is the product home's mount (`/products/<name>`) or empty. */
const at = (href: string | null | undefined, prefix: string): string | null =>
  href === null || href === undefined ? null : href.startsWith('/') ? `${prefix}${href}` : href;

const placeOf = (location: CodeLocation | undefined, prefix: string): PageFilePlace | undefined =>
  location === undefined
    ? undefined
    : {
        repository: location.repo,
        path: location.path,
        line: location.lineStart,
        endLine: location.lineEnd,
        url: at(location.href, prefix)!,
        ...(location.web === undefined ? {} : { web: location.web.url }),
      };

const linkOf = (ref: EntityRef, prefix: string): PageFileLink => ({
  title: ref.label,
  url: at(ref.href, prefix),
  kind: ref.kind,
  id: ref.id,
  ...(ref.broken === undefined ? (ref.href === null ? { broken: `the kind ${ref.kind} has no page` } : {}) : { broken: ref.broken }),
});

const itemOf = (ref: EntityRef, prefix: string): PageFileItem => ({
  ...linkOf(ref, prefix),
  ...(ref.location === undefined ? {} : { place: placeOf(ref.location, prefix)! }),
});

/** The text of an mdast label: its words, without the marks around them. */
interface MdNode {
  type: string;
  url?: string;
  alt?: string | null;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const wordsOf = (node: MdNode): string => {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (node.type === 'image') return node.alt ?? '';
  return (node.children ?? []).map(wordsOf).join('');
};

const parser = unified().use(remarkParse).use(remarkGfm);

function linksIn(text: string): { title: string; url: string }[] {
  const root = parser.parse(text) as unknown as MdNode;
  const found: { title: string; url: string }[] = [];
  const walk = (node: MdNode): void => {
    if (node.type === 'link' && typeof node.url === 'string') found.push({ title: wordsOf(node), url: node.url });
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

const brokenNote = (reason: string): string => ` *(no page: ${reason.split('\n').join(' ')})*`;

/**
 * A page's text with its `madarch:` links written as the wiki addresses they
 * resolve to. A link that resolves to nothing keeps its words, its reason
 * beside it, and is listed as broken instead of becoming a dead scheme. The
 * links are found by the Markdown reader (`linksIn`'s parse) at their own
 * offsets, so a link's words may hold any markup the page wrote.
 */
function rewrite(text: string, resolutions: Readonly<Record<string, Resolution>>, prefix: string): string {
  const root = parser.parse(text) as unknown as MdNode;
  const changes: { start: number; end: number; text: string }[] = [];
  const walk = (node: MdNode): void => {
    if (node.type === 'link' && typeof node.url === 'string') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const original = text.slice(start, end);
        let replacement = original;
        const resolution = resolutions[node.url];
        if (node.url.startsWith('madarch:')) {
          if (resolution === undefined) replacement = `${original}${brokenNote('no resolution for the link')}`;
          else if (resolution.state === 'broken') replacement = `${original}${brokenNote(resolution.reason)}`;
          else if (resolution.href === null) replacement = `${wordsOf(node)}${brokenNote(resolution.note ?? `the kind ${resolution.kind} has no page`)}`;
          else {
            const href = at(resolution.href, prefix)!;
            // The destination is the first occurrence of the url after the link's `](`, so a title after it is kept.
            const open = original.indexOf('](');
            const destination = open === -1 ? -1 : original.indexOf(node.url, open + 2);
            if (destination !== -1) replacement = original.slice(0, destination) + href + original.slice(destination + node.url.length);
          }
        }
        if (replacement !== original) changes.push({ start, end, text: replacement });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  let out = text;
  for (const change of changes.sort((left, right) => right.start - left.start)) out = out.slice(0, change.start) + change.text + out.slice(change.end);
  return out;
}

function textLinks(text: string, resolutions: Readonly<Record<string, Resolution>>, prefix: string): PageFileLink[] {
  const seen = new Set<string>();
  const links: PageFileLink[] = [];
  for (const link of linksIn(text)) {
    const resolution = resolutions[link.url];
    let entry: PageFileLink;
    if (link.url.startsWith('madarch:')) {
      if (resolution === undefined) entry = { title: link.title, url: null, broken: 'no resolution for the link' };
      else if (resolution.state === 'broken') entry = { title: link.title, url: null, broken: resolution.reason };
      else if (resolution.href === null) entry = { title: link.title, url: null, kind: resolution.kind, ...(resolution.entity === undefined ? {} : { id: resolution.entity }), broken: resolution.note ?? `the kind ${resolution.kind} has no page` };
      else entry = { title: link.title, url: at(resolution.href, prefix), kind: resolution.kind, ...(resolution.entity === undefined ? {} : { id: resolution.entity }) };
    } else {
      entry = { title: link.title, url: at(link.url, prefix) };
    }
    const key = `${entry.title}\u0000${entry.url}\u0000${entry.kind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(entry);
  }
  return links;
}

/** A fenced code block no backtick run in the text can close early. */
function fenced(text: string, language: string): string {
  let ticks = 3;
  for (const line of text.split('\n')) {
    let run = 0;
    for (const character of line) {
      if (character === '`') {
        run += 1;
        if (run >= ticks) ticks = run + 1;
      } else run = 0;
    }
  }
  const fence = '`'.repeat(ticks);
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return `${fence}${language}\n${body}\n${fence}`;
}

/** Link words never break the link's brackets and never carry a line break. */
const linkWords = (text: string): string => text.split('\n').join(' ').split('[').join('\\[').split(']').join('\\]');

function markdownLink(title: string, url: string | null): string {
  const words = linkWords(title === '' ? url ?? '' : title);
  return url === null ? words : `[${words}](${url})`;
}

function itemLine(item: PageFileItem): string {
  const parts = [markdownLink(item.title, item.url)];
  if (item.badge !== undefined) parts.push(`(${item.badge})`);
  if (item.note !== undefined && item.note !== '') parts.push(item.note);
  if (item.count !== undefined) parts.push(`(${item.count})`);
  if (item.place !== undefined) parts.push(`${item.site === undefined ? 'at' : 'stands at'} ${markdownLink(`${item.place.path}:${item.place.line}`, item.place.url)}`);
  if (item.site !== undefined) parts.push(`called at ${markdownLink(`${item.site.path}:${item.site.line}`, item.site.url)}`);
  if (item.broken !== undefined) parts.push(`(no page: ${item.broken})`);
  if (item.figures !== undefined && item.figures.length > 0) parts.push(item.figures.map((figure) => `${figure.kind}: ${figure.value}`).join(', '));
  return `- ${parts.join(' — ')}`;
}

function sectionMarkdown(section: PageFileSection): string {
  const lines: string[] = [];
  if (section.title !== '') lines.push(`## ${section.title}`.split('\n').join(' '));
  const message = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');
  switch (section.type) {
    case 'text':
      if (section.text !== undefined && section.text !== '') lines.push(section.text);
      for (const item of section.items ?? []) lines.push(itemLine(item));
      break;
    case 'links':
    case 'items':
      for (const item of section.items ?? []) lines.push(itemLine(item));
      break;
    case 'relations':
      for (const group of section.groups ?? []) {
        lines.push(`### ${group.relation} (${group.direction}, ${group.total})`);
        for (const item of group.items) lines.push(itemLine(item));
      }
      break;
    case 'properties':
      for (const property of section.properties ?? []) lines.push(`- **${property.name}**: ${property.value}`);
      break;
    case 'source':
      if (section.text !== undefined) lines.push(fenced(section.text, section.language ?? ''));
      if (section.place !== undefined) lines.push(`Source: ${markdownLink(`${section.place.path}:${section.place.line}`, section.place.url)}`);
      break;
    case 'diagram':
      for (const view of section.views ?? []) {
        lines.push(`### ${view.label === '' ? view.title : view.label}`.split('\n').join(' '));
        if (view.empty !== null) lines.push(message(view.empty));
        if (view.mermaid !== '') lines.push(fenced(view.mermaid, 'mermaid'));
        for (const item of view.items) lines.push(itemLine(item));
        for (const edge of view.edges) lines.push(`- ${edge.from} → ${edge.to} — ${edge.relation} (${edge.count})`);
        for (const note of view.notes) lines.push(`- ${note}`);
      }
      for (const item of section.items ?? []) lines.push(itemLine(item));
      for (const edge of section.edges ?? []) lines.push(`- ${edge.from} → ${edge.to} — ${edge.relation} (${edge.count})`);
      break;
    case 'history':
      for (const group of section.groups ?? []) {
        lines.push(`### ${group.relation} (${group.total})`);
        for (const item of group.items) lines.push(itemLine(item));
      }
      break;
    case 'contract':
      if (section.place !== undefined) lines.push(`Source: ${markdownLink(`${section.place.path}:${section.place.line}`, section.place.url)}`);
      if (section.text !== undefined) lines.push(fenced(section.text, section.format ?? ''));
      for (const item of section.items ?? []) lines.push(itemLine(item));
      break;
    case 'problem':
      lines.push(message(section.message ?? ''));
      if (section.file !== undefined) lines.push(`At \`${section.file}${section.line === undefined ? '' : `:${section.line}`}\``);
      break;
    case 'deferred':
      lines.push(message(section.message ?? 'The page did not draw this block.'));
      break;
  }
  if (section.place !== undefined && (section.type === 'items' || section.type === 'links')) lines.push(`At ${markdownLink(`${section.place.path}:${section.place.line}`, section.place.url)}`);
  if (section.type !== 'problem' && section.type !== 'deferred' && section.message !== undefined) lines.push(message(section.message));
  for (const note of section.notes ?? []) lines.push(`- ${note}`);
  for (const diagnostic of section.diagnostics ?? []) lines.push(`- ${diagnostic.file}:${diagnostic.line}: ${diagnostic.path}: ${diagnostic.message}`);
  for (const ungrounded of section.ungrounded ?? []) lines.push(`- Ungrounded (line ${ungrounded.line}): ${ungrounded.text}`);
  return lines.join('\n\n');
}

function plannedSection(page: PageModel, prefix: string): PageFileSection[] {
  const planned = page.planned;
  if (planned === undefined) return [];
  const sections: PageFileSection[] = [{
    title: 'Planned change',
    type: 'items',
    items: [
      ...(planned.entity === null ? [] : [{ title: `This page (${planned.entity})`, url: null }]),
      ...planned.statements.map((statement) => ({
        title: statement.sentence,
        url: null,
        note: `${statement.how}: ${statement.task.id} — ${statement.task.title} (${statement.task.file})`,
      })),
    ],
    ...(planned.note === undefined ? {} : { message: planned.note }),
  }];
  return sections;
}

/** The page as the documented JSON document. */
export function pageFileDocument(page: PageModel, prefix = ''): PageFileDocument {
  const sections: PageFileSection[] = [];
  for (const block of page.blocks) sections.push(sectionOf(block, page, prefix));
  const address = at(entityAddress(page.id), prefix)!;
  return {
    schema: PAGE_SCHEMA,
    id: page.id,
    kind: page.kind,
    title: page.title,
    address,
    json: `${address}.json`,
    markdown: `${address}.md`,
    trail: page.trail.map((ref) => ({ title: ref.label, url: at(ref.href, prefix), kind: ref.kind, id: ref.id })),
    sections: [...sections, ...plannedSection(page, prefix)],
    findings: page.findings.map((finding) => ({ file: finding.file, line: finding.line, message: finding.message, ...(finding.kind === undefined ? {} : { kind: finding.kind }), ...(finding.source === undefined ? {} : { source: finding.source }) })),
    notes: [...page.notes],
    ...(page.planned === undefined
      ? {}
      : {
          planned: {
            entity: page.planned.entity === null ? null : page.planned.entity.how,
            statements: page.planned.statements.map((statement) => ({ sentence: statement.sentence, how: statement.how, task: statement.task })),
            ...(page.planned.note === undefined ? {} : { note: page.planned.note }),
          },
        }),
  };
}

function sectionOf(block: Block, page: PageModel, prefix: string): PageFileSection {
  const rewriteText = (text: string): string => rewrite(text, page.resolutions, prefix);
  const resolved = (text: string): string => rewriteText(text);
  switch (block.type) {
    case 'guide': {
      const data = block.data;
      return {
        title: '',
        type: 'text',
        text: rewriteText(data.markdown),
        links: textLinks(data.markdown, page.resolutions, prefix),
        diagnostics: data.diagnostics.map((diagnostic) => ({ file: diagnostic.file, line: diagnostic.line, path: diagnostic.path, code: diagnostic.code, message: diagnostic.message })),
      };
    }
    case 'markdown':
      return { title: '', type: 'text', text: resolved(block.markdown), links: textLinks(block.markdown, page.resolutions, prefix) };
    case 'term': {
      const text = [resolved(block.definition), block.usedIn === null ? '' : resolved(block.usedIn)].filter(Boolean).join('\n\n');
      return {
        title: block.title,
        type: 'text',
        text,
        links: textLinks([block.definition, block.usedIn ?? '', block.ambiguous ?? ''].join('\n\n'), page.resolutions, prefix),
        items: [
          ...block.synonyms.map((synonym) => ({ title: synonym, url: null, badge: 'synonym' })),
          ...block.code.map((entry) => ({ title: entry, url: null, badge: 'code' })),
        ],
        ...(block.ambiguous === null ? {} : { message: resolved(block.ambiguous) }),
      };
    }
    case 'body':
      return {
        title: '',
        type: 'text',
        text: resolved(block.markdown),
        links: textLinks(block.markdown, page.resolutions, prefix),
        file: block.file,
        statements: block.statements,
        ...(block.ungrounded.length === 0 ? {} : { ungrounded: block.ungrounded }),
      };
    case 'graph':
      return {
        title: block.title,
        type: 'diagram',
        depth: block.depth,
        shown: block.shown,
        total: block.total,
        items: block.neighborhood.nodes.map((node) => ({
          title: node.label,
          url: at(node.href, prefix),
          kind: node.kind,
          id: node.id,
          ...(node.hops === undefined ? {} : { hops: node.hops }),
        })),
        edges: block.neighborhood.edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation, count: edge.count })),
        groups: block.neighborhood.relations.map((relation) => ({ relation: relation.relation, direction: relation.direction, total: relation.count, items: [] })),
        ...(block.neighborhood.more.length === 0 ? {} : { notes: block.neighborhood.more.map((more) => `${more.hidden} more ${more.relation} (${more.direction}) from ${more.node}`) }),
      };
    case 'diagrams':
      return {
        title: block.title,
        type: 'diagram',
        views: block.views.map((view) => ({
          title: view.title,
          label: view.label,
          query: view.query,
          renderers: [...view.renderers],
          mermaid: view.mermaidSource,
          empty: view.empty,
          notes: [...view.notes],
          items: view.elements.map((element) => ({
            title: element.label,
            url: at(element.href, prefix),
            kind: element.kind,
            id: element.id,
            ...(element.detail === undefined ? {} : { note: element.detail }),
            ...(element.location === undefined ? {} : { place: placeOf(element.location, prefix)! }),
            ...(element.standsFor === undefined ? {} : { count: element.standsFor }),
          })),
          edges: view.edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.label, count: 1 })),
        })),
      };
    case 'treemap':
      return {
        title: block.title,
        type: 'items',
        total: block.total,
        items: block.files.map((file) => ({
          title: file.path,
          url: at(file.href, prefix),
          id: file.id,
          count: file.lines,
          note: `${file.churn} commits`,
        })),
        ...(block.notes.length === 0 ? {} : { notes: block.notes }),
      };
    case 'related':
      return {
        title: block.title,
        type: 'relations',
        groups: block.groups.map((group) => ({
          relation: group.relation,
          direction: group.direction,
          total: group.total,
          items: group.rows.map((row) => ({
            ...itemOf(row.entity, prefix),
            count: row.count,
            ...(row.hops === undefined ? {} : { hops: row.hops }),
          })),
        })),
      };
    case 'callers':
    case 'callees':
      return {
        title: block.title,
        type: 'links',
        total: block.total,
        items: block.rows.map((row) => ({
          ...itemOf(row.entity, prefix),
          count: row.sites,
          ...(row.site === undefined ? {} : { site: placeOf(row.site, prefix)! }),
        })),
      };
    case 'source':
      return {
        title: block.title,
        type: 'source',
        place: placeOf(block.location, prefix),
        language: block.language,
        text: block.text,
        ...(block.truncated ? { message: 'The file is cut to the size the page shows.' } : {}),
      };
    case 'refs':
      return {
        title: block.title,
        type: 'links',
        total: block.total,
        items: block.rows.map((row) => ({ ...itemOf(row.entity, prefix), ...(row.note === undefined ? {} : { note: row.note }) })),
      };
    case 'properties':
      return {
        title: block.title,
        type: 'properties',
        properties: block.rows.map((row) => ({ name: row.name, value: row.value })),
      };
    case 'stated':
      return {
        title: block.title,
        type: 'items',
        place: {
          repository: block.place.repo,
          path: block.place.path,
          line: block.place.lineStart,
          endLine: block.place.lineEnd,
          url: at(block.place.href, prefix)!,
        },
        items: [],
      };
    case 'deferred':
      return {
        title: block.title,
        type: 'deferred',
        block: block.block,
        message: `The page did not draw the block "${block.block}" (line ${block.line}).`,
      };
    case 'definition':
      return {
        title: block.title,
        type: 'contract',
        format: block.format,
        text: block.spec.text,
        ...(block.location === undefined ? {} : { place: placeOf(block.location, prefix) }),
        items: block.members.map((member) => ({
          title: member.label,
          url: at(member.href, prefix),
          ...(member.detail === undefined ? {} : { note: member.detail }),
          ...(member.badge === undefined ? {} : { badge: member.badge }),
        })),
        total: block.membersTotal,
        shown: block.membersShown,
        ...(block.diagnostics === undefined || block.diagnostics.length === 0
          ? {}
          : { diagnostics: block.diagnostics.map((diagnostic) => ({ file: block.fullPath ?? diagnostic.fullPath, line: diagnostic.line, path: diagnostic.path, code: diagnostic.code, message: diagnostic.technicalDetail === undefined ? diagnostic.detail : `${diagnostic.detail}: ${diagnostic.technicalDetail}` })) }),
      };
    case 'history':
      return {
        title: block.title,
        type: 'history',
        groups: block.sections.map((section) => ({
          relation: section.role,
          direction: 'out',
          total: section.total,
          items: section.rows.map((row) => ({
            title: row.text,
            url: at(row.entity?.href ?? null, prefix),
            ...(row.entity === undefined ? {} : { kind: row.entity.kind, id: row.entity.id }),
            ...(row.entity?.location === undefined ? {} : { place: placeOf(row.entity.location, prefix)! }),
            note: [row.when, row.who].filter((part): part is string => part !== undefined).join(' · '),
            figures: row.figures.map((figure) => ({ kind: figure.kind, value: figure.value })),
          })),
        })),
        ...(block.notes.length === 0 ? {} : { notes: block.notes.map((note) => (note.args === undefined ? note.key : `${note.key} (${Object.entries(note.args).map(([name, value]) => `${name}: ${value}`).join(', ')})`)) }),
      };
    case 'problem':
      return {
        title: block.block,
        type: 'problem',
        block: block.block,
        file: block.file,
        line: block.line,
        message: block.message,
        ...(block.diagnostic === undefined ? {} : { diagnostics: [{ file: block.diagnostic.fullPath, line: block.diagnostic.line, path: block.diagnostic.path, code: block.diagnostic.code, message: block.diagnostic.technicalDetail === undefined ? block.diagnostic.detail : `${block.diagnostic.detail}: ${block.diagnostic.technicalDetail}` }] }),
      };
  }
}

/** The page as one Markdown document: its title, its trail, every block in order, then its findings. */
export function pageFileMarkdown(page: PageModel, prefix = ''): string {
  const document = pageFileDocument(page, prefix);
  const parts: string[] = [`# ${page.title.split('\n').join(' ')}`];
  const meta = `Kind: \`${page.kind}\` · HTML: ${markdownLink(document.address, document.address)} · JSON: ${markdownLink(document.json, document.json)}`;
  parts.push(meta);
  if (document.trail.length > 0) parts.push(`Trail: ${document.trail.map((entry) => markdownLink(entry.title, entry.url)).join(' › ')}`);
  for (const section of document.sections) {
    const rendered = sectionMarkdown(section);
    if (rendered !== '') parts.push(rendered);
  }
  if (document.findings.length > 0) {
    parts.push(`## Findings\n\n${document.findings.map((finding) => `- ${finding.file}:${finding.line}: ${finding.message}${finding.source === undefined ? '' : ` (${finding.source})`}`).join('\n')}`);
  }
  if (document.notes.length > 0) parts.push(`## Notes\n\n${document.notes.map((note) => `- ${note}`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}

/** The kind's list as the documented JSON document. */
export function kindFileDocument(summary: KindSummary, entries: readonly EntityRef[], language: string, prefix = ''): KindFileDocument {
  const address = at(kindAddress(summary.kind), prefix)!;
  const labels = summary.labels?.[language] ?? summary.labels?.[language === 'ru' ? 'en' : 'ru'];
  const description = summary.descriptions?.[language] ?? summary.descriptions?.[language === 'ru' ? 'en' : 'ru'];
  return {
    schema: KIND_SCHEMA,
    kind: summary.kind,
    title: labels?.many ?? summary.kind,
    ...(description === undefined ? {} : { description }),
    address,
    json: `${address}.json`,
    markdown: `${address}.md`,
    total: entries.length,
    entries: entries.map((entry) => itemOf(entry, prefix)),
  };
}

/** The kind's list as one Markdown document, every entry the list holds. */
export function kindFileMarkdown(document: KindFileDocument): string {
  const parts = [`# ${document.title}`, `Kind: \`${document.kind}\` · HTML: ${markdownLink(document.address, document.address)} · JSON: ${markdownLink(document.json, document.json)}`];
  if (document.description !== undefined) parts.push(document.description);
  parts.push(`${document.total} ${document.total === 1 ? 'entity' : 'entities'}.`);
  if (document.entries.length > 0) parts.push(document.entries.map(itemLine).join('\n'));
  return `${parts.join('\n\n')}\n`;
}

/**
 * The product's `/llms.txt`: its addresses, then every declared kind with the
 * addresses of its list. A kind with no entity is still a kind of the product
 * and is still listed, with its count.
 */
export function llmsText(productName: string, kinds: readonly KindSummary[], language: string, prefix = ''): string {
  const lines = [
    `# ${productName}`,
    `> The product's wiki for agents: every page is served as Markdown and as JSON; every kind's list follows the same addresses.`,
    '## Addresses',
    `- A page as Markdown: \`${prefix}/k/e/<id>.md\``,
    `- A page as JSON: \`${prefix}/k/e/<id>.json\``,
    `- A page as HTML: \`${prefix}/k/e/<id>\``,
    `- A kind's list as Markdown: \`${prefix}/k/kind/<kind>.md\``,
    `- A kind's list as JSON: \`${prefix}/k/kind/<kind>.json\``,
    `- This file: \`${prefix}/llms.txt\``,
    '## Kinds',
  ];
  for (const kind of kinds) {
    const labels = kind.labels?.[language] ?? kind.labels?.[language === 'ru' ? 'en' : 'ru'];
    const description = kind.descriptions?.[language] ?? kind.descriptions?.[language === 'ru' ? 'en' : 'ru'];
    const address = at(kindAddress(kind.kind), prefix)!;
    lines.push(`- [${labels?.many ?? kind.kind}](${address}.md) — [JSON](${address}.json); kind \`${kind.kind}\`${description === undefined ? '' : `: ${description}`}`);
  }
  return `${lines.join('\n')}\n`;
}

export type PageFileFormat = 'markdown' | 'json';

export interface PageFileAddress {
  name: string;
  format: PageFileFormat;
}

/** `.md` or `.json`: the one suffix a file address ends with, stripped once. */
function suffixOf(rest: string): { format: PageFileFormat; name: string; suffix: string } | undefined {
  for (const [suffix, format] of [['.md', 'markdown'], ['.json', 'json']] as const) {
    if (rest.endsWith(suffix)) {
      const name = rest.slice(0, -suffix.length);
      return { format, name, suffix };
    }
  }
  return undefined;
}

/**
 * The entity a `/k/e/<id>.md` or `/k/e/<id>.json` address names. A suffix is
 * stripped once, so an id that itself ends in `.md` stays whole. An address
 * with no name and an address with a broken percent escape are told apart:
 * neither is silently read as a different entity.
 */
export function pageFileAt(pathname: string): PageFileAddress | { message: string } | undefined {
  const base = '/k/e/';
  if (!pathname.startsWith(base)) return undefined;
  const rest = pathname.slice(base.length);
  const suffix = suffixOf(rest);
  if (suffix === undefined) return undefined;
  if (suffix.name === '') return { message: `the address "${pathname}" names no entity: put the entity's id before "${suffix.suffix}"` };
  try {
    return { name: decodeURIComponent(suffix.name), format: suffix.format };
  } catch {
    return { message: `the address "${pathname}" holds a percent escape the server cannot read: ask for the entity by its id` };
  }
}

/** The kind a `/k/kind/<kind>.md` or `/k/kind/<kind>.json` address names. */
export function kindFileAt(pathname: string): PageFileAddress | { message: string } | undefined {
  const base = '/k/kind/';
  if (!pathname.startsWith(base)) return undefined;
  const rest = pathname.slice(base.length);
  const suffix = suffixOf(rest);
  if (suffix === undefined) return undefined;
  if (suffix.name === '') return { message: `the address "${pathname}" names no kind: put the kind's name before "${suffix.suffix}"` };
  try {
    return { name: decodeURIComponent(suffix.name), format: suffix.format };
  } catch {
    return { message: `the address "${pathname}" holds a percent escape the server cannot read: ask for the kind by its name` };
  }
}

/**
 * One knowledge page read for the index (madarch-m38l.8): its identity and
 * front matter, the repositories it was written from (`written-at`), and its
 * statements with their grounds and mentions. A pure function of the file's
 * text; a page that cannot be read is an error naming the file and the line,
 * never a silently smaller index.
 */
import { parse as parseYaml } from 'yaml';
import { byCodePoint } from '../../model/order.js';
import { isFootnoteDefinitionLine, statementsOf, type PageStatement } from '../../writer/sentences.js';
import { splitFrontMatter } from '../markdown.js';

/** The basis of a page in one repository: where the writer read it. */
export interface WrittenAt {
  readonly repository: string;
  readonly commit: string;
  readonly branch?: string;
  readonly origin?: string;
}

export interface IndexedPage {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  /** Repository-relative path of the file. */
  readonly file: string;
  readonly relates: readonly string[];
  readonly sources: readonly string[];
  readonly writtenAt: readonly WrittenAt[];
  readonly producer: string | null;
  readonly statements: readonly PageStatement[];
  /** Entity links of the whole text (statements and connecting lines), `madarch:` removed, sorted. */
  readonly mentions: readonly string[];
  /** SHA-256 of the file's text: the page node's digest. */
  readonly digest: string;
}

export class PageReadError extends Error {
  constructor(readonly file: string, readonly line: number, message: string) {
    super(`${file}:${line}: ${message}`);
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

export function readWrittenAt(value: unknown, file: string): WrittenAt[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PageReadError(file, 2, '"written-at" is a list of { repository, commit, branch, origin }');
  return value.map((entry: unknown, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new PageReadError(file, 2, `written-at[${index}] is a mapping with repository and commit`);
    const record = entry as Record<string, unknown>;
    const repository = text(record['repository']);
    const commit = text(record['commit']);
    if (repository === undefined) throw new PageReadError(file, 2, `written-at[${index}] lacks "repository"`);
    if (commit === undefined || !/^[0-9a-f]{7,64}$/i.test(commit)) throw new PageReadError(file, 2, `written-at[${index}].commit is a commit id, got ${JSON.stringify(record['commit'])}`);
    const branch = text(record['branch']);
    const origin = text(record['origin']);
    return { repository, commit: commit.toLowerCase(), ...(branch === undefined ? {} : { branch }), ...(origin === undefined ? {} : { origin }) };
  });
}

export function readIndexedPage(file: string, source: string, sha256: (text: string) => string, language?: string): IndexedPage {
  const { front, body, bodyLine } = splitFrontMatter(source.replace(/\r\n/g, '\n'));
  if (front === null) throw new PageReadError(file, 1, 'the page has no front matter');
  let raw: unknown;
  try {
    raw = parseYaml(front);
  } catch (error) {
    throw new PageReadError(file, 2, `the front matter is no YAML: ${(error as Error).message.split('\n')[0]}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new PageReadError(file, 2, 'the front matter is a mapping');
  const record = raw as Record<string, unknown>;
  const id = text(record['id']);
  const kind = text(record['kind']);
  if (id === undefined || kind === undefined) throw new PageReadError(file, 2, 'the front matter needs "id" and "kind"');
  const list = (key: string): string[] => {
    const value = record[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new PageReadError(file, 2, `"${key}" is a list of texts`);
    return [...new Set(value as string[])].sort(byCodePoint);
  };
  const statements = statementsOf(body, bodyLine, language);
  const mentions = new Set<string>();
  const prose = body.split('\n').filter((line) => !isFootnoteDefinitionLine(line.trim())).join('\n');
  for (const match of prose.matchAll(/\]\(madarch:((?:[^()\s]|\([^()\s]*\))*)\)/g)) mentions.add(match[1]!);
  return {
    id,
    kind,
    title: text(record['title']) ?? id.slice(id.indexOf(':') + 1),
    file,
    // A question or a correction says what it is `about` where a page says what it `relates` to: the same edge in the index.
    relates: [...new Set([...list('relates'), ...list('about')])].sort(byCodePoint),
    sources: list('sources'),
    writtenAt: readWrittenAt(record['written-at'], file),
    producer: text(record['producer']) ?? null,
    statements,
    mentions: [...mentions].sort(byCodePoint),
    digest: sha256(source),
  };
}

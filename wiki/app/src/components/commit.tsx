/**
 * A commit as a reader meets it: its short hash, a link to its page, and its message, date and author when the section
 * asked for them. The author comes from the commit's own relation, so a row never holds a raw 40-character id.
 */
import type { ReactElement } from 'react';
import { InlineCode } from './ui/inline-content.js';
import { TextLink, Text } from './ui/typography.js';
import { dateOf, shortHash } from './format.js';

/** One commit entity, as a section's query answered it. */
export interface CommitNode {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly label?: unknown;
  readonly hash?: unknown;
  readonly subject?: unknown;
  readonly commitDate?: unknown;
  readonly codeAuthoredOf?: { readonly edges?: readonly { readonly node?: { readonly node?: { readonly label?: unknown } } }[] };
}

/** The author's name a commit answered, when the section asked for it. */
export function authorOf(commit: CommitNode): string | undefined {
  const label = commit.codeAuthoredOf?.edges?.[0]?.node?.node?.label;
  return typeof label === 'string' && label !== '' ? label : undefined;
}

/** Whether the value reads as a commit: its hash is one, or its kind's name ends in the commit the history names. */
export function isCommit(value: unknown): value is CommitNode {
  if (typeof value !== 'object' || value === null) return false;
  const held = value as CommitNode;
  return shortHash(held.hash) !== undefined || (typeof held.subject === 'string' && shortHash(held.label) !== undefined);
}

/**
 * One commit's line: the short hash as the link to its page, then its message, its date and its author.
 * `withAuthor` and `withDate` follow what the query asked for; a section that asked for neither shows the hash alone.
 */
export function CommitLine({ commit, base, open, language, withDate = true, withAuthor = true }: {
  readonly commit: CommitNode;
  readonly base: string;
  readonly open: (path: string) => void;
  readonly language: string;
  readonly withDate?: boolean;
  readonly withAuthor?: boolean;
}): ReactElement {
  const hash = shortHash(commit.hash) ?? shortHash(commit.label) ?? '';
  const id = typeof commit.id === 'string' ? commit.id : undefined;
  const kind = typeof commit.kind === 'string' ? commit.kind : undefined;
  const href = id === undefined || kind === undefined ? undefined : `${base}/e/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
  const subject = typeof commit.subject === 'string' ? commit.subject : '';
  const date = withDate ? dateOf(commit.commitDate, language) : undefined;
  const author = withAuthor ? authorOf(commit) : undefined;
  return (
    <>
      {hash === '' ? null : href === undefined
        ? <Text><InlineCode>{hash}</InlineCode></Text>
        : <TextLink href={href} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); open(href); }}><InlineCode>{hash}</InlineCode></TextLink>}
      {subject === '' ? null : <Text>{` · ${subject}`}</Text>}
      {date === undefined || date === '' ? null : <Text className="text-muted">{` · ${date}`}</Text>}
      {author === undefined || author === '' ? null : <Text className="text-muted">{` · ${author}`}</Text>}
    </>
  );
}

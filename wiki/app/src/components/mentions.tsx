/**
 * Decision 0039 items 5, 6 and 29: the names a page's text leaves without a link. Each one stands with the entities it
 * may mean — a same-named entity of another kind is another candidate, named with its kind («Payments — домен»), never
 * merged into one — and the kit's Button links the one the reader chose, writing the token where the name stood.
 *
 * The same section serves both directions: a page's own unlinked names, and the unlinked names the pages that name this
 * entity hold. A row of the second kind says which page holds it, and its Button links the name in that page's text.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { InlineGroup, ListItem, Metadata, PlainList, Text, TextLink } from './ui/typography.js';
import { entityHref } from './connection.js';
import { LINK_MENTION_MUTATION, postQuery } from '../client.js';
import type { UnlinkedMention } from './command.js';
import type { SectionContext } from './types.js';

const message = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure);

/** One unlinked name: its place in the text, and one Button per candidate it may mean. */
function MentionRow({ mention, kind, uid, pageUid, base, reload, open, busy }: {
  readonly mention: UnlinkedMention;
  readonly kind: string;
  readonly uid: string;
  /** The page the reader is on: a name another page holds says so and links there. */
  readonly pageUid: string;
  readonly base: string;
  readonly reload: () => void;
  readonly open: (path: string) => void;
  readonly busy: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A name another page holds says so, and links there: the reader sees whose text the link changes.
  const holder = mention.uid === '' || mention.uid === pageUid ? undefined : entityHref({ kind: mention.kind, id: mention.uid });
  const link = (entity: string): void => {
    setWorking(entity);
    setError(null);
    const variables = { kind, id: uid, field: mention.field, path: mention.path, start: mention.start, end: mention.end, name: mention.name, entity };
    postQuery<{ linkMention: { text: string } }>(base, LINK_MENTION_MUTATION, variables).then(
      (answer) => {
        setWorking(null);
        if (answer.errors.length > 0) { setError(answer.errors.map((one) => one.message).join('; ')); return; }
        reload();
      },
      (failure: unknown) => { setWorking(null); setError(message(failure)); },
    );
  };
  return (
    <ListItem data-testid="unlinked-mention" data-name={mention.name}>
      <InlineGroup>
        <Text data-testid="unlinked-mention-name">{mention.name}</Text>
        {holder === undefined ? null : (
          <TextLink data-testid="unlinked-mention-page" href={holder} onClick={(event) => { event.preventDefault(); open(holder); }}>
            {mention.label === '' ? mention.kind : mention.label}
          </TextLink>
        )}
        {mention.candidates.map((candidate) => (
          <Button
            key={`${candidate.kind}\u0000${candidate.uid}`}
            variant="outline"
            size="sm"
            disabled={busy || working !== null}
            data-testid="unlinked-mention-link"
            data-kind={candidate.kind}
            onClick={() => { link(candidate.uid); }}
          >
            {candidate.domain === '' ? `${candidate.label} — ${candidate.kindLabel}` : `${candidate.label} — ${candidate.kindLabel} — ${candidate.domain}`}
          </Button>
        ))}
      </InlineGroup>
      {working === null ? null : <Metadata data-testid="unlinked-mention-working">{t('knowledge.mentions.linking')}</Metadata>}
      {error === null ? null : <Metadata data-testid="unlinked-mention-error">{error}</Metadata>}
    </ListItem>
  );
}

export function MentionsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const held = context.data !== null && typeof context.data === 'object' ? context.data as Record<string, unknown> : {};
  const dataPath = typeof context.section.params['path'] === 'string' ? String(context.section.params['path']) : 'unlinkedMentions';
  const mentions = Array.isArray(held[dataPath]) ? held[dataPath] as UnlinkedMention[] : [];
  // A text with no unlinked name draws no section at all: the page hides it, and this guard keeps a stray draw empty.
  if (mentions.length === 0) return <></>;
  const kind = typeof held['kind'] === 'string' ? held['kind'] : '';
  const uid = typeof held['id'] === 'string' ? held['id'] : '';
  return (
    <PlainList data-testid="mentions">
      {mentions.map((mention) => (
        <MentionRow
          key={`${mention.kind}\u0000${mention.uid}\u0000${mention.field}\u0000${mention.path}\u0000${String(mention.start)}`}
          mention={mention}
          kind={mention.kind === '' ? kind : mention.kind}
          uid={mention.uid === '' ? uid : mention.uid}
          pageUid={uid}
          base={context.base}
          busy={context.busy}
          open={context.open}
          reload={() => { context.reload({ ...context.variables }); }}
        />
      ))}
    </PlainList>
  );
}

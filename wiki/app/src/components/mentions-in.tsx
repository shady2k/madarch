/**
 * Decision 0039 item 5: the backlink a token in another page's text creates. The target's page lists every page whose
 * text mentions it — the page, the field the token stands in and the occurrence's place — beside its declared relations.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ListItem, Metadata, Paragraph, PlainList, TextLink } from './ui/typography.js';
import { entityHref } from './connection.js';
import type { SectionContext } from './types.js';

/** One page whose text mentions this entity: where it stands and which field holds the token. */
interface MentionPageRow {
  readonly entity?: { readonly id?: unknown; readonly kind?: unknown; readonly label?: unknown };
  readonly field?: unknown;
}

export function MentionsInSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const held = context.data !== null && typeof context.data === 'object' ? context.data as Record<string, unknown> : {};
  const pages = Array.isArray(held['mentionedIn']) ? held['mentionedIn'] as MentionPageRow[] : [];
  if (pages.length === 0) return <Paragraph data-testid="mentions-in-empty">{t('knowledge.mentions.notMentioned')}</Paragraph>;
  return (
    <PlainList data-testid="mentions-in">
      {pages.map((page, at) => {
        const entity = page.entity ?? {};
        const href = entityHref(entity as Record<string, unknown>);
        const label = typeof entity.label === 'string' ? entity.label : typeof entity.kind === 'string' ? entity.kind : '';
        return (
          <ListItem key={`${String(entity.id)}\u0000${String(page.field)}\u0000${String(at)}`} data-testid="mention-page" data-field={typeof page.field === 'string' ? page.field : ''}>
            {href === undefined ? label : <TextLink href={href} onClick={(event) => { event.preventDefault(); context.open(href); }}>{label}</TextLink>}
            {typeof page.field === 'string' ? <Metadata data-testid="mention-page-field">{page.field}</Metadata> : null}
          </ListItem>
        );
      })}
    </PlainList>
  );
}

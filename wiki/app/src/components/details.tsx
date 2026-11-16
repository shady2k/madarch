/**
 * Every field the graph states of an entity (decision 0036, section 6): the kind's declared fields with the value its
 * sources state, the mark a disputed field wears, and under each value the source that stated it and the place it
 * rests on. A template that names a page's fields narrows this block; a kind with no such template still shows all.
 */
import { Fragment, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { at } from './format.js';
import { formatValue, dateOf } from './format.js';
import { Badge } from './ui/badge.js';
import { InlineCode } from './ui/inline-content.js';
import { InlineGroup, Metadata, Text } from './ui/typography.js';
import { DefinitionList, DefinitionTerm, DefinitionValue, Paragraph } from './ui/typography.js';
import type { SectionContext } from './types.js';

interface DetailAssertion {
  readonly source?: { readonly label?: unknown };
  readonly recordedAt?: unknown;
  readonly selected?: boolean;
  readonly evidence?: unknown;
}

interface DetailRow {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly key?: unknown;
  readonly value?: unknown;
  readonly contested?: unknown;
  readonly assertions?: unknown;
}

export function DetailsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const path = typeof context.section.params['path'] === 'string' ? String(context.section.params['path']) : 'details';
  const held = at(context.data, path);
  const rows = Array.isArray(held) ? held as DetailRow[] : [];
  if (rows.length === 0) {
    return <Paragraph data-testid="details-empty">{t('knowledge.details.empty')}</Paragraph>;
  }
  return (
    <DefinitionList columns data-testid="details">
      {rows.map((row) => {
        const name = typeof row.name === 'string' ? row.name : '';
        const assertions = Array.isArray(row.assertions) ? row.assertions as DetailAssertion[] : [];
        const newest = assertions.find((assertion) => assertion.selected === true);
        return (
          <Fragment key={name}>
            <DefinitionTerm>
              <InlineCode>{name}</InlineCode>
              {row.key === true ? <InlineGroup><Badge data-testid="detail-key">{t('knowledge.details.key')}</Badge></InlineGroup> : null}
              {row.contested === true ? <InlineGroup><Badge variant="solid" data-testid="contested">{t('knowledge.contested')}</Badge></InlineGroup> : null}
            </DefinitionTerm>
            <DefinitionValue data-testid="detail-value">
              {row.value === null || row.value === undefined
                ? <Metadata>{t('knowledge.details.unstated')}</Metadata>
                : <Text data-testid="detail-text">{valueText(row.value, typeof row.type === 'string' ? row.type : 'text', context.language)}</Text>}
              {newest === undefined ? null : <Metadata data-testid="detail-source">{sourceLine(newest, t)}</Metadata>}
            </DefinitionValue>
          </Fragment>
        );
      })}
    </DefinitionList>
  );
}

/** Who stated the value and where it rests: the selected assertion's source and its first place. */
function sourceLine(assertion: DetailAssertion, t: (key: string, options?: Record<string, unknown>) => string): string {
  const producer = typeof assertion.source?.label === 'string' ? assertion.source.label : '';
  const said = producer === '' ? '' : t('knowledge.details.stated', { producer });
  const evidence = Array.isArray(assertion.evidence) ? assertion.evidence as Record<string, unknown>[] : [];
  const place = evidence.length === 0 ? '' : placeOf(evidence[0]!);
  const where = place === '' ? '' : t('knowledge.details.place', { place });
  return [said, where].filter((one) => one !== '').join(' · ');
}

/** The place an assertion rests on, as a reader reads it: a file and its line, a conversation, or an address. */
function placeOf(evidence: Record<string, unknown>): string {
  const target = evidence.target as { readonly label?: unknown } | undefined;
  const locator = evidence['locator'] as { readonly lineStart?: unknown } | undefined;
  const label = typeof target?.label === 'string' ? target.label : '';
  const line = typeof locator?.lineStart === 'number' ? `:${String(locator.lineStart)}` : '';
  return `${label}${line}`;
}

/** A value as a reader reads it: a reference by its kind and the key it names, a list one after another, else its format. */
function valueText(value: unknown, type: string, language: string): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const held = value as Record<string, unknown>;
    if (typeof held['kind'] === 'string' && typeof held['key'] === 'object' && held['key'] !== null) {
      return `${held['kind']} · ${keyText(held['key'], language)}`;
    }
    return formatValue(value, 'text', language);
  }
  if (Array.isArray(value)) return value.map((one) => valueText(one, type === 'json' ? 'text' : type, language)).join(', ');
  if (type === 'integer' || type === 'number') return formatValue(value, 'number', language);
  if (type === 'date' || type === 'datetime' || type === 'timestamp') return dateOf(value, language) ?? formatValue(value, 'text', language);
  return formatValue(value, 'text', language);
}

/** The parts a key names, one after another: a reference's kind and its own key. */
function keyText(key: unknown, language: string): string {
  if (typeof key !== 'object' || key === null) return formatValue(key, 'text', language);
  return Object.entries(key as Record<string, unknown>)
    .map(([, one]) => valueText(one, 'text', language))
    .filter((one) => one !== '')
    .join(' / ');
}

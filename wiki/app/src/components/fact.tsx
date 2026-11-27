/**
 * One fact of a page (madarch-64o5.133): a number or a chart the graph answered about one kind, the ground it rests on,
 * and the way into the kind's catalogue page. The old home's fact cards, drawn from the aggregate a template asks for
 * instead of a stored statement: a fact is the graph's answer to one query, and its ground names the kind, the field the
 * answer grouped by and the records the shown rows do not account for.
 */
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CATALOGUE_KIND, titleIn } from '../../../../src/page-contract/index.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { FactChart } from './ui/fact-chart.js';
import { DefinitionList, DefinitionTerm, DefinitionValue, Paragraph, Stack, TextLink } from './ui/typography.js';
import { at, formatValue } from './format.js';
import { bucketRows, countedRows, rankedValue, type AggregateRow } from './aggregate.js';
import { entityAddress } from '../address.js';
import type { SectionContext } from './types.js';

type RowsAnswer =
  | { readonly measure: 'groupBy' | 'histogram'; readonly rows: readonly AggregateRow[] }
  | { readonly measure: 'topN'; readonly rows: readonly { label: string; value: number | string }[] };

/** The rows of the answer under the section's own data: a group-by's groups, a histogram's buckets or a top-n's ranking. */
function rowsOf(answer: unknown, language: string, t: TFunction): RowsAnswer | undefined {
  const grouped = at(answer, 'groupBy');
  if (Array.isArray(grouped)) {
    const rows = grouped.map((group) => {
      const text = formatValue(at(group, 'key'), 'text', language);
      return { label: text === '' ? '—' : text, value: Number(at(group, 'count') ?? 0) };
    }).filter((row) => Number.isFinite(row.value));
    return { rows: countedRows(rows), measure: 'groupBy' };
  }
  const buckets = at(answer, 'histogram');
  if (Array.isArray(buckets)) return { rows: bucketRows(buckets as Record<string, unknown>[], t), measure: 'histogram' };
  const ranked = at(answer, 'topN');
  if (Array.isArray(ranked)) {
    return {
      rows: ranked.map((one) => {
        const text = formatValue(at(at(one, 'node'), 'label'), 'text', language);
        return { label: text === '' ? '—' : text, value: rankedValue(at(one, 'value'), language) };
      }),
      measure: 'topN',
    };
  }
  return undefined;
}

export function FactSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const language = context.language;
  const kind = typeof context.section.params['kind'] === 'string' ? context.section.params['kind'] : '';
  const display = context.section.params['display'];
  const by = typeof context.section.params.by === 'string' ? context.section.params.by : undefined;
  const title = titleIn(context.section.title, language) ?? kind;
  const declared = context.navigation?.kinds.find((one) => one.kind === kind);
  const count = at(context.data, 'count');
  const total = typeof count === 'number' ? count : undefined;
  const answer = rowsOf(context.data, language, t);
  const written: ReactNode = display === 'number'
    ? <Paragraph data-testid="fact-number">{total === undefined ? t('facts.unavailable') : formatValue(total, 'number', language)}</Paragraph>
    : answer === undefined || answer.rows.length === 0
      ? <Paragraph data-testid="fact-none">{t('facts.noValues')}</Paragraph>
      : <FactChart display={display === 'treemap' || display === 'timeline' ? display : 'bar'} rows={answer.rows} labelTitle={t('facts.label')} valueTitle={t('facts.value')} note={t('facts.noValues')} />;
  const unaccounted = answer !== undefined && answer.measure !== 'topN' && total !== undefined
    ? Math.max(0, total - answer.rows.reduce((sum, row) => sum + row.value, 0))
    : undefined;
  const href = declared === undefined || declared.entryId === null ? undefined : entityAddress(CATALOGUE_KIND, declared.entryId);
  return (
    <Card data-testid="home-fact" data-kind={kind} data-display={String(display)}>
      <CardHeader>
        <CardTitle>
          {href === undefined
            ? title
            : <TextLink href={context.base + href} onClick={(event) => { event.preventDefault(); context.open(href); }}>{title}</TextLink>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Stack>
          {written}
          <Disclosure data-testid="fact-ground">
            <DisclosureSummary>{t('facts.ground')}</DisclosureSummary>
            <DefinitionList columns>
              <DefinitionTerm>{t('facts.kind')}</DefinitionTerm>
              <DefinitionValue>{declared === undefined ? kind : declared.many}</DefinitionValue>
              <DefinitionTerm>{t('facts.measure')}</DefinitionTerm>
              <DefinitionValue data-testid="fact-measure">{t(`facts.measures.${answer?.measure ?? 'count'}`)}</DefinitionValue>
              {by === undefined ? null : <><DefinitionTerm>{t('facts.field')}</DefinitionTerm><DefinitionValue>{by}</DefinitionValue></>}
              {total === undefined ? null : <><DefinitionTerm>{t('facts.total')}</DefinitionTerm><DefinitionValue data-testid="fact-total">{formatValue(total, 'number', language)}</DefinitionValue></>}
              {unaccounted === undefined ? null : <><DefinitionTerm>{t('facts.unaccounted')}</DefinitionTerm><DefinitionValue data-testid="fact-unaccounted">{formatValue(unaccounted, 'number', language)}</DefinitionValue></>}
            </DefinitionList>
          </Disclosure>
        </Stack>
      </CardContent>
    </Card>
  );
}

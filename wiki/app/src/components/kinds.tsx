/**
 * What the graph holds of each kind (decision 0036, section 7): the product's kinds with the number of entities each
 * holds, the fullest first, each row opening the kind's catalogue page. The words and the counts are the graph's, read
 * by the frame's one navigation query — the home page shows the product, not the catalogue.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Paragraph, Text, TextLink } from './ui/typography.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { CATALOGUE_KIND } from '../../../../src/page-contract/index.js';
import { entityAddress } from '../address.js';
import { follow } from './relations.js';
import { formatValue } from './format.js';
import { edgesOf } from './connection.js';
import { at } from './format.js';
import type { SectionContext } from './types.js';

/** One row of the kinds list: its word, what it counts and the catalogue entry its page stands on. */
interface KindRow {
  readonly kind?: unknown;
  readonly many?: unknown;
  readonly count?: unknown;
  readonly entryId?: unknown;
}

export function KindsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  // A kinds section with no query is the frame's navigation (the home's counts): the frame keeps it current while a
  // fill publishes. A section with a query reads the graph's answer under its own alias.
  const fromNavigation = (context.section.query ?? '').trim() === '';
  const rows = (fromNavigation ? (context.navigation?.kinds ?? []) : edgesOf(at(context.data, context.section.params['path'] ?? 'kinds')))
    .map((row) => row as KindRow)
    .filter((row) => typeof row.many === 'string' && Number(row.count) > 0)
    .sort((left, right) => Number(right.count) - Number(left.count) || String(left.many).localeCompare(String(right.many), context.language));
  if (rows.length === 0) return <Paragraph>{t('common.emptyValue')}</Paragraph>;
  return (
    <Table data-testid="kinds">
      <TableHeader>
        <TableRow><TableHead>{t('kinds.name')}</TableHead><TableHead>{t('kinds.count')}</TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, at) => {
          const address = typeof row.entryId === 'string' ? entityAddress(CATALOGUE_KIND, row.entryId) : undefined;
          return (
            <TableRow key={`${String(row.many)}-${String(at)}`} data-changed={context.changedKinds?.has(String(row.kind)) ? 'true' : undefined}>
              <TableCell>
                {address === undefined
                  ? <Text>{String(row.many)}</Text>
                  : <TextLink href={context.base + address} {...follow(context.open, context.base + address)}>{String(row.many)}</TextLink>}
              </TableCell>
              <TableCell>{formatValue(Number(row.count), 'number', context.language)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

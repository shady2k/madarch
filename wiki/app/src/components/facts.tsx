/** A section's labelled values, each read at a dot path (decision 0036, section 7). */
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { titleIn, valueAt } from '../../../../src/page-contract/index.js';
import { Badge } from './ui/badge.js';
import { InlineGroup } from './ui/typography.js';
import { DefinitionList, DefinitionTerm, DefinitionValue, TextLink } from './ui/typography.js';
import { formatValue, hostOf, localized, shortHash } from './format.js';
import { InlineCode } from './ui/inline-content.js';
import { CommitLine, isCommit, type CommitNode } from './commit.js';
import type { SectionContext } from './types.js';

interface FactRow {
  readonly label?: unknown;
  readonly path?: unknown;
  readonly format?: unknown;
  /** A second value the row names beside the first: a commit beside a date, an end date beside a start. */
  readonly then?: { readonly path?: unknown; readonly format?: unknown };
  /** A row whose value is empty is not drawn, unless the template asks for it (`keep: true`). */
  readonly keep?: unknown;
  /** The row's value is the address of the page it names, and the label is the value itself. */
  readonly href?: unknown;
}

/**
 * The facts of a page: the labelled values a template names, each written the way its format says. A value the graph
 * answered nothing for is not drawn (an entity without a removal has no «Удалён» line), a commit is a short hash linked
 * to its page, and a contested field carries the marker the graph's `contested` list names.
 */
export function FactsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const rows = Array.isArray(context.section.params['rows']) ? (context.section.params['rows'] as FactRow[]) : [];
  const contested = Array.isArray(valueAt(context.data, 'contested')) ? (valueAt(context.data, 'contested') as unknown[]).filter((one): one is string => typeof one === 'string') : [];
  const drawn = rows.map((row) => {
    const path = typeof row.path === 'string' ? row.path : '';
    const format = typeof row.format === 'string' ? row.format : 'text';
    const value = valueAt(context.data, path);
    const then = row.then === undefined ? undefined : {
      value: valueAt(context.data, typeof row.then.path === 'string' ? row.then.path : ''),
      format: typeof row.then.format === 'string' ? row.then.format : 'text',
    };
    const empty = (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
      && (then === undefined || then.value === null || then.value === undefined || then.value === '');
    return {
      label: (typeof row.label === 'object' && row.label !== null ? titleIn(row.label as Record<string, string>, context.language) : undefined) ?? '',
      value,
      format,
      then,
      keep: row.keep === true,
      empty,
      disputed: row.keep !== true && contested.includes(path),
    };
  }).filter((row) => !row.empty || row.keep);
  return (
    <DefinitionList columns data-testid="facts">
      {drawn.map((row, at) => (
        <Fragment key={`${row.label}-${String(at)}`}>
          <DefinitionTerm>
            {row.label}
            {row.disputed ? <InlineGroup><Badge variant="solid" data-testid="contested">{t('knowledge.contested')}</Badge></InlineGroup> : null}
          </DefinitionTerm>
          <DefinitionValue data-testid="fact-value">{row.empty ? '—' : factOf(row.value, row.format, row.then, context, t)}</DefinitionValue>
        </Fragment>
      ))}
    </DefinitionList>
  );
}

/** One value written its way: a commit's line, a link, a paragraph of Markdown-less text, or a formatted scalar. */
function factOf(value: unknown, format: string, then: { readonly value: unknown; readonly format: string } | undefined, context: SectionContext, t: (key: string, options?: Record<string, unknown>) => string): ReactNode {
  if (format === 'group') {
    const name = typeof value === 'string' ? value : '';
    const group = context.navigation?.groups.find((one) => one.name === name);
    return group === undefined ? formatValue(name, 'text', context.language) : localized(group.labels, context.language) ?? name;
  }
  if (format === 'purpose') {
    const name = typeof value === 'string' ? value : '';
    const purpose = context.navigation?.purposes.find((one) => one.id === name);
    return purpose === undefined ? formatValue(name, 'text', context.language) : localized(purpose.labels, context.language) ?? name;
  }
  if (format === 'audience') {
    const roles = Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
    return <>{roles.map((role, at) => <Fragment key={role}>{at === 0 ? '' : ', '}{roleWord(role, t)}</Fragment>)}</>;
  }
  if (format === 'commit') return isCommit(value) ? <CommitLine commit={value as CommitNode} base={context.base} open={context.open} language={context.language} /> : '';
  if (format === 'link') return typeof value === 'string' && value !== '' ? <TextLink href={value} rel="noreferrer">{hostOf(value)}</TextLink> : '';
  if (format === 'links') {
    const addresses = Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : [];
    return <>{addresses.map((address, at) => <Fragment key={address}>{at === 0 ? '' : ', '}<TextLink href={address} rel="noreferrer">{hostOf(address)}</TextLink></Fragment>)}</>;
  }
  if (format === 'boolean') return typeof value === 'boolean' ? t(value ? 'knowledge.yes' : 'knowledge.no') : formatValue(value, 'text', context.language);
  if (format === 'hash') {
    const hash = shortHash(value);
    return hash === undefined ? formatValue(value, 'text', context.language) : <InlineCode>{hash}</InlineCode>;
  }
  if (format === 'class') {
    const name = typeof value === 'string' ? value : '';
    return t(`knowledge.class.${name}`, { defaultValue: formatValue(name, 'text', context.language) });
  }
  const written = formatValue(value, format, context.language);
  if (then === undefined) return written;
  const extra = then.format === 'commit' && isCommit(then.value)
    ? <CommitLine commit={then.value as CommitNode} base={context.base} open={context.open} language={context.language} withDate={false} withAuthor={false} />
    : then.format === 'hash' || then.format === 'boolean' || then.format === 'class'
      ? factOf(then.value, then.format, undefined, context, t)
      : formatValue(then.value, then.format, context.language);
  if (written === '') return extra;
  if (extra === '' || extra === null || extra === undefined) return written;
  return <>{written}{' · '}{extra}</>;
}

/** The manifest's word for a role the page reads as, from the interface's own catalogue. */
function roleWord(role: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`knowledge.roles.names.${role}`, { defaultValue: role });
}



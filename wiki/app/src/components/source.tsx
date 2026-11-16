/** A citation: where the graph's statement was read, with its line range (decision 0036, section 7). */
import { decodeCitation } from '../../../../src/page-contract/citation.js';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Metadata, TextLink } from './ui/typography.js';
import { at } from './format.js';
import type { SectionContext } from './types.js';

export function SourceSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const evidence = at(context.data, context.section.params['path']);
  if (evidence === null || evidence === undefined) return <Metadata>{t('common.emptyValue')}</Metadata>;
  const { repository, path, lineStart: start, lineEnd: end } = decodeCitation(evidence, 'wiki/app/src/components/source.tsx:13');
  if (path === null) return <Metadata>{t('common.emptyValue')}</Metadata>;
  const lines = start === null ? '' : end === start ? `:${String(start)}` : `:${String(start)}-${String(end)}`;
  const query = new URLSearchParams();
  if (repository !== null) query.set('repo', repository);
  query.set('path', path);
  return <Metadata><TextLink href={`${context.base}/api/source?${query.toString()}`}>{`${repository === null ? '' : `${repository}: `}${path}${lines}`}</TextLink></Metadata>;
}

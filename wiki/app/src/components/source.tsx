/** A citation: where the graph's statement was read, with its line range (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { Link, Muted } from './ui/typography.js';
import { at } from './format.js';
import type { SectionContext } from './types.js';

export function SourceSection({ context }: { readonly context: SectionContext }): ReactElement {
  const evidence = at(context.data, context.section.params['path']);
  if (typeof evidence !== 'object' || evidence === null) return <Muted>—</Muted>;
  const held = evidence as Record<string, unknown>;
  const repository = typeof held['repository'] === 'string' ? held['repository'] : undefined;
  const path = typeof held['path'] === 'string' ? held['path'] : undefined;
  if (path === undefined) return <Muted>—</Muted>;
  const start = typeof held['lineStart'] === 'number' ? held['lineStart'] : undefined;
  const end = typeof held['lineEnd'] === 'number' ? held['lineEnd'] : undefined;
  const lines = start === undefined ? '' : end === undefined || end === start ? `:${String(start)}` : `:${String(start)}-${String(end)}`;
  const query = new URLSearchParams();
  if (repository !== undefined) query.set('repo', repository);
  query.set('path', path);
  return <Muted><Link href={`${context.base}/api/source?${query.toString()}`}>{`${repository === undefined ? '' : `${repository}: `}${path}${lines}`}</Link></Muted>;
}

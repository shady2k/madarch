/** One entity's relations, each row naming the relation and the entity at its other end (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { titleIn } from '../../../../src/page-contract/index.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Paragraph, TextLink } from './ui/typography.js';
import { relationLabel } from '../../../../src/knowledge/relation-labels.js';
import { at, localized } from './format.js';
import { entityHref, edgesOf } from './connection.js';
import type { SectionContext } from './types.js';

export function RelationsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const connection = at(context.data, context.section.params['path']);
  const labelPath = typeof context.section.params['labelPath'] === 'string' ? context.section.params['labelPath'] : 'relation';
  const edges = edgesOf(connection);
  if (edges.length === 0) return <Paragraph data-testid="relations-empty">{localized(context.section.params['emptyText'], context.language) ?? titleIn(context.section.title, context.language) ?? ''}</Paragraph>;
  return (
    <Table data-testid="relations">
      <TableHeader>
        <TableRow>
          <TableHead>{titleIn(context.section.title, context.language) ?? ''}</TableHead>
          <TableHead>{''}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {edges.map((edge, at2) => {
          const node = (edge['node'] ?? {}) as Record<string, unknown>;
          const other = (node['from'] ?? node['to']) as Record<string, unknown> | undefined;
          const href = other === undefined ? undefined : entityHref(other);
          return (
            <TableRow key={String(at2)}>
              <TableCell>{localized(node[labelPath], context.language) ?? relationWord(node[labelPath], context.language)}</TableCell>
              <TableCell>{href === undefined ? '' : <TextLink href={context.base + href} onClick={follow(context.open, context.base + href)}>{String(other?.['label'] ?? '') || href}</TextLink>}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The relation's own word: the wiki's labels for the catalogue's relations, and the readable spelling of any other. */
function relationWord(value: unknown, language: string): string {
  return typeof value === 'string' ? relationLabel(value, language) : '';
}

/** A press on a link walks to the page it names; a modified press leaves the browser alone. */
export function follow(open: (path: string) => void, address: string) {
  return (event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(address);
  };
}

/**
 * One entity's relations (decision 0036, section 3 and 7): the rows the graph answered, grouped by the relation they were
 * read through, each group naming the relation in the direction it was read («Содержится в», «Изменён коммитами») and
 * saying how many rows it holds. A commit is drawn as a short hash, its message, its date and its author; everything
 * else as the label of the entity at the other end, linked to its page.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { titleIn } from '../../../../src/page-contract/index.js';
import { relationWords } from '../../../../src/knowledge/relation-labels.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Metadata, Paragraph, SectionTitle, TextLink } from './ui/typography.js';
import { at, localized } from './format.js';
import { CommitLine, isCommit, type CommitNode } from './commit.js';
import { entityHref, edgesOf } from './connection.js';
import type { SectionContext } from './types.js';

interface RelationRow {
  readonly relation?: unknown;
  readonly edge?: unknown;
  readonly inverse?: unknown;
  readonly node?: unknown;
}

interface RelationGroup {
  readonly key: string;
  readonly word: string;
  readonly rows: RelationRow[];
  /** How many rows the relation holds, when the answer states a count beside its page. */
  readonly total?: number;
}

export function RelationsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const connection = at(context.data, context.section.params['path']);
  const labelPath = typeof context.section.params['labelPath'] === 'string' ? context.section.params['labelPath'] : 'relation';
  // A section that asks one relation of its own (`related`) names the edge it read; a backlinks section reads them all.
  const named = typeof context.section.params['edge'] === 'string' ? String(context.section.params['edge']) : undefined;
  const groups = named === undefined
    ? groupOf(edgesOf(connection), context.language)
    : [{
        key: `${named}\u0000${context.section.params['inverse'] === true ? 'in' : 'out'}`,
        word: relationWords(named, context.language, context.section.params['inverse'] === true),
        rows: uniqueRows(edgesOf(connection)),
        total: uniqueRows(edgesOf(connection)).length,
      }];
  if (groups.length === 0) {
    return <Paragraph data-testid="relations-empty">{localized(context.section.params['emptyText'], context.language) ?? titleIn(context.section.title, context.language) ?? t('knowledge.linksHere')}</Paragraph>;
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} data-testid="relation-group" data-relation={group.key}>
          <SectionTitle>{`${group.word} · ${String(group.total ?? group.rows.length)}`}</SectionTitle>
          <Table>
            <TableHeader>
              <TableRow><TableHead>{''}</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {group.rows.map((row, at2) => (
                <TableRow key={`${group.key}-${String(at2)}`}><TableCell>{otherOf(row, labelPath, context)}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
    </>
  );
}

/** One row per entity: a relation may repeat between the same ends (two imports on two lines), and a reader sees the file once. */
function uniqueRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const held = (row['node'] ?? {}) as Record<string, unknown>;
    const node = (held['from'] ?? held['to'] ?? held) as Record<string, unknown>;
    const id = typeof (node as Record<string, unknown>)['id'] === 'string' ? String((node as Record<string, unknown>)['id']) : JSON.stringify(node);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The rows of one connection, grouped by the relation they were read through, the fullest group first. */
function groupOf(rows: readonly Record<string, unknown>[], language: string): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  for (const held of rows) {
    const row = held as RelationRow;
    const node = (row.node ?? {}) as Record<string, unknown>;
    const edge = typeof row.edge === 'string' ? row.edge : typeof node['relation'] === 'string' ? node['relation'] : '';
    const inverse = row.inverse === true;
    const key = `${edge}\u0000${inverse ? 'in' : 'out'}`;
    const heldGroup = groups.get(key) ?? { key, word: relationWords(edge, language, inverse), rows: [] };
    heldGroup.rows.push(row);
    groups.set(key, heldGroup);
  }
  return [...groups.values()].sort((left, right) => right.rows.length - left.rows.length || (left.word < right.word ? -1 : 1));
}

/** The entity at the other end of one row, linked, or the commit's own line when the row is one. */
function otherOf(row: RelationRow, labelPath: string, context: SectionContext): ReactElement {
  const node = (row.node ?? {}) as Record<string, unknown>;
  // A `related` section's row is the entity itself; a backlinks row names its other end (`from`/`to`).
  const other = (node['from'] ?? node['to'] ?? node) as Record<string, unknown>;
  if (isCommit(other)) {
    return <CommitLine commit={other as CommitNode} base={context.base} open={context.open} language={context.language} />;
  }
  const href = entityHref(other);
  const label = String(other['label'] ?? '') || (href ?? '');
  const relationWord = localized(node[labelPath], context.language);
  return href === undefined
    ? <Metadata>{relationWord ?? label}</Metadata>
    : <TextLink href={context.base + href} onClick={follow(context.open, context.base + href)}>{label}</TextLink>;
}

/** A press on a link walks to the page it names; a modified press leaves the browser alone. */
export function follow(open: (path: string) => void, address: string) {
  return (event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(address);
  };
}

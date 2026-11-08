/**
 * What the static stages' graph drafts hold, read back by the tests: the three
 * stages write `node` and `edge` writes (decision 0033), and a test that asks
 * "which file, which symbol, which import" reads those writes rather than a
 * fact store. The shapes here are the read rows the stages' own plans consume,
 * so a test can answer a plan from what the stages wrote.
 */
import type { StageDraftWrite } from '../src/fill/stage.js';
import type { PublishedContainmentRow } from '../src/fill/stages/inventory.js';
import type { PublishedCoverageRow } from '../src/fill/stages/syntax.js';
import type { PublishedTreeRow } from '../src/fill/stages/tree-rows.js';

/** One graph item a draft holds, with the fact kind and the provenance the node carries. */
export interface DraftItem {
  readonly kind: string;
  readonly id: string;
  readonly value: Record<string, unknown>;
  readonly provenance: {
    readonly repository: { readonly id: string; readonly commit: string };
    readonly place?: { readonly file: string; readonly range: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number } };
  };
}

/** The graph items one draft set holds, in the order they were written. */
export function itemsOf(writes: readonly StageDraftWrite[]): readonly DraftItem[] {
  const items: DraftItem[] = [];
  for (const write of writes) {
    if (write.kind === 'node') {
      const value = write.value.properties as Record<string, unknown>;
      items.push({ kind: String(value['factKind']), id: write.value.key, value, provenance: value['provenance'] as DraftItem['provenance'] });
      continue;
    }
    if (write.kind === 'edge') {
      const value = (write.value.properties ?? {}) as Record<string, unknown>;
      items.push({ kind: String(value['factKind']), id: String(value['recordKey'] ?? ''), value, provenance: value['provenance'] as DraftItem['provenance'] });
    }
  }
  return items;
}

/** The items of one fact kind, in the order they were written. */
export function itemsOfKind(writes: readonly StageDraftWrite[], kind: string): readonly DraftItem[] {
  return itemsOf(writes).filter((item) => item.kind === kind);
}

/** The node drafts of one graph kind (`code.file`), in the order they were written. */
export function nodesOfKind(writes: readonly StageDraftWrite[], kind: string): readonly { readonly key: string; readonly kind: string; readonly label: string; readonly properties: Record<string, unknown> }[] {
  return writes.filter((write) => write.kind === 'node' && write.value.kind === kind).map((write) => (write as Extract<StageDraftWrite, { kind: 'node' }>).value as { key: string; kind: string; label: string; properties: Record<string, unknown> });
}

/** The edge drafts of one relation, in the order they were written. */
export function edgesOfRelation(writes: readonly StageDraftWrite[], relation: string): readonly { readonly relation: string; readonly from: { readonly key: string } | { readonly id: string }; readonly to: { readonly key: string } | { readonly id: string }; readonly properties?: Record<string, unknown>; readonly position?: { readonly start: number; readonly end: number } }[] {
  return writes.filter((write) => write.kind === 'edge' && write.value.relation === relation).map((write) => (write as Extract<StageDraftWrite, { kind: 'edge' }>).value);
}

/** The rows the inventory's plan would read back from what the snapshot and inventory stages wrote. */
export function treeRowsOf(writes: readonly StageDraftWrite[], repository: string): readonly PublishedTreeRow[] {
  const rows: PublishedTreeRow[] = [];
  for (const node of nodesOfKind(writes, 'code.file')) {
    const blob = node.properties['blob'];
    rows.push({ kind: 'file', repository, path: String(node.properties['path']), ...(typeof blob === 'string' ? { blob } : {}) });
  }
  for (const node of nodesOfKind(writes, 'code.directory')) {
    rows.push({ kind: 'directory', repository, path: String(node.properties['path']) });
  }
  return rows;
}

/** The containment rows the inventory's plan would read back from what the snapshot and inventory stages wrote. */
export function containmentRowsOf(writes: readonly StageDraftWrite[], repository: string): readonly PublishedContainmentRow[] {
  const pathByKey = new Map<string, string>();
  for (const write of writes) {
    if (write.kind !== 'node') continue;
    if (write.value.kind === 'code.file' || write.value.kind === 'code.directory') pathByKey.set(write.value.key, String(write.value.properties['path']));
    if (write.value.kind === 'code.repository') pathByKey.set(write.value.key, '');
  }
  const rows: PublishedContainmentRow[] = [];
  for (const write of writes) {
    if (write.kind !== 'edge' || write.value.relation !== 'code.contains') continue;
    if (write.value.properties?.['factKind'] !== 'contains') continue;
    const from = 'key' in write.value.from ? pathByKey.get(write.value.from.key) : undefined;
    const to = 'key' in write.value.to ? pathByKey.get(write.value.to.key) : undefined;
    if (from === undefined || to === undefined) continue;
    const child = write.value.properties?.['childKind'] === 'directory' ? 'directory' : 'file';
    rows.push({ kind: 'contains', child, from, to });
  }
  return rows;
}

/** The coverage rows the syntax plan reads back: one row per file the stage read, at its blob. */
export function coverageRowsOf(writes: readonly StageDraftWrite[], repository: string): readonly PublishedCoverageRow[] {
  return nodesOfKind(writes, 'code.coverage')
    .filter((node) => typeof node.properties['blob'] === 'string')
    .map((node) => ({ kind: 'coverage' as const, file: String(node.properties['scope']), blob: String(node.properties['blob']) }));
}

/** The gap rows the syntax plan reads back. */
export function gapRowsOf(writes: readonly StageDraftWrite[]): readonly { readonly kind: 'coverage'; readonly file: string; readonly what: string }[] {
  const rows: { kind: 'coverage'; file: string; what: string }[] = [];
  for (const node of nodesOfKind(writes, 'code.coverage')) {
    if (node.properties['unfiledPath'] === true) continue;
    const unread = (node.properties['unread'] as readonly { readonly what: string }[] | undefined) ?? [];
    for (const gap of unread) rows.push({ kind: 'coverage', file: String(node.properties['scope']), what: gap.what });
  }
  return rows;
}

/** The import rows the syntax plan reads back. */
export function importRowsOf(writes: readonly StageDraftWrite[]): readonly { readonly kind: 'import'; readonly from: string; readonly to: string; readonly specifier: string }[] {
  return edgesOfRelation(writes, 'code.imports').map((edge) => ({
    kind: 'import' as const,
    from: String(edge.properties?.['from']),
    to: String(edge.properties?.['to']),
    specifier: String(edge.properties?.['specifier']),
  }));
}

/** The file node key a path stands at in a draft set, refused where the draft holds none. */
function fileKeyOf(writes: readonly StageDraftWrite[], path: string): string {
  const held = nodesOfKind(writes, 'code.file').filter((node) => node.properties['path'] === path);
  if (held.length !== 1) throw new Error(`the draft holds ${String(held.length)} code.file nodes for ${path}, and this test needs exactly one`);
  return held[0]!.key;
}

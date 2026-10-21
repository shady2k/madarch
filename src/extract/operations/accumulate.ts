/**
 * The accumulator every area extractor of this folder writes into: nodes and
 * edges keyed by their logical identity, deduplicated on arrival, plus the
 * gaps for what could not be read. Shared end nodes (files, ports) are made
 * here once, so parallel areas never duplicate them.
 */
import type { ExtractionGap, ExtractedEdge, ExtractedNode, PropertyValue, SchemaKey, SourceSpan } from '../records.js';
import { byCodePoint } from '../../model/order.js';

export class Records {
  readonly nodes: ExtractedNode[] = [];
  readonly edges: ExtractedEdge[] = [];
  readonly gaps: ExtractionGap[] = [];

  private readonly held = new Set<string>();

  /** Adds one node unless its key is held already; the first declaration stands. */
  add(node: ExtractedNode): void {
    if (this.held.has(node.key)) return;
    this.held.add(node.key);
    this.nodes.push(node);
  }

  /** Adds one edge keyed by its type, ends and discriminator; the first declaration stands. */
  edge(type: SchemaKey, from: string, to: string, properties: { readonly [key: string]: PropertyValue } = {}, span?: SourceSpan, discriminator = ''): void {
    const key = `${type}\u0000${from}\u0000${to}\u0000${discriminator}`;
    if (this.held.has(key)) return;
    this.held.add(key);
    this.edges.push({ type, from, to, discriminator, properties, span });
  }

  /** Names what could not be read: the path, why. Never a silence. */
  gap(path: string, reason: string): void {
    const key = `${path}\u0000${reason}`;
    if (this.held.has(key)) return;
    this.held.add(key);
    this.gaps.push({ path, reason });
  }

  /** The key of the port node of one service, made on first use. */
  port(service: string, port: number): string {
    const key = `code.port:${service}/${port}`;
    this.add({
      key,
      kind: 'code.port',
      label: String(port),
      properties: { port, service },
      span: undefined,
    });
    return key;
  }

  /** The key of the file node of one repository path, made on first use. */
  file(path: string): string {
    const key = `code.file:${path}`;
    this.add({
      key,
      kind: 'code.file',
      label: path.slice(path.lastIndexOf('/') + 1),
      properties: { path },
      span: undefined,
    });
    return key;
  }
}

/** The extraction's nodes, in code point order of their keys. */
export function sortedNodes(nodes: readonly ExtractedNode[]): ExtractedNode[] {
  return [...nodes].sort((left, right) => byCodePoint(left.key, right.key));
}

/** The extraction's edges, in code point order of type, ends and discriminator. */
export function sortedEdges(edges: readonly ExtractedEdge[]): ExtractedEdge[] {
  return [...edges].sort((left, right) =>
    byCodePoint(left.type, right.type) || byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.discriminator, right.discriminator),
  );
}

/** The extraction's gaps, in code point order of path and reason. */
export function sortedGaps(gaps: readonly ExtractionGap[]): ExtractionGap[] {
  return [...gaps].sort((left, right) => byCodePoint(left.path, right.path) || byCodePoint(left.reason, right.reason));
}

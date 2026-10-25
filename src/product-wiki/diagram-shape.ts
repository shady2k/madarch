/**
 * What the three diagram renderers (Mermaid, LikeC4, archify) read of a diagram: its elements, its arrows and nothing
 * about where they came from. The registry-free fact-store models (`src/fill/diagrams.ts`) satisfy it as they are, and
 * the knowledge wiki's views (`src/knowledge/views.ts`) are written to it, so one renderer draws both and a diagram
 * carries the same solid and dashed lines wherever it is drawn (decision 0026, "Diagrams").
 */
import type { DiagramColumn, DiagramPlace } from '../fill/diagrams.js';

/** One element of a renderable diagram. */
export interface ShapeElement {
  readonly id: string;
  /** The look of the element: a kind the renderers style, or null for an end the graph does not hold. */
  readonly kind: string | null;
  readonly label: string;
  /** Drawn dashed: an assumption, or an end the graph does not hold. */
  readonly dashed: boolean;
  readonly page?: { readonly id: string; readonly href: string };
  readonly place?: DiagramPlace;
  readonly columns?: readonly DiagramColumn[];
  /** One more line under the name (LikeC4 draws one): a technology, a count. */
  readonly detail?: string;
  /** The element that holds this one (a compose file around its services); drawn as a frame around its members. */
  readonly parent?: string;
}

/** One arrow of a renderable diagram. */
export interface ShapeEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly dashed: boolean;
  /** A sequence's place in the scenario, 1-based. */
  readonly step?: number;
}

/** A diagram as the renderers read it. */
export interface ShapeDiagram {
  /** `sequence` is drawn as a sequence diagram, every other type as boxes and arrows. */
  readonly type: string;
  readonly title: string;
  readonly elements: readonly ShapeElement[];
  readonly edges: readonly ShapeEdge[];
}

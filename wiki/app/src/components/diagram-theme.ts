/**
 * The diagram palette, read from the kit's tokens of the current scheme (madarch-64o5.96): every renderer draws its
 * canvas, node fill, node border, label text and edges from these values, so a diagram reads on the page it stands on in
 * both schemes. `getComputedStyle` resolves the tokens' variables to colours, so what is handed to a renderer or to an
 * archify frame is a concrete colour, never a var() the other document could not read.
 */
export interface DiagramTheme {
  /** The scheme the palette was read in: an archify frame paints itself in it. */
  readonly scheme: 'light' | 'dark';
  readonly canvas: string;
  readonly nodeFill: string;
  readonly nodeBorder: string;
  readonly nodeText: string;
  readonly edge: string;
  readonly edgeLabelBg: string;
  readonly edgeLabelText: string;
  /** The page's own entity: its fill and border stand out from its neighbours. */
  readonly focusFill: string;
  readonly focusBorder: string;
}

/** The tokens the palette is read from, in one place. */
export const DIAGRAM_TOKENS = {
  canvas: '--surface-page',
  nodeFill: '--surface-active',
  nodeBorder: '--border',
  nodeText: '--text',
  edge: '--text-muted',
  edgeLabelBg: '--surface-card',
  edgeLabelText: '--text',
  focusFill: '--surface-soft',
  focusBorder: '--text',
} as const;

/** One token's computed value on the document's root. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The palette of the scheme on screen. */
export function readDiagramTheme(): DiagramTheme {
  return {
    scheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    canvas: token(DIAGRAM_TOKENS.canvas),
    nodeFill: token(DIAGRAM_TOKENS.nodeFill),
    nodeBorder: token(DIAGRAM_TOKENS.nodeBorder),
    nodeText: token(DIAGRAM_TOKENS.nodeText),
    edge: token(DIAGRAM_TOKENS.edge),
    edgeLabelBg: token(DIAGRAM_TOKENS.edgeLabelBg),
    edgeLabelText: token(DIAGRAM_TOKENS.edgeLabelText),
    focusFill: token(DIAGRAM_TOKENS.focusFill),
    focusBorder: token(DIAGRAM_TOKENS.focusBorder),
  };
}

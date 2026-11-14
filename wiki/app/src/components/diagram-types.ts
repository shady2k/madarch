/** The three answers one diagram section draws: each the server's own rendering of the same picture. */
export interface LikeC4Answer {
  readonly format: 'likec4';
  readonly entity: { readonly id: string; readonly kind: string; readonly label: string };
  readonly depth: number;
  readonly folded: number;
  readonly truncated: boolean;
  readonly workspace: string;
  readonly view: unknown;
  readonly links: Readonly<Record<string, string>>;
}

export interface MermaidAnswer {
  readonly format: 'mermaid';
  readonly entity: { readonly id: string; readonly kind: string; readonly label: string };
  readonly depth: number;
  readonly folded: number;
  readonly truncated: boolean;
  readonly source: string;
}

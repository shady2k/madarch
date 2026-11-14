/**
 * What a change reaches, as a task or an answer states it (madarch-m38l.14): the statements a ground reaches, the pages
 * that link them, and the places the grounds name. The shape is kept — task proposals and problem tasks state it — and the
 * read that computed it went with the page layer (decision 0036, section 8): a reader asks the graph through `/graphql`.
 */

/** One statement a change reaches: where it stands, what it says and the ground that reached it. */
export interface ImpactedStatement {
  readonly page: string;
  readonly pageTitle: string;
  readonly pageKind: string;
  readonly file: string;
  readonly line: number;
  /** The statement's name on its page (its first footnote's name): what a correction and a scope name it by. */
  readonly statement: string;
  readonly text: string;
  /** The first ground, in code-point order, that reached the statement: what a reader sees named. */
  readonly ground: string;
  /** Every ground that reached the statement: a sentence may stand on more than one of them. */
  readonly grounds: readonly string[];
  readonly how: 'grounds' | 'mentions';
}

/** One page a change reaches: every page a reached statement stands on, then every page linking one. */
export interface ImpactedPage {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly kind: string;
  readonly because: 'statement' | 'link';
}

export interface TaskImpact {
  /** A ground the graph answers nothing for: the index may not have been published yet, and the list may be shorter. */
  readonly unindexed: readonly string[];
  /** The grounds the impact was computed from, de-duplicated, in code-point order. */
  readonly grounds: readonly string[];
  readonly pages: readonly ImpactedPage[];
  /** The product's own pages among `pages`: exactly the pages the writer may rewrite. */
  readonly writable: readonly string[];
  /** The grounds that name a code or a document place: the nodes a planned change is marked on. */
  readonly entities: readonly string[];
  readonly statements: readonly ImpactedStatement[];
  readonly counts: { readonly pages: number; readonly statements: number };
}

/** Structured page opinions published by product plugins. No page text is parsed by the wiki. */
export interface PageStatement {
  readonly id: string;
  readonly labels: readonly string[];
  readonly text: string;
  readonly paragraph?: string;
  readonly digest: string;
  readonly line: number;
  readonly mentions: readonly string[];
  readonly grounds: readonly string[];
}

/** The basis of a page in one repository: where the writer read it. */
export interface WrittenAt {
  readonly repository: string;
  readonly commit: string;
  readonly branch?: string;
  readonly origin?: string;
}

export interface IndexedPage {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  /** Repository-relative path of the file. */
  readonly file: string;
  readonly relates: readonly string[];
  readonly sources: readonly string[];
  readonly writtenAt: readonly WrittenAt[];
  readonly producer: string | null;
  readonly statements: readonly PageStatement[];
  /** Entity links of the whole text (statements and connecting lines), `madarch:` removed, sorted. */
  readonly mentions: readonly string[];
  /** SHA-256 of the file's text: the page node's digest. */
  readonly digest: string;
}

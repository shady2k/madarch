/** The index's vocabulary in the graph (product namespace; the engine's `engine:` and `code.` keys are untouched). */
export const PAGE_KIND = 'knowledge:page';
export const STATEMENT_KIND = 'knowledge:statement';
export const SECTION_KIND = 'knowledge:section';
export const PRODUCT_KIND = 'knowledge:product';

export const STATEMENT_OF = 'knowledge:statement-of';
export const GROUNDED_BY = 'knowledge:grounded-by';
export const MENTIONS = 'knowledge:mentions';
export const RELATES = 'knowledge:relates';

export const INDEX_PRODUCER = 'knowledge.index';

export const INDEX_VOCABULARY = {
  kinds: [PAGE_KIND, PRODUCT_KIND, SECTION_KIND, STATEMENT_KIND],
  relations: [{ key: GROUNDED_BY }, { key: MENTIONS }, { key: RELATES }, { key: STATEMENT_OF }],
} as const;

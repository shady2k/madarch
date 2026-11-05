/** The producer id the driver's own records carry. */
export const DRIVER_PRODUCER = 'code.extract.driver';

/**
 * The driver's own vocabulary, as data (decisions 0028 and 0033, item 7): the repository node and the file
 * listing every fill publishes from one commit, the file facets the driver derives, and the relations it
 * reads between the extractors' records and the routes they name.
 */

export const KIND_REPOSITORY = 'code.repository';
export const KIND_DOCUMENT_SECTION = 'code.document-section';
export const KIND_FACET = 'code.facet';

export const REL_CONTAINS = 'code.contains';
export const REL_OCCURRENCE = 'code.occurrence';
export const REL_FACET_OF = 'code.facet-of';
export const REL_DESCRIBES_FILE = 'code.describes-file';
export const REL_PROBES = 'code.probes';
export const REL_SERVED_BY = 'code.served-by';

/** Every node kind the driver itself emits, declared as data the code names and the mapping ties (0033, item 7). */
export const DRIVER_NODE_KINDS = [KIND_REPOSITORY, 'code.directory', 'code.file', KIND_DOCUMENT_SECTION, KIND_FACET] as const;

/** Every relation type the driver itself emits, declared as data the code names and the mapping ties (0033, item 7). */
export const DRIVER_EDGE_TYPES = [REL_CONTAINS, REL_OCCURRENCE, REL_FACET_OF, REL_DESCRIBES_FILE, REL_PROBES, REL_SERVED_BY] as const;

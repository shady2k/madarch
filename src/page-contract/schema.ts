/**
 * The page contract as data (decision 0036, section 9): the JSON Schema of a template file (section 6) and of every
 * component's parameters (section 7). One module holds both sides of the mechanism: the server validates a product's
 * templates against it before it serves, and the app reads the same declarations to compose a page and draw a section.
 *
 * A schema here is plain JSON Schema (draft 2020-12), limited to the keywords `validateAgainst` reads: `type`,
 * `required`, `properties`, `additionalProperties`, `items`, `enum`, `pattern`, `minItems`, `minProperties`,
 * `oneOf`. Kept to that set so a template's finding can name the line a YAML node stands on, the validator walks the
 * YAML document itself rather than the value it parses to.
 */

/** A text a template states in the interface languages: `{ en: Facts, ru: Факты }`. */
export const LOCALIZED_TEXT_SCHEMA = {
  type: 'object',
  minProperties: 1,
  properties: { en: { type: 'string' }, ru: { type: 'string' } },
  additionalProperties: { type: 'string' },
} as const;

/** The components the app draws today. A template naming anything else is refused. */
export const COMPONENT_NAMES = [
  'header', 'facts', 'text', 'relations', 'table', 'bars', 'diagram', 'source', 'tabs', 'search', 'kinds', 'catalogue',
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

const FORMATS = ['text', 'number', 'date', 'bytes', 'link', 'links', 'commit', 'hash', 'boolean', 'group', 'purpose', 'audience', 'class', 'repository'] as const;
const OPERATORS = ['_eq', '_neq', '_in', '_nin', '_contains', '_like', '_lt', '_lte', '_gt', '_gte', '_is_null'] as const;

/**
 * One section's parameters, by component (section 7). Every parameter is optional unless the list of required names
 * holds it; a text parameter is `{ en, ru }`, and `path` is a dot path into the section's data (a number stands for
 * an index, `.` or the empty string for the section's own data).
 */
export const COMPONENT_SCHEMAS: Readonly<Record<ComponentName, { readonly parameters: Record<string, unknown>; readonly required: readonly string[] }>> = {
  header: {
    parameters: {
      titlePath: { type: 'string' },
      kindPath: { type: 'string' },
      provenancePath: { type: 'string' },
      /** The way up: the field holding the repository and the field holding the path, whose folders the trail names. */
      trail: {
        type: 'object',
        additionalProperties: false,
        properties: { repository: { type: 'string' }, path: { type: 'string' } },
      },
    },
    required: ['titlePath'],
  },
  facts: {
    parameters: {
      rows: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['label', 'path'],
          additionalProperties: false,
          properties: {
            label: LOCALIZED_TEXT_SCHEMA,
            path: { type: 'string' },
            format: { type: 'string', enum: FORMATS },
            /** A value drawn beside the first: a commit beside its date, an end date beside a start. */
            then: {
              type: 'object',
              required: ['path'],
              additionalProperties: false,
              properties: { path: { type: 'string' }, format: { type: 'string', enum: FORMATS } },
            },
            /** Keep the row when its value is empty, drawn as a dash. */
            keep: { type: 'boolean' },
          },
        },
      },
    },
    required: ['rows'],
  },
  text: { parameters: { path: { type: 'string' } }, required: ['path'] },
  relations: {
    parameters: {
      path: { type: 'string' },
      labelPath: { type: 'string' },
      emptyText: LOCALIZED_TEXT_SCHEMA,
      /** A section that asks one relation of its own names the edge and the direction it was read in. */
      edge: { type: 'string' },
      inverse: { type: 'boolean' },
      /** How many rows a relation shows on one page, when its query pages through `$<section>_first`. */
      pageSize: { type: 'integer' },
    },
    required: ['path'],
  },
  table: {
    parameters: {
      path: { type: 'string' },
      columns: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['label', 'path'],
          additionalProperties: false,
          properties: {
            label: LOCALIZED_TEXT_SCHEMA,
            path: { type: 'string' },
            format: { type: 'string', enum: FORMATS },
            sortField: { type: 'string' },
          },
        },
      },
      filterFields: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'field'],
          additionalProperties: false,
          properties: {
            label: LOCALIZED_TEXT_SCHEMA,
            field: { type: 'string' },
            operator: { type: 'string', enum: OPERATORS },
          },
        },
      },
      pageSize: { type: 'integer' },
      emptyText: LOCALIZED_TEXT_SCHEMA,
    },
    required: ['path', 'columns'],
  },
  bars: {
    parameters: {
      path: { type: 'string' },
      labelPath: { type: 'string' },
      valuePath: { type: 'string' },
      /** The rows are a histogram's buckets, each named by the days it covers. */
      buckets: { type: 'boolean' },
      display: { type: 'string', enum: ['bar', 'treemap', 'timeline'] },
    },
    required: ['path'],
  },
  diagram: { parameters: { depth: { type: 'integer' }, aggregateAbove: { type: 'integer' } }, required: [] },
  source: { parameters: { path: { type: 'string' } }, required: ['path'] },
  tabs: {
    parameters: {
      sections: { type: 'array', items: { type: 'string' } },
      /** A tab that holds several sections: the overview a page opens with, and its picture. */
      groups: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['title', 'sections'],
          additionalProperties: false,
          properties: {
            title: LOCALIZED_TEXT_SCHEMA,
            sections: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
        },
      },
    },
    required: [],
  },
  search: { parameters: { kinds: { type: 'array', items: { type: 'string' } } }, required: [] },
  /** What the graph holds of each kind, the fullest first, each row opening the kind's catalogue page. */
  kinds: { parameters: {} , required: [] },
  /** The product's catalogue: every kind by area and subgroup, with its word, its definition, its count and its taking. */
  catalogue: { parameters: { path: { type: 'string' } }, required: [] },
};

/** The parameters of one section, as a schema: the object the `params` node of a section is judged by. */
export function parametersSchema(component: ComponentName): Record<string, unknown> {
  const held = COMPONENT_SCHEMAS[component];
  return {
    type: 'object',
    additionalProperties: false,
    required: [...held.required],
    properties: held.parameters,
  };
}

/** A template's declared variable (section 6): its GraphQL input type and whether an address must bind it. */
export const VARIABLE_SCHEMA = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', pattern: '^\\[?[A-Za-z][A-Za-z0-9_]*!?\\]?!?$' },
    required: { type: 'boolean' },
    default: {},
  },
};

/** One section of a template (section 6). `params` is judged by the component's own schema, not here. */
export const SECTION_SCHEMA = {
  type: 'object',
  required: ['id', 'component'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
    component: { type: 'string', enum: COMPONENT_NAMES },
    on: { type: 'string', enum: ['subject', 'root'] },
    after: { type: 'string' },
    replace: { type: 'boolean' },
    title: LOCALIZED_TEXT_SCHEMA,
    roles: {
      type: 'object',
      additionalProperties: false,
      properties: {
        show: { type: 'array', items: { type: 'string' } },
        open: { type: 'array', items: { type: 'string' } },
      },
    },
    query: { type: 'string' },
    params: { type: 'object' },
  },
} as const;

/**
 * A template file (section 6): its name, the base it extends, the kinds and entities that open it, the variables it
 * declares and its sections. `records`, `entities` and `catalogue` are how a product says which pages this template
 * draws: the bootstrap's `recordTemplates` and `ownTemplates` are read from them (a catalogue entry's page is its kind's
 * `catalogue` template, when the product names one, and the catalogue template otherwise).
 */
export const TEMPLATE_SCHEMA = {
  type: 'object',
  required: ['template'],
  additionalProperties: false,
  properties: {
    template: { type: 'string', pattern: '^[^\\s]+$' },
    extends: { type: 'string', pattern: '^[^\\s]+$' },
    records: { type: 'array', items: { type: 'string', pattern: '^[^\\s]+$' } },
    entities: { type: 'array', items: { type: 'string', pattern: '^[^\\s]+$' } },
    /** The kinds whose catalogue page is this template (a product's own page of the catalogue entry of that kind). */
    catalogue: { type: 'array', items: { type: 'string', pattern: '^[^\\s]+$' } },
    variables: { type: 'object', additionalProperties: VARIABLE_SCHEMA },
    sections: { type: 'array', minItems: 0, items: SECTION_SCHEMA },
  },
} as const;

/**
 * The GraphQL schema a product's published manifest derives (decision 0036, sections 1 to 4): one type per kind,
 * one record type per edge kind, the `Entity` interface, connections with `first`/`after`, a filter and an order
 * per type, the fields of section 2 (`<field>`, `<field>Opinions`, `contested`), the edges both ways with a
 * record that keeps each repeated edge apart, the inverse of every reference, the backlinks, and the roots
 * `entity`, `all<Type>`, `search`, `bootstrap`, `navigation` and `cochange`, the aggregates of section 4 over every kind
 * and over a catalogue entry's records, and the page templates' sections. A page reads its entity's relations both ways — `backlinks` for the
 * edges that reach it, `outgoing` for the ones it leads out with — and a catalogue entity lists the records of its kind
 * through `instances`, so a template asks the graph without naming a kind. The schema is a function of the manifest alone: two machines
 * derive one SDL from one manifest, a name that encodes to a reserved one or two declarations that encode to one
 * name are refused naming what stands on both sides, and nothing here names a kind.
 */
import { byCodePoint } from '../model/order.js';
import type { FieldType } from '../graph/contract.js';
import { SCALAR_NAMES, SchemaRefusal, NameRegistry, fieldNameOf, typeNameOf } from './names.js';
import type { PublishedEdge, PublishedField, PublishedKind, PublishedManifest } from './manifest.js';

interface ArgumentDef {
  readonly name: string;
  readonly type: string;
  readonly defaultValue?: string;
}

interface FieldDef {
  readonly name: string;
  readonly type: string;
  readonly args?: readonly ArgumentDef[];
  /** An input field's default, as the SDL spells it. */
  readonly defaultValue?: string;
}

interface TypeDef {
  readonly name: string;
  readonly implementsList?: readonly string[];
  readonly fields: readonly FieldDef[];
}

interface InputDef {
  readonly name: string;
  readonly fields: readonly FieldDef[];
}

interface EnumDef {
  readonly name: string;
  readonly values: readonly string[];
}

/** The assertion engine's GraphQL envelopes; product declarations never own these fields. */
export const ASSERTION_SCHEMA_TYPES: readonly TypeDef[] = [
  { name: 'AssertionEvidence', fields: [
      { name: 'targetUid', type: 'ID!' }, { name: 'target', type: 'Entity' }, { name: 'relation', type: 'String!' },
      { name: 'locator', type: 'JSON' },
      { name: 'historicalValidity', type: 'EvidenceHistoricalValidity!' },
      { name: 'currentApplicability', type: 'EvidenceCurrentApplicability!' },
      { name: 'availability', type: 'EvidenceAvailability!' }, { name: 'issues', type: '[String!]!' },
    ] },
  { name: 'VertexIdentity', fields: [{ name: 'id', type: 'ID!' }, { name: 'entity', type: 'Entity!' }] },
  { name: 'GraphEdge', fields: [{ name: 'id', type: 'ID!' }, { name: 'kind', type: 'String!' }, { name: 'from', type: 'Entity!' }, { name: 'to', type: 'Entity!' }] },
  { name: 'Assertion', fields: [
      { name: 'id', type: 'ID!' }, { name: 'subject', type: 'AssertionSubject!' },
      { name: 'property', type: 'String!' }, { name: 'value', type: 'JSON' },
      { name: 'operation', type: 'AssertionOperation!' }, { name: 'source', type: 'Entity!' },
      { name: 'author', type: 'Entity!' }, { name: 'unit', type: 'Entity' },
      { name: 'validFrom', type: 'DateTime!' }, { name: 'validTo', type: 'DateTime' },
      { name: 'recordedAt', type: 'DateTime!' }, { name: 'evidence', type: '[AssertionEvidence!]!' },
      { name: 'selected', type: 'Boolean!' }, { name: 'question', type: 'AssertionQuestion' },
    ] },
  { name: 'AssertionQuestion', fields: [
      { name: 'id', type: 'ID!' }, { name: 'state', type: 'AssertionQuestionState!' },
      { name: 'candidates', type: '[Assertion!]!' }, { name: 'resolution', type: 'Assertion' },
      { name: 'supersededResolutions', type: '[Assertion!]!' },
    ] },
];

/** The temporal and context selectors every GraphQL root receives. */
export const ASSERTION_SCHEMA_SELECTORS: readonly ArgumentDef[] = [
  { name: 'context', type: 'Int' }, { name: 'validAt', type: 'DateTime' }, { name: 'recordedAt', type: 'DateTime' },
];

/** The operators one scalar's filter keeps (the narrowed set of the contract's first step: eq, in, contains, lt and gt). */
const WHERE_OPERATORS: Readonly<Record<FieldType, readonly string[]>> = {
  text: ['_eq', '_neq', '_in', '_nin', '_contains', '_like', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  integer: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  bigint: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  boolean: ['_eq', '_neq', '_is_null'],
  timestamp: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  json: ['_eq', '_neq', '_is_null'],
};

/** The filter input's field type for one operator. */
function operatorType(operator: string, scalar: string): string {
  if (operator === '_in' || operator === '_nin') return `[${scalar}!]`;
  if (operator === '_is_null') return 'Boolean';
  if (operator === '_like') return 'String';
  return scalar;
}

/** The fields every entity answers: the interface of section 1. */
function entityFields(): FieldDef[] {
  return [
    { name: 'id', type: 'ID!' },
    { name: 'kind', type: 'String!' },
    { name: 'label', type: 'String!' },
    { name: 'template', type: 'String!' },
    { name: 'contested', type: '[String!]!' },
    { name: 'backlinks', type: 'BacklinkConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    { name: 'outgoing', type: 'OutgoingConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    // 0039 item 5: the names this entity's own text leaves unlinked, with the candidates each may mean.
    { name: 'unlinkedMentions', type: '[UnlinkedMention!]!' },
  ];
}

/** The arguments every connection takes: the filter and the order when the type has one, then the page's bounds. */
function connectionArgs(where?: string, order?: string): ArgumentDef[] {
  return [
    ...(where === undefined ? [] : [{ name: 'where', type: where }]),
    ...(order === undefined ? [] : [{ name: 'orderBy', type: `[${order}!]` }]),
    { name: 'first', type: 'Int' },
    { name: 'after', type: 'String' },
  ];
}

/** The connection's own fields: the edges, the page's place and the whole count (section 4). */
function connectionFields(edgeType: string): FieldDef[] {
  return [
    { name: 'edges', type: `[${edgeType}!]!` },
    { name: 'pageInfo', type: 'PageInfo!' },
    { name: 'totalCount', type: 'Int!' },
    { name: 'relationLabel', type: 'String' },
  ];
}

/** How the schema is built: the declarations, the names they claim, and the definitions in the order they sort. */
class Builder {
  private readonly registry = new NameRegistry();
  private readonly types = new Map<string, TypeDef>();
  private readonly inputs = new Map<string, InputDef>();
  private readonly enums = new Map<string, EnumDef>();
  private readonly kindTypes = new Map<string, string>();
  /** The Where and Order types a kind or an edge record made, for the connections that take them. */
  private readonly whereOf = new Map<string, string>();
  private readonly orderOf = new Map<string, string>();
  private readonly kinds: ReadonlyMap<string, PublishedKind>;
  private readonly edges: readonly PublishedEdge[];

  constructor(private readonly manifest: PublishedManifest) {
    this.kinds = new Map(manifest.kinds.map((kind) => [kind.name, kind]));
    this.edges = [...manifest.edges].sort((left, right) => byCodePoint(typeNameOf(left.name), typeNameOf(right.name)));
    this.claimOwnTypes();
    this.buildKinds();
    this.buildEdges();
    this.buildRoots();
  }

  /** The types, interfaces, scalars and enums the mechanism owns; a manifest name may not take one of them. */
  private claimOwnTypes(): void {
    for (const name of ['Entity', 'Query', 'PageInfo', 'AssertionSubject', 'AssertionOperation', 'EvidenceHistoricalValidity', 'EvidenceCurrentApplicability', 'EvidenceAvailability', 'AssertionQuestionState', 'Backlink', 'BacklinkEdge', 'BacklinkConnection',
      'EntityEdge', 'EntityConnection', 'Outgoing', 'OutgoingEdge', 'OutgoingConnection', 'CatalogueEntity', 'CatalogueField',
      'CatalogueEntityEdge', 'CatalogueEntityConnection', 'PageTemplate', 'Bootstrap', 'BootstrapHome', 'RecordTemplate', 'OwnTemplate',
      'TemplateFinding', 'Navigation', 'NavigationGroup', 'NavigationKind', 'NavigationPurpose', 'Aggregate', 'Group', 'Bucket', 'Ranked', 'Cochange', 'SearchHit', 'SearchGroup',
      'UnlinkedMention', 'MentionCandidate', 'Mutation', 'MentionLink',
      'String', 'Int', 'Boolean', 'ID', 'Float', 'BigInt', 'DateTime', 'JSON']) {
      this.registry.claimGeneratedType(name, `the schema's own type "${name}"`);
    }
    for (const definition of ASSERTION_SCHEMA_TYPES) {
      this.registry.claimGeneratedType(definition.name, `the schema's own type "${definition.name}"`);
      this.type(definition.name, definition.fields);
    }
    this.type('TemplateFinding', [
      { name: 'file', type: 'String!' }, { name: 'line', type: 'Int!' },
      { name: 'path', type: 'String!' }, { name: 'message', type: 'String!' },
    ]);
    this.type('PageInfo', [{ name: 'endCursor', type: 'String' }, { name: 'hasNextPage', type: 'Boolean!' }]);
    // 0039 items 6 and 29: one unlinked name at its place, and every same-named candidate with its kind's label.
    this.type('MentionCandidate', [
      { name: 'uid', type: 'ID!' }, { name: 'kind', type: 'String!' }, { name: 'kindLabel', type: 'String!' },
      { name: 'label', type: 'String!' }, { name: 'domain', type: 'String!' },
    ]);
    // 0039 items 5 and 29: the one write a page makes — a name it showed, linked at exactly its place.
    this.type('MentionLink', [
      { name: 'kind', type: 'String!' }, { name: 'uid', type: 'ID!' }, { name: 'field', type: 'String!' }, { name: 'text', type: 'String!' },
    ]);
    this.type('Mutation', [
      { name: 'linkMention', type: 'MentionLink!', args: [
        { name: 'kind', type: 'String!' }, { name: 'id', type: 'ID!' }, { name: 'field', type: 'String!' }, { name: 'path', type: 'String!' },
        { name: 'start', type: 'Int!' }, { name: 'end', type: 'Int!' }, { name: 'name', type: 'String!' }, { name: 'entity', type: 'ID!' },
      ] },
    ]);
    this.type('UnlinkedMention', [
      { name: 'field', type: 'String!' }, { name: 'path', type: 'String!' }, { name: 'start', type: 'Int!' }, { name: 'end', type: 'Int!' },
      { name: 'name', type: 'String!' }, { name: 'candidates', type: '[MentionCandidate!]!' },
    ]);



    this.enumeration('AssertionOperation', ['ASSERT', 'RETRACT']);
    this.enumeration('EvidenceHistoricalValidity', ['VALID', 'INVALID', 'UNKNOWN']);
    this.enumeration('EvidenceCurrentApplicability', ['CURRENT', 'STALE', 'ENDED', 'UNKNOWN']);
    this.enumeration('EvidenceAvailability', ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']);
    this.enumeration('AssertionQuestionState', ['OPEN', 'RESOLVED', 'DISMISSED']);


    this.type('Backlink', [
      { name: 'relation', type: 'String!' },
      { name: 'label', type: 'String!' },
      { name: 'edge', type: 'String!' },
      { name: 'inverse', type: 'Boolean!' },
      { name: 'from', type: 'Entity!' },
    ]);
    this.type('BacklinkEdge', [{ name: 'cursor', type: 'String!' }, { name: 'node', type: 'Backlink!' }]);
    this.type('BacklinkConnection', connectionFields('BacklinkEdge'));
    this.type('Outgoing', [
      { name: 'relation', type: 'String!' },
      { name: 'label', type: 'String!' },
      { name: 'edge', type: 'String!' },
      { name: 'inverse', type: 'Boolean!' },
      { name: 'to', type: 'Entity!' },
    ]);
    this.type('OutgoingEdge', [{ name: 'cursor', type: 'String!' }, { name: 'node', type: 'Outgoing!' }]);
    this.type('OutgoingConnection', connectionFields('OutgoingEdge'));
    this.type('EntityEdge', [{ name: 'cursor', type: 'String!' }, { name: 'node', type: 'Entity!' }]);
    this.type('EntityConnection', connectionFields('EntityEdge'));
    this.type('PageTemplate', [{ name: 'name', type: 'String!' }, { name: 'body', type: 'String!' }]);
    this.type('BootstrapHome', [{ name: 'id', type: 'ID!' }, { name: 'kind', type: 'String!' }, { name: 'template', type: 'String!' }]);
    this.type('RecordTemplate', [{ name: 'kind', type: 'String!' }, { name: 'template', type: 'String!' }]);
    this.type('OwnTemplate', [{ name: 'id', type: 'ID!' }, { name: 'template', type: 'String!' }]);
    this.type('Bootstrap', [
      { name: 'structureRevision', type: 'String!' },
      // The product's language (its manifest's `language:`): the wiki's interface opens in it (madarch-64o5.84).
      { name: 'language', type: 'String!' },
      { name: 'home', type: 'BootstrapHome' },
      { name: 'catalogueTemplate', type: 'String!' },
      { name: 'templates', type: '[PageTemplate!]!' },
      { name: 'recordTemplates', type: '[RecordTemplate!]!' },
      { name: 'ownTemplates', type: '[OwnTemplate!]!' },
      { name: 'roles', type: '[String!]!' },
    ]);
    // The frame's one read (decision 0036, sections 6 and 7): the product's groups and every kind it declares, with the
    // number of entities the graph holds. The sidebar is drawn from this, so the app names no kind of its own.
    this.type('NavigationKind', [
      { name: 'kind', type: 'String!' },
      { name: 'one', type: 'String!' },
      { name: 'many', type: 'String!' },
      { name: 'definition', type: 'String' },
      { name: 'taken', type: 'Boolean!' },
      { name: 'group', type: 'String' },
      { name: 'nav', type: 'String' },
      { name: 'count', type: 'Int!' },
      { name: 'entryId', type: 'ID' },
    ]);
    this.type('NavigationGroup', [
      { name: 'name', type: 'String!' },
      { name: 'labels', type: 'JSON!' },
      { name: 'short', type: 'JSON' },
      { name: 'open', type: 'Boolean!' },
      { name: 'parent', type: 'String' },
    ]);
    this.type('NavigationPurpose', [{ name: 'id', type: 'String!' }, { name: 'labels', type: 'JSON!' }]);
    this.type('Navigation', [
      { name: 'product', type: 'String' },
      { name: 'groups', type: '[NavigationGroup!]!' },
      { name: 'kinds', type: '[NavigationKind!]!' },
      { name: 'purposes', type: '[NavigationPurpose!]!' },
    ]);
    // The aggregates of decision 0036, section 4: counted, grouped, bucketed and ranked in SQL over the agreed values,
    // so a page asks what the graph holds and never counts it in the browser.
    this.type('Group', [{ name: 'key', type: 'JSON' }, { name: 'count', type: 'Int!' }]);
    this.type('Bucket', [{ name: 'from', type: 'JSON' }, { name: 'to', type: 'JSON' }, { name: 'count', type: 'Int!' }]);
    this.type('Ranked', [{ name: 'node', type: 'Entity!' }, { name: 'value', type: 'JSON!' }]);
    this.type('Aggregate', [
      { name: 'count', type: 'Int!' },
      { name: 'groupBy', type: '[Group!]!', args: [{ name: 'field', type: 'String!' }, { name: 'limit', type: 'Int', defaultValue: '20' }] },
      { name: 'histogram', type: '[Bucket!]!', args: [{ name: 'field', type: 'String!' }, { name: 'bounds', type: '[JSON!]!' }] },
      { name: 'topN', type: '[Ranked!]!', args: [{ name: 'field', type: 'String!' }, { name: 'n', type: 'Int', defaultValue: '10' }] },
    ]);
    this.type('Cochange', [{ name: 'node', type: 'Entity!' }, { name: 'count', type: 'Int!' }]);
    // The search's answers as a reader meets them: each kind's word, how many it holds, and the rows with the line a
    // result is shown by (a file's path, a commit's short hash and its message).
    this.type('SearchHit', [{ name: 'node', type: 'Entity!' }, { name: 'line', type: 'String!' }]);
    this.type('SearchGroup', [
      { name: 'kind', type: 'String!' },
      { name: 'label', type: 'String!' },
      { name: 'count', type: 'Int!' },
      { name: 'results', type: '[SearchHit!]!' },
    ]);
    // The rows of one relation of one entity, ordered by the other end's own fields: what a page of an entity's
    // history, its containers or its importers asks for, without the page naming the kind at the other end.
    this.input('RelatedOrder', [
      { name: 'field', type: 'String!' },
      { name: 'direction', type: 'OrderDirection' },
      { name: 'nulls', type: 'NullsOrder' },
    ]);
    this.interfaceType('Entity', entityFields());
    this.buildCatalogue();
    this.enumeration('OrderDirection', ['ASC', 'DESC']);
    this.enumeration('NullsOrder', ['FIRST', 'LAST']);
  }

  /**
   * The catalogue entity (decision 0036, section 1 and the owner's 2026-11-13 scope): every entry of the product's
   * catalogue is a graph entity, whether the product takes it or not, with what its catalogue file declares and its
   * derivation relations both ways.
   */
  private buildCatalogue(): void {
    const scalars: PublishedField[] = [
      { name: 'name', type: 'text' },
      { name: 'title', type: 'text', nullable: true },
      { name: 'definition', type: 'text', nullable: true },
      { name: 'group', type: 'text' },
      { name: 'subgroup', type: 'text' },
      { name: 'purpose', type: 'text', nullable: true },
      { name: 'taken', type: 'boolean' },
    ];
    const connection = 'CatalogueEntityConnection';
    this.type('CatalogueField', [
      { name: 'name', type: 'String!' },
      { name: 'type', type: 'String!' },
      { name: 'nullable', type: 'Boolean!' },
      { name: 'producers', type: '[String!]!' },
    ]);
    this.type('CatalogueEntityEdge', [{ name: 'cursor', type: 'String!' }, { name: 'node', type: 'CatalogueEntity!' }]);
    this.type(connection, connectionFields('CatalogueEntityEdge'));
    this.buildWhereAndOrder('catalogue', 'CatalogueEntity', scalars);
    const relationArgs = connectionArgs(this.whereOf.get('CatalogueEntity'), this.orderOf.get('CatalogueEntity'));
    this.type('CatalogueEntity', [
      ...entityFields(),
      { name: 'name', type: 'String!' },
      { name: 'title', type: 'String' },
      { name: 'definition', type: 'String' },
      { name: 'group', type: 'String!' },
      { name: 'subgroup', type: 'String!' },
      { name: 'purpose', type: 'String' },
      { name: 'audience', type: '[String!]!' },
      { name: 'standards', type: '[String!]!' },
      { name: 'taken', type: 'Boolean!' },
      { name: 'plugins', type: '[String!]!' },
      { name: 'fields', type: '[CatalogueField!]!' },
      { name: 'instances', type: 'EntityConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'lang', type: 'String' }] },
      { name: 'instancesAggregate', type: 'Aggregate!', args: [{ name: 'where', type: 'JSON' }, { name: 'lang', type: 'String' }] },
      { name: 'derivesFrom', type: `${connection}!`, args: [...relationArgs, { name: 'lang', type: 'String' }] },
      { name: 'derivedBy', type: `${connection}!`, args: [...relationArgs, { name: 'lang', type: 'String' }] },
    ], ['Entity']);
  }

  private type(name: string, fields: readonly FieldDef[], implementsList?: readonly string[]): void {
    this.types.set(name, { name, fields, ...(implementsList === undefined ? {} : { implementsList }) });
  }

  private interfaceType(name: string, fields: readonly FieldDef[]): void {
    this.types.set(name, { name, fields });
  }

  private input(name: string, fields: readonly FieldDef[]): void {
    this.inputs.set(name, { name, fields });
  }

  private enumeration(name: string, values: readonly string[]): void {
    this.enums.set(name, { name, values });
  }

  private buildKinds(): void {
    for (const kind of [...this.manifest.kinds].sort((left, right) => byCodePoint(typeNameOf(left.name), typeNameOf(right.name)))) {
      const name = typeNameOf(kind.name);
      this.registry.claimType(name, `the kind "${kind.name}"`);
      this.kindTypes.set(kind.name, name);
      this.type(name, [], ['Entity']);
    }
    for (const kind of [...this.manifest.kinds].sort((left, right) => byCodePoint(typeNameOf(left.name), typeNameOf(right.name)))) {
      const name = this.kindTypes.get(kind.name)!;
      const fields: FieldDef[] = [...entityFields()];
      for (const field of kind.fields) {
        const fieldName = fieldNameOf(field.name);
        const declaration = `the field "${field.name}" of the kind "${kind.name}"`;
        this.registry.claimField(name, fieldName, declaration);
        const scalar = SCALAR_NAMES[field.type];
        fields.push({ name: fieldName, type: scalar });
        const assertions = `${fieldName}Assertions`;
        this.registry.claimGeneratedField(name, assertions, `the assertions of the field "${field.name}" of the kind "${kind.name}"`);
        fields.push({ name: assertions, type: '[Assertion!]!' });
      }
      this.type(name, fields, ['Entity']);
      this.buildWhereAndOrder(kind.name, name, kind.fields);
      const edge = `${name}Edge`;
      const connection = `${name}Connection`;
      this.registry.claimGeneratedType(edge, `the connection edge of the kind "${kind.name}"`);
      this.registry.claimGeneratedType(connection, `the connection of the kind "${kind.name}"`);
      this.type(edge, [{ name: 'cursor', type: 'String!' }, { name: 'node', type: `${name}!` }]);
      this.type(connection, connectionFields(edge));
    }
  }

  /** The filter and the order of one type, from its scalar fields; a reference field filters through no operator of its own yet. */
  private buildWhereAndOrder(kind: string, type: string, fields: readonly PublishedField[]): void {
    const scalars = fields;
    if (scalars.length === 0) return;
    const where = `${type}Where`;
    const order = `${type}Order`;
    const orderField = `${type}OrderField`;
    this.registry.claimGeneratedType(where, `the filter of the kind "${kind}"`);
    this.registry.claimGeneratedType(order, `the order of the kind "${kind}"`);
    this.registry.claimGeneratedType(orderField, `the order's fields of the kind "${kind}"`);
    const whereFields: FieldDef[] = [];
    for (const field of scalars) {
      const fieldName = fieldNameOf(field.name);
      const scalar = SCALAR_NAMES[field.type];
      const filter = `${type}${fieldName.slice(0, 1).toUpperCase()}${fieldName.slice(1)}Filter`;
      this.registry.claimGeneratedType(filter, `the filter of the field "${field.name}" of the kind "${kind}"`);
      const operators: FieldDef[] = WHERE_OPERATORS[field.type].map((operator) => ({ name: operator, type: operatorType(operator, scalar) }));
      this.input(filter, operators);
      whereFields.push({ name: fieldName, type: filter });
    }
    this.input(where, whereFields);
    this.enumeration(orderField, scalars.map((field) => fieldNameOf(field.name)));
    this.input(order, [
      { name: 'field', type: `${orderField}!` },
      { name: 'direction', type: 'OrderDirection', defaultValue: 'ASC' },
      { name: 'nulls', type: 'NullsOrder', defaultValue: 'LAST' },
    ]);
    this.whereOf.set(type, where);
    this.orderOf.set(type, order);
  }

  private buildEdges(): void {
    for (const edge of this.edges) {
      for (const end of [...edge.from, ...edge.to]) {
        // `any` is every entity the schema holds: the edge stands on the Entity interface itself, both ways.
        if (end !== 'any' && !this.kinds.has(end)) throw new SchemaRefusal(`the edge "${edge.name}" names the kind "${end}", and the manifest declares no such kind: declare it or change the edge's ends`);
      }
      const record = `${typeNameOf(edge.name)}Edge`;
      const wrapper = `${typeNameOf(edge.name)}ConnectionEdge`;
      const connection = `${typeNameOf(edge.name)}Connection`;
      this.registry.claimGeneratedType(record, `the edge "${edge.name}"`);
      this.registry.claimGeneratedType(wrapper, `the connection edge of "${edge.name}"`);
      this.registry.claimGeneratedType(connection, `the edge "${edge.name}"`);
      const fields: FieldDef[] = [
        { name: 'id', type: 'ID!' },
        { name: 'discriminator', type: 'String!' },
        { name: 'assertions', type: '[Assertion!]!' },
      ];
      for (const attribute of edge.fields) {
        const fieldName = fieldNameOf(attribute.name);
        const declaration = `the field "${attribute.name}" of the edge "${edge.name}"`;
        this.registry.claimField(record, fieldName, declaration);
        const scalar = SCALAR_NAMES[attribute.type];
        fields.push({ name: fieldName, type: scalar });
        const assertions = `${fieldName}Assertions`;
        this.registry.claimGeneratedField(record, assertions, `the assertions of the field "${attribute.name}" of the edge "${edge.name}"`);
        fields.push({ name: assertions, type: '[Assertion!]!' });
      }
      fields.push({ name: 'node', type: 'Entity!' });
      this.type(record, fields);
      this.type(wrapper, [{ name: 'cursor', type: 'String!' }, { name: 'node', type: `${record}!` }]);
      this.type(connection, connectionFields(wrapper));
      this.buildWhereAndOrder(edge.name, record, edge.fields);
      // `any` ends stand on the Entity interface, so every entity type — the catalogue's too — declares them.
      const everyEntity = ['Entity', 'CatalogueEntity', ...this.kindTypes.values()];
      const addEverywhere = (fieldName: string, declaration: string, inverse: boolean): void => {
        // No silent skip: a kind that declares a field of this name is a collision the manifest check refuses,
        // naming both declarations (decision 0036, section 1).
        for (const type of everyEntity) {
          if (inverse) this.registry.claimGeneratedField(type, fieldName, declaration);
          else this.registry.claimField(type, fieldName, declaration);
          this.addField(type, { name: fieldName, type: `${connection}!`, args: connectionArgs(this.whereOf.get(record), this.orderOf.get(record)) });
        }
      };
      for (const from of edge.from.includes('any') ? ['any'] : edge.from) {
        const fieldName = fieldNameOf(edge.name);
        if (from === 'any') { addEverywhere(fieldName, `the edge "${edge.name}"`, false); continue; }
        const type = this.kindTypes.get(from)!;
        this.registry.claimField(type, fieldName, `the edge "${edge.name}"`);
        this.addField(type, { name: fieldName, type: `${connection}!`, args: connectionArgs(this.whereOf.get(record), this.orderOf.get(record)) });
      }
      for (const to of edge.to.includes('any') ? ['any'] : edge.to) {
        const fieldName = `${fieldNameOf(edge.name)}Of`;
        if (to === 'any') { addEverywhere(fieldName, `the inverse of the edge "${edge.name}"`, true); continue; }
        const type = this.kindTypes.get(to)!;
        this.registry.claimGeneratedField(type, fieldName, `the inverse of the edge "${edge.name}"`);
        this.addField(type, { name: fieldName, type: `${connection}!`, args: connectionArgs(this.whereOf.get(record), this.orderOf.get(record)) });
      }
    }
  }

  private buildRoots(): void {
    const fields: FieldDef[] = [
      { name: 'entity', type: 'Entity', args: [{ name: 'id', type: 'ID!' }, { name: 'lang', type: 'String' }] },
    ];
    for (const kind of [...this.manifest.kinds].sort((left, right) => byCodePoint(typeNameOf(left.name), typeNameOf(right.name)))) {
      const type = this.kindTypes.get(kind.name)!;
      const name = `all${type}`;
      this.registry.claimField('Query', name, `the list root of the kind "${kind.name}"`);
      fields.push({ name, type: `${type}Connection!`, args: [...connectionArgs(this.whereOf.get(type), this.orderOf.get(type)), { name: 'lang', type: 'String' }] });
      const aggregateName = `${name}Aggregate`;
      this.registry.claimField('Query', aggregateName, `the aggregate of the kind "${kind.name}"`);
      fields.push({ name: aggregateName, type: 'Aggregate!', args: [{ name: 'where', type: this.whereOf.get(type) ?? 'JSON' }, { name: 'lang', type: 'String' }] });
    }
    const catalogueWhere = this.whereOf.get('CatalogueEntity');
    const catalogueOrder = this.orderOf.get('CatalogueEntity');
    this.registry.claimField('Query', 'catalogueEntity', 'the catalogue entity root');
    this.registry.claimField('Query', 'allCatalogueEntity', 'the catalogue list root');
    this.registry.claimField('Query', 'home', 'the home root');
    this.registry.claimField('Query', 'navigation', 'the navigation root');
    this.registry.claimField('Query', 'templateFindings', 'the template findings root');
    this.registry.claimField('Query', 'cochange', 'the entities changed together through an edge');
    this.registry.claimField('Query', 'contributors', 'the entities one more relation beyond an entity');
    this.registry.claimField('Query', 'related', 'the rows of one relation of one entity');
    this.registry.claimField('Query', 'searchGroups', 'the search grouped by kind');
    fields.push(
      { name: 'catalogueEntity', type: 'CatalogueEntity', args: [{ name: 'name', type: 'String!' }, { name: 'lang', type: 'String' }] },
      { name: 'allCatalogueEntity', type: 'CatalogueEntityConnection!', args: [...connectionArgs(catalogueWhere, catalogueOrder), { name: 'lang', type: 'String' }] },
      { name: 'home', type: 'Entity', args: [{ name: 'lang', type: 'String' }] },
      { name: 'search', type: 'EntityConnection!', args: [{ name: 'text', type: 'String!' }, { name: 'kinds', type: '[String!]' }, { name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'lang', type: 'String' }] },
      { name: 'bootstrap', type: 'Bootstrap!', args: [{ name: 'lang', type: 'String' }] },
      { name: 'navigation', type: 'Navigation!', args: [{ name: 'lang', type: 'String' }] },
      { name: 'templateFindings', type: '[TemplateFinding!]!' },
      { name: 'cochange', type: '[Cochange!]!', args: [{ name: 'id', type: 'ID!' }, { name: 'edge', type: 'String!' }, { name: 'first', type: 'Int' }, { name: 'lang', type: 'String' }] },
      { name: 'contributors', type: '[Cochange!]!', args: [{ name: 'id', type: 'ID!' }, { name: 'through', type: 'String!' }, { name: 'edge', type: 'String!' }, { name: 'first', type: 'Int' }, { name: 'lang', type: 'String' }] },
      { name: 'searchGroups', type: '[SearchGroup!]!', args: [
        { name: 'text', type: 'String!' }, { name: 'kinds', type: '[String!]' },
        { name: 'perKind', type: 'Int', defaultValue: '5' }, { name: 'lang', type: 'String' },
      ] },
      { name: 'related', type: 'EntityConnection!', args: [
        { name: 'id', type: 'ID!' }, { name: 'edge', type: 'String!' }, { name: 'inverse', type: 'Boolean', defaultValue: 'false' },
        { name: 'orderBy', type: '[RelatedOrder!]' }, { name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'lang', type: 'String' },
      ] },
    );
    const selectors = ASSERTION_SCHEMA_SELECTORS;
    this.type('Query', fields.map((field) => ({ ...field, args: [...(field.args ?? []), ...selectors] })));
  }

  private addField(type: string, field: FieldDef): void {
    const held = this.types.get(type);
    if (held === undefined) throw new SchemaRefusal(`the field "${field.name}" was asked of the type "${type}", which the schema does not hold`);
    this.types.set(type, { ...held, fields: [...held.fields, field] });
  }

  render(): string {
    const blocks: string[] = ['scalar BigInt', 'scalar DateTime', 'scalar JSON', 'union AssertionSubject = VertexIdentity | GraphEdge'];
    const held = [...this.types.values()].filter((type) => type.name !== 'Query').sort((left, right) => byCodePoint(left.name, right.name));
    for (const type of held) {
      blocks.push(type.name === 'Entity' ? renderInterface(type) : renderType(type));
    }
    blocks.push(renderType(this.types.get('Query')!));
    for (const input of [...this.inputs.values()].sort((left, right) => byCodePoint(left.name, right.name))) blocks.push(renderInput(input));
    for (const enumeration of [...this.enums.values()].sort((left, right) => byCodePoint(left.name, right.name))) blocks.push(renderEnum(enumeration));
    return `${blocks.join('\n\n')}\n`;
  }
}

function renderArguments(args: readonly ArgumentDef[]): string {
  if (args.length === 0) return '';
  return `(${args.map((argument) => `${argument.name}: ${argument.type}${argument.defaultValue === undefined ? '' : ` = ${argument.defaultValue}`}`).join(', ')})`;
}

function renderFieldDef(field: FieldDef): string {
  return `  ${field.name}${renderArguments(field.args ?? [])}: ${field.type}`;
}

function renderType(type: TypeDef): string {
  const head = `type ${type.name}${type.implementsList === undefined ? '' : ` implements ${type.implementsList.join(' & ')}`} {`;
  return `${head}\n${type.fields.map(renderFieldDef).join('\n')}\n}`;
}

function renderInterface(type: TypeDef): string {
  return `interface ${type.name} {\n${type.fields.map(renderFieldDef).join('\n')}\n}`;
}

function renderInput(input: InputDef): string {
  return `input ${input.name} {\n${input.fields.map(renderFieldDef).join('\n')}\n}`;
}

function renderEnum(enumeration: EnumDef): string {
  return `enum ${enumeration.name} {\n${enumeration.values.map((value) => `  ${value}`).join('\n')}\n}`;
}

/** The SDL of one published manifest; a name it cannot derive throws `SchemaRefusal` naming both declarations. */
export function graphqlSchemaOf(manifest: PublishedManifest): string {
  return new Builder(manifest).render();
}

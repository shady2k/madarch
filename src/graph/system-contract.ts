/** Protected system contracts, decision 0039 items 9, 24–26. */
import { MANIFEST_CONTRACT } from './manifest-contract.js';
import { generatedTableName, type GraphContract, type VertexContract, type EdgeContract } from './contract.js';

export const SYSTEM_PROBLEM='system.problem';
export const SYSTEM_PROBLEM_ABOUT='system.problem-about';

export const SYSTEM_VERTEX_DEFINITIONS: readonly {name:string; fields:VertexContract['fields']; key?:VertexContract['key']; evidence?:VertexContract['evidence']}[] = [
  {name:'system.merge',fields:[{name:'state',type:'text'},{name:'reason',type:'text'}]},
  {name:'system.merge-question',fields:[{name:'state',type:'text'},{name:'reason',type:'text'}]},
  {name:'system.merge-allocation',fields:[{name:'direction',type:'text',nullable:true}]},
  {name:'system.dispute-question',fields:[{name:'property',type:'text'},{name:'language',type:'text',nullable:true},{name:'segment_from',type:'timestamp'},{name:'segment_to',type:'timestamp',nullable:true},{name:'state',type:'text'}]},
  {name:'system.dispute-resolution',fields:[{name:'rationale',type:'text'},{name:'segment_from',type:'timestamp'},{name:'segment_to',type:'timestamp',nullable:true}]},
  {name:'system.dispute-pin',fields:[{name:'canonical_value',type:'text'},{name:'digest',type:'text'},{name:'segment_from',type:'timestamp'},{name:'segment_to',type:'timestamp',nullable:true}]},
  {name:'system.assertion',fields:[],evidence:{immutable:true}},
  {name:'system.kind-applicability',fields:[{name:'state',type:'text'},{name:'reason',type:'text'}]},
  {name:'system.product',fields:[]},
  {name:SYSTEM_PROBLEM,fields:[{name:'rule',type:'text'},{name:'fingerprint',type:'text'},{name:'reason',type:'text'},{name:'locator',type:'text'}]},
  {name:'system.content-snapshot',evidence:{immutable:true,digestField:'digest',digestAlgorithm:'sha256',contentField:'content'},key:['digest'],fields:[{name:'digest',type:'text'},{name:'content',type:'text'}]},
  {name:'system.run',fields:[{name:'target_plugins_only',type:'boolean'},{name:'targets_present',type:'boolean'},{name:'end_state',type:'text'},{name:'end_message',type:'text'},{name:'end_recorded',type:'boolean'},{name:'control_action',type:'text'},{name:'control_at',type:'bigint'},{name:'repository',type:'text'},{name:'default_branch',type:'text'},{name:'commit',type:'text'},{name:'registry_hash',type:'text'},{name:'target_vertex',type:'text'},{name:'configuration_digest',type:'text'},{name:'configuration_recorded_at',type:'bigint'},{name:'run_name',type:'text',lookup:true},{name:'product_name',type:'text'},{name:'planning_epoch',type:'integer'},{name:'planning_closed',type:'boolean'},{name:'has_selection',type:'boolean'},{name:'created_at',type:'bigint'},{name:'updated_at',type:'bigint'},{name:'state',type:'text'}]},
  {name:'system.unit',fields:[{name:'plan_stage_name',type:'text'},{name:'plan_stage_unit_name',type:'text'},{name:'plan_scope',type:'text'},{name:'plan_stage_position',type:'integer'},{name:'plan_position',type:'integer'},{name:'planned_at',type:'bigint'},{name:'unit_name',type:'text',lookup:true},{name:'product_name',type:'text'},{name:'stage_name',type:'text'},{name:'generation',type:'integer'},{name:'inputs_digest',type:'text'},{name:'fence',type:'integer'},{name:'attempt',type:'integer'},{name:'retries_left',type:'integer'},{name:'retry_at',type:'bigint',nullable:true},{name:'replacement_generation',type:'integer',nullable:true},{name:'skipped_because',type:'text',nullable:true},{name:'published_at',type:'bigint',nullable:true},{name:'stale_at',type:'bigint',nullable:true},{name:'updated_at',type:'bigint'},{name:'produced_kind',type:'text'},{name:'producer',type:'text'},{name:'outcome',type:'text'},{name:'produced',type:'integer'},{name:'reason',type:'text'},{name:'producer_version',type:'text'},{name:'scope',type:'text'},{name:'state',type:'text'},{name:'committed_operations',type:'integer'},{name:'last_progress',type:'text'}]},
  {name:'system.chain',fields:[{name:'product_name',type:'text',lookup:true},{name:'state',type:'text'},{name:'updated_at',type:'bigint'}]},
  {name:'system.run-selection',fields:[{name:'role',type:'text'},{name:'position',type:'integer'},{name:'name',type:'text'},{name:'group_name',type:'text',nullable:true},{name:'plugin_name',type:'text',nullable:true},{name:'stage_unit_name',type:'text',nullable:true}]},
  {name:'system.fill-transition',fields:[{name:'step',type:'text'},{name:'from_state',type:'text'},{name:'to_state',type:'text'},{name:'event',type:'text'},{name:'cause',type:'text'},{name:'reason',type:'text'},{name:'generation',type:'integer'},{name:'fence',type:'integer',nullable:true},{name:'at',type:'bigint'}]},
  {name:'system.run-target',fields:[{name:'role',type:'text'},{name:'name',type:'text'},{name:'position',type:'integer'}]},
  {name:'system.unit-cache-version',fields:[{name:'name',type:'text'},{name:'version',type:'text'}]},
  {name:'system.progress',fields:[{name:'seq',type:'integer'},{name:'at',type:'bigint'},{name:'stage',type:'text'},{name:'unit_name',type:'text'},{name:'generation',type:'integer'},{name:'kind',type:'text'},{name:'summary',type:'text'}]},
  {name:'system.run-stage',fields:[{name:'stage_name',type:'text'},{name:'planned_at',type:'bigint'},{name:'units',type:'integer'},{name:'publications',type:'integer'}]},
  {name:'system.tracked-read',fields:[{name:'query_digest',type:'text'},{name:'query',type:'text'},{name:'membership',type:'text'},{name:'members',type:'integer'},{name:'seq',type:'integer'},{name:'at',type:'bigint'}]},
  {name:'system.unread',fields:[{name:'repository',type:'text'},{name:'path',type:'text'},{name:'reason',type:'text'}]},
  {name:'system.authored-import',fields:[{name:'source_path',type:'text'},{name:'content_digest',type:'text'}]},
  {name:'system.operation',fields:[{name:'words',type:'text'},{name:'key',type:'text'},{name:'canonical_request',type:'text'},{name:'digest',type:'text'},{name:'result',type:'text'}]},
];
const vertices: readonly VertexContract[] = SYSTEM_VERTEX_DEFINITIONS.map(({name,fields,key,evidence}) => ({name,fields,...(evidence?{evidence}:{}),table:generatedTableName(name,'vertex'),key:key ?? [],...(name === 'system.kind-applicability' ? { keyEdges: [{ role:'system.product',edge:'system.applicability-product',direction:'from' as const,onDelete:'cascade' as const },{ role:'kind',edge:'system.applicability-kind',direction:'from' as const,onDelete:'cascade' as const }] } : {}),capability:'system'}));


/** Protected edges whose open endpoints follow the complete installed vertex registry. */
export function SYSTEM_EDGE_DEFINITIONS(targets: readonly string[]): readonly EdgeContract[] {
  const edge = (name:string,from:readonly string[],to:readonly string[],many=false,optional=false):EdgeContract => ({
    name,from,to,cardinality:{from:'many',to:many?'many':optional?'optional':'one'},
    labels:{en:{out:name,in:name},ru:{out:name,in:name}},repeats:many,...(many?{discriminator:'locator'}:{}),fields:[],capability:'system',
  });
  return [
    ...['subject','source','author','unit','operation','evidence','mentions'].map(relation => edge(`system.assertion-${relation}`,['system.assertion'],targets,relation==='evidence'||relation==='mentions',relation==='unit')),
    edge('system.applicability-product',['system.kind-applicability'],['system.product']),
    edge('system.applicability-kind',['system.kind-applicability'],['manifest.kind']),
    edge('system.merge-member',['system.merge'],targets,true),
    edge('system.merge-survivor',['system.merge'],targets),
    edge('system.merge-question-member',['system.merge-question'],targets,true),
    edge('system.merge-question-merge',['system.merge-question'],['system.merge'],false,true),
    edge('system.merge-allocation-merge',['system.merge-allocation'],['system.merge']),
    edge('system.merge-allocation-assertion',['system.merge-allocation'],['system.assertion']),
    edge('system.merge-allocation-member',['system.merge-allocation'],targets),

    edge('system.dispute-candidate',['system.dispute-question'],['system.assertion'],true),
    edge('system.dispute-resolution-question',['system.dispute-resolution'],['system.dispute-question']),
    edge('system.resolution-assertion',['system.dispute-resolution'],['system.assertion']),
    edge('system.dispute-chosen',['system.dispute-resolution'],['system.assertion']),
    edge('system.dispute-supersedes',['system.dispute-resolution'],['system.dispute-resolution'],true),
    edge(SYSTEM_PROBLEM_ABOUT,[SYSTEM_PROBLEM],targets,true),
    edge('system.dispute-anchor',['system.dispute-question'],['system.assertion']),
    edge('system.dispute-question-resolution',['system.dispute-question'],['system.dispute-resolution'],true),
    edge('system.resolution-judged',['system.dispute-resolution'],['system.assertion'],true),
    edge('system.snapshot-about',['system.content-snapshot'],targets,true),
    edge('system.operation-unit',['system.operation'],['system.unit']),
    edge('system.operation-author',['system.operation'],['person','plugin','source','agent','agent-session']),
    edge('system.operation-affected',['system.operation'],targets,true),
    {...edge('system.unit-parent',['system.unit'],['system.unit'],true),fields:[{name:'sealed_at',type:'bigint'}]},
    edge('system.unit-run',['system.unit'],['system.run']),
    edge('system.run-inherited-unit',['system.run'],['system.unit'],true),
    edge('system.authored-import-target',['system.authored-import'],targets),
    edge('system.authored-import-source',['system.authored-import'],['source','person','plugin','agent','agent-session']),
    edge('system.authored-import-product',['system.authored-import'],['system.product']),
    edge('system.tracked-read-unit',['system.tracked-read'],['system.unit']),
    edge('system.unread-run',['system.unread'],['system.run']),
    edge('system.run-target-run',['system.run-target'],['system.run']),
    edge('system.unit-cache-version-unit',['system.unit-cache-version'],['system.unit']),
    edge('system.progress-run',['system.progress'],['system.run']),
    edge('system.progress-unit',['system.progress'],['system.unit'],false,true),
    edge('system.run-stage-run',['system.run-stage'],['system.run']),
    edge('system.chain-run',['system.chain'],['system.run'],true,false),
    edge('system.chain-active-run',['system.chain'],['system.run'],false,true),
    edge('system.unit-replacement',['system.unit'],['system.unit'],false,true),
    edge('system.run-selection-run',['system.run-selection'],['system.run'],false,false),
    edge('system.fill-transition-subject',['system.fill-transition'],['system.chain','system.run','system.unit']),
  ];
}

const OPERATIONAL_KINDS = ['run', 'unit', 'event', 'agent-usage', 'operation', 'problem', 'question', 'role', 'setting', 'kind'] as const;
const IDENTITY_KINDS = ['source', 'person', 'plugin', 'agent', 'agent-session'] as const;
function identityKind(name: string): VertexContract {
  return { name, table: generatedTableName(name, 'vertex'), capability: 'system', key: [], fields: [
    { name: 'installation', type: 'text' }, { name: 'label', type: 'text', nullable: true },
    { name: 'version', type: 'text', nullable: true }, { name: 'scope', type: 'text', nullable: true },
  ] };
}
export const SYSTEM_CONTRACT: GraphContract = {
  vertex: [...OPERATIONAL_KINDS.map((name): VertexContract => ({ name, table: generatedTableName(name, 'vertex'),
    capability: 'system', key: [], fields: [{ name: 'label', type: 'text', nullable: true }] })), ...IDENTITY_KINDS.map(identityKind)],
  edge: [
    { name: 'source-principal', table: generatedTableName('source-principal', 'edge'), from: ['source', 'plugin', 'agent'], to: ['person'], cardinality: { from: 'many', to: 'optional' }, labels: { en: { out: 'principal', in: 'source' }, ru: { out: 'автор', in: 'источник' } }, repeats: false, fields: [], capability: 'system' },
    { name: 'session-agent', table: generatedTableName('session-agent', 'edge'), from: ['agent-session'], to: ['agent'], cardinality: { from: 'many', to: 'one' }, labels: { en: { out: 'agent', in: 'session' }, ru: { out: 'агент', in: 'сеанс' } }, repeats: false, fields: [], capability: 'system' },
  ], dictionary: [],
};

/** Reserved names cannot be replaced by a product's declaration. */
export function withSystemContract(contract: GraphContract): GraphContract {
  return inheritProtectedContract(contract, SYSTEM_CONTRACT);
}
export function inheritProtectedContract(contract: GraphContract, baseContract: GraphContract): GraphContract {
  function inherit<T extends VertexContract | EdgeContract>(supplied: T | undefined, base: T): T {
    if (supplied === undefined) return base;
    const { fields: _fields, ...identity } = base;
    if ('labels' in identity) delete identity.labels;
    const extension = supplied as unknown as Record<string, unknown>;
    for (const [property, value] of Object.entries(identity)) {
      if ((property in extension || ['table', 'capability', 'key', 'from', 'to', 'cardinality', 'repeats'].includes(property)) && JSON.stringify(extension[property]) !== JSON.stringify(value)) {
        throw new Error(`${import.meta.path}:1: product cannot replace protected system ${'key' in base ? 'vertex' : 'edge'} identity or constraints ${base.name}.${property}`);
      }
    }
    for (const property of Object.keys(extension)) {
      if (!(property in base) && property !== 'fields' && property !== 'labels') {
        throw new Error(`${import.meta.path}:1: product cannot add protected system identity or constraints ${base.name}.${property}`);
      }
    }
    for (const field of supplied.fields) {
      const held = base.fields.find(one => one.name === field.name);
      if (held !== undefined && (['type', 'nullable', 'valueType', 'schema'] as const).some(property => JSON.stringify(held[property]) !== JSON.stringify(field[property]))) {
        throw new Error(`${import.meta.path}:1: product cannot replace protected field ${base.name}.${field.name}`);
      }
      if (held === undefined && field.nullable !== true) {
        throw new Error(`${import.meta.path}:1: inherited system extension ${base.name}.${field.name} must be nullable`);
      }
    }
    return { ...base, fields: [...base.fields, ...supplied.fields.filter(field => !base.fields.some(held => held.name === field.name))] };
  }
  return { ...contract,
    vertex: [...contract.vertex.filter(kind => !baseContract.vertex.some(base => base.name === kind.name)),
      ...baseContract.vertex.map(base => inherit(contract.vertex.find(kind => kind.name === base.name), base))],
    edge: [...contract.edge.filter(kind => !baseContract.edge.some(base => base.name === kind.name)),
      ...baseContract.edge.map(base => inherit(contract.edge.find(kind => kind.name === base.name), base))],
  };
}

/** A product may extend, but never remove or replace these base contracts. */
export function withAssertionContract(contract: GraphContract): GraphContract {
  const inherited = withSystemContract(contract);
  const targets = [...new Set([...inherited.vertex.map(kind => kind.name), ...vertices.map(kind => kind.name)])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const protectedContract: GraphContract = { vertex: vertices, edge: SYSTEM_EDGE_DEFINITIONS(targets), dictionary: [] };
  return inheritProtectedContract(inherited, protectedContract);
}

/** Foundation identity and declared base fields are not product disagreements. */
export function isDisputableProperty(sort:'vertex'|'edge',kind:string,property:string):boolean {
  const base=sort==='vertex'?[...SYSTEM_CONTRACT.vertex,...vertices,...MANIFEST_CONTRACT.vertex].find(one=>one.name===kind):[...SYSTEM_CONTRACT.edge,...SYSTEM_EDGE_DEFINITIONS([]),...MANIFEST_CONTRACT.edge].find(one=>one.name===kind);
  if(base===undefined || kind==='system.kind-applicability' && property==='state')return true;
  return property!=='$exists'&&!base.fields.some(field=>field.name===property);
}

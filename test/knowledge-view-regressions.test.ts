import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { buildViews, tabsOf, type GraphView } from '../src/knowledge/views.js';
import { archifyFailurePage, archifyFrame, likec4Model, workspaceOf } from '../src/knowledge/view-frames.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';
import { fixtureManifest } from './knowledge-manifest-fixture.js';

/** The kinds these projections are drawn by, as a product's manifest declares them (decision 0033). */
const MANIFEST = fixtureManifest({ 'code.table': { er: 'links' }, 'code.database': { er: 'tables' }, 'code.service': { views: ['c4-component'], system: 'container' } });

const domainMap: GraphView = {spec:{type:'domain-map',subject:''},title:'Domains',label:'Domains',elements:[
  {id:'domain:orders',label:'Ordering',kind:'domain',href:'/e/orders',dashed:false},
  {id:'orders',label:'orders-api',kind:'container',parent:'domain:orders',href:'/e/service',dashed:false},
  {id:'domain:billing',label:'Billing',kind:'domain',href:'/e/billing',dashed:false},
  {id:'billing',label:'billing-api',kind:'container',parent:'domain:billing',href:'/e/billing-service',dashed:false},
],edges:[],notes:[],empty:null,marker:null};

test('disconnected domain services retain their ownership in the actual LikeC4 layout', async () => {
  const held = workspaceOf(domainMap);
  expect(held.elementIds.get('orders')).toContain('.');
  const result = await likec4Model(domainMap);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  if (process.env['MADARCH_DIAGRAM_LAYOUT_EVIDENCE']) writeFileSync(process.env['MADARCH_DIAGRAM_LAYOUT_EVIDENCE'], JSON.stringify({workspace:held.workspace, ids:Object.fromEntries(held.elementIds),model:result.model},null,2));
  const model = result.model as {views:Record<string,{nodes:{id:string;parent?:string|null}[]}>};
  const child=model.views['index']!.nodes.find(n=>n.id===held.elementIds.get('orders'));
  if (!child) throw new Error(`the domain view omitted ${held.elementIds.get('orders')}: ${JSON.stringify(model.views['index'])}; workspace: ${held.workspace}`);
  expect(child.parent).toBe(held.elementIds.get('domain:orders'));
  const frame = await archifyFrame(domainMap,{});
  if (!frame.ok) throw new Error(frame.message);
  expect(frame.ok).toBe(true);
  expect(frame.html).toContain('Ordering'); expect(frame.html).toContain('Billing');
  expect(frame.html).toContain('orders-api'); expect(frame.html).toContain('billing-api');
  expect(frame.html).toContain('html[data-embed="true"] .diagram-nav{display:inline-flex!important;position:fixed!important');
}, 30_000);

test('an ER view draws in all three engines, and a sequence still says archify cannot', async () => {
  // The ER view switches between the three renderers the wiki holds (the owner's addendum of 2026-11-10).
  expect(tabsOf('er', 'archify')).toEqual(['archify', 'likec4', 'mermaid']);
  expect(tabsOf('er', 'likec4')).toEqual(['likec4', 'mermaid', 'archify']);
  expect(tabsOf('er', 'mermaid')).toEqual(['mermaid', 'likec4', 'archify']);
  const er: GraphView = {
    spec: { type: 'er', subject: 'code.table:shop/orders' },
    title: 'Tables: orders',
    label: 'Tables',
    elements: [
      { id: 'code.table:shop/orders', label: 'orders', kind: 'table', href: '/e/orders', dashed: false, columns: [{ name: 'id', type: 'uuid', key: true }, { name: 'user_id', type: 'uuid', fk: true }] },
      { id: 'code.table:shop/users', label: 'users', kind: 'table', href: '/e/users', dashed: false, columns: [{ name: 'id', type: 'uuid', key: true }] },
    ],
    edges: [{ from: 'code.table:shop/orders', to: 'code.table:shop/users', label: 'user_id', dashed: false }],
    notes: [],
    empty: null,
    marker: null,
  };
  // LikeC4 lays the same tables out as one box per table with its columns, and archify draws that layout.
  const model = await likec4Model(er);
  if (!model.ok) throw new Error(`LikeC4 did not lay out the ER view: ${model.message}`);
  expect(JSON.stringify(model.model)).toContain('orders');
  const frame = await archifyFrame(er, {});
  if (!frame.ok) throw new Error(`archify did not draw the ER view: ${frame.message}`);
  expect(frame.html).toContain('orders');
  expect(frame.html).toContain('user_id');
  expect(frame.html).toContain('users');
  // A table that references itself: LikeC4 refuses an arrow an element draws to itself ("Invalid parent-child
  // relationship"), and archify draws that same layout, so the arrow is left out of their picture and Mermaid draws it.
  const selfEdge: GraphView = { ...er, edges: [{ from: 'code.table:shop/orders', to: 'code.table:shop/orders', label: 'parent_id', dashed: false }] };
  expect(workspaceOf(selfEdge).workspace).not.toContain('-> n0');
  const selfModel = await likec4Model(selfEdge);
  if (!selfModel.ok) throw new Error(`LikeC4 did not lay out the ER view with a self reference: ${selfModel.message}`);
  expect((await archifyFrame(selfEdge, {})).ok).toBe(true);
  // A table with many columns: archify refuses a sublabel its component cannot hold even at its 6 px floor, so an ER
  // layout is written as large as the longest column line needs, and the reader scrolls the page.
  const wide: GraphView = {
    ...er,
    elements: er.elements.map((element) => (element.id === 'code.table:shop/orders' ? { ...element, columns: Array.from({ length: 9 }, (_, at) => ({ name: `very_long_column_name_${at + 1}`, type: 'timestamp_with_time_zone', key: at === 0 })) } : element)),
  };
  const wideFrame = await archifyFrame(wide, {});
  if (!wideFrame.ok) throw new Error(`archify did not draw a wide ER table: ${wideFrame.message}`);
  expect(wideFrame.html).toContain('very_long_column_name_9');
  // A type an engine cannot draw says so, naming the engine and the type.
  const sequence: GraphView = { ...domainMap, spec: { type: 'sequence', subject: 'orders' } };
  const refused = await archifyFrame(sequence, {});
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error('archify must not draw a sequence');
  expect(refused.message).toContain('a sequence is drawn only by Mermaid');
});

test('a relation whose ends are one element is drawn by Mermaid, and the view says so', async () => {
  const subject: GraphEntity = { key: 'code.table:shop/public.orders', kind: 'code.table', label: 'orders', properties: {}, nodeIds: [], scope: 'repo' };
  const table = (name: string): GraphEntity => ({ key: `code.table:shop/public.${name}`, kind: 'code.table', label: name, properties: {}, nodeIds: [], scope: 'repo' });
  const graph = {
    find: async (key: string) => (key === subject.key ? [subject] : []),
    byPrefix: async () => ({ rows: [], total: 0 }),
    relationEdges: async () => ({ rows: [{ from: subject, to: subject, properties: { column: 'parent_id' } }], total: 1 }),
    neighbors: async () => [{ relation: 'code.foreign-key', direction: 'out', total: 1, edges: 1, rows: [{ entity: table('orders'), edges: 1 }] }],
  } as unknown as GraphReader;
  const ctx = { graph, manifest: MANIFEST, repoOfScope: () => undefined } as unknown as RenderContext;
  const [view] = await buildViews({ ctx, lang: 'en', productTitle: 'Shop' }, { type: 'er', subject: subject.key });
  expect(view!.notes).toContain('One relation starts and ends at the same element; LikeC4 and archify draw arrows only between different elements, so Mermaid is where it is drawn.');
  // The picture's model leaves the arrow out; the engine that refuses it is not handed it.
  expect(workspaceOf(view!).workspace).not.toContain('-> n0');
});

test('renderer HTTP failure stays 500 and includes escaped actionable diagnostics',async()=>{
  const message='/tmp/diagram/document.json:1: renderer exit 1: missing /tmp/app/renderer.mjs <script>bad</script>';
  const product={viewFrame:async()=>({ok:false,status:500,message})} as unknown as KnowledgeProduct;
  const part=createKnowledgePart({json:(status,body)=>new Response(JSON.stringify(body),{status}),refused:(status,body)=>({response:new Response(JSON.stringify(body),{status})}),errorLog:()=>undefined},product,()=>[]);
  const handled=await part.viewFrame(new Request('http://localhost/api/view-frame?renderer=archify&lang=ru'));
  expect(handled.response.status).toBe(500);
  const html=await handled.response.text();
  expect(html).toContain('Эту диаграмму'); expect(html).toContain('/tmp/diagram/document.json:1:');
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  expect(html).not.toContain('<script>bad</script>');
  expect(archifyFailurePage('en',message)).toContain('Choose another renderer.');
});

test('21 incoming foreign-key tables cannot disappear behind a false total',async()=>{
  const table=(name:string):GraphEntity=>({key:`code.table:shop/public.${name}`,kind:'code.table',label:name,properties:{},nodeIds:[],scope:'repo'});
  const subject=table('customers'); const others=Array.from({length:21},(_,i)=>table(`orders_${String(i).padStart(2,'0')}`));
  const graph={find:async(key:string)=>key===subject.key?[subject]:[],byPrefix:async()=>({rows:[],total:0}),relationEdges:async()=>({rows:others.map(t=>({from:t,to:subject,properties:{column:'customer_id'}})),total:21}),neighbors:async(entity:GraphEntity,options:{direction:string;limit:number})=>{
    const rows=entity.key===subject.key?(options.direction==='in'?others:[]):[subject];
    return [{relation:'code.foreign-key',direction:options.direction,total:rows.length,edges:rows.length,rows:rows.slice(0,options.limit).map(entity=>({entity,edges:1}))}];
  }} as unknown as GraphReader;
  const ctx={graph,manifest:MANIFEST,repoOfScope:()=>undefined} as unknown as RenderContext;
  const [view]=await buildViews({ctx,lang:'en',productTitle:'Shop'},{type:'er',subject:subject.key});
  expect(view!.elements).toHaveLength(12);
  expect(view!.marker).toBe('Showing 12 of 22.');
  expect(view!.fullElements!.map(element => element.id)).toEqual([subject.key, ...others.map(table => table.key)]);
  expect(view!.fullEdges!.map(edge => [edge.from, edge.to, edge.label])).toEqual(others.map(table => [table.key, subject.key, 'customer_id']));
  expect(view!.notes.join(' ')).not.toContain('20 of 21');
});


test('parallel foreign keys retain each relationship and mark both owning columns', async () => {
  const entity = (name: string): GraphEntity => ({ key: `code.table:shop/public.${name}`, kind: 'code.table', label: name, properties: {}, nodeIds: [], scope: 'repo' });
  const orders = entity('orders'), customers = entity('customers');
  const foreignKeys = ['billing_customer_id', 'shipping_customer_id'].map(column => ({ from: orders, to: customers, discriminator: column, properties: { column } }));
  const graph = {
    find: async (key: string) => [orders, customers].filter(table => table.key === key),
    // A table holds no tables under its key; its columns are what the graph files there.
    byPrefix: async (kind: string, prefix: string) => (kind === 'code.column' && prefix.startsWith(`${orders.key}/`)
      ? { rows: foreignKeys.map(({ properties: { column } }) => ({ ...entity(column), label: column, properties: { type: 'uuid' } })), total: 2 }
      : { rows: [], total: 0 }),
    relationEdges: async () => ({ rows: foreignKeys, total: 2 }),
    neighbors: async (table: GraphEntity, options: { direction: string }) => [{ relation: 'code.foreign-key', direction: options.direction, total: table.key === orders.key && options.direction === 'out' ? 1 : 0, edges: 2, rows: table.key === orders.key && options.direction === 'out' ? [{ entity: customers, edges: 2 }] : [] }],
  } as unknown as GraphReader;
  const ctx = { graph, manifest: MANIFEST, repoOfScope: () => undefined } as unknown as RenderContext;
  const [view] = await buildViews({ ctx, lang: 'en', productTitle: 'Shop' }, { type: 'er', subject: orders.key });
  expect(view!.edges.map(edge => edge.label)).toEqual(['billing_customer_id', 'shipping_customer_id']);
  expect(view!.edges.map(edge => edge.discriminator)).toEqual(['billing_customer_id', 'shipping_customer_id']);
  expect(view!.elements.find(element => element.id === orders.key)!.columns!.every(column => column.fk)).toBe(true);
  expect(view!.mermaid!.match(/customers .* orders/g)).toHaveLength(2);
});

test('deployment ownership survives the actual LikeC4 layout and archify validator', async () => {
  const view: GraphView = { ...domainMap, spec: { type: 'deployment', subject: '' }, elements: [
    { id: 'file:compose.yaml', label: 'compose.yaml', kind: 'node', href: null, dashed: false },
    { id: 'api', label: 'api', kind: 'container', parent: 'file:compose.yaml', href: null, dashed: false },
    { id: 'worker', label: 'worker', kind: 'container', parent: 'file:compose.yaml', href: null, dashed: false },
  ] };
  const held = workspaceOf(view);
  const result = await likec4Model(view);
  if (!result.ok) throw new Error(result.message);
  const model = result.model as { views: Record<string, { nodes: { id: string; parent?: string | null }[] }> };
  for (const key of ['api', 'worker']) expect(model.views['index']!.nodes.find(node => node.id === held.elementIds.get(key))!.parent).toBe(held.elementIds.get('file:compose.yaml'));
  const frame = await archifyFrame(view, {});
  if (!frame.ok) throw new Error(frame.message);
  expect(frame.html).toContain('data-boundary-label');
  expect(frame.html).toContain('compose.yaml');
}, 30_000);


test('forty-two deployment elements fold into their twenty-one real files and drill back to all members', async () => {
  const services: GraphEntity[] = Array.from({ length: 21 }, (_, index) => ({ key: `code.compose-service:deploy/${String(index).padStart(2, '0')}/compose.yaml#api`, kind: 'code.compose-service', label: `api-${index}`, properties: {}, nodeIds: [], scope: 'repo' }));
  const graph = { list: async (kind: string) => ({ rows: kind === 'code.compose-service' ? services : [], total: kind === 'code.compose-service' ? services.length : 0 }), relationEdges: async () => ({ rows: [], total: 0 }) } as unknown as GraphReader;
  const ctx = { graph, manifest: MANIFEST, repoOfScope: () => undefined } as unknown as RenderContext;
  const context = { ctx, lang: 'en', productTitle: 'Shop' };
  const [overview] = await buildViews(context, { type: 'deployment', subject: '' });
  expect(overview!.elements).toHaveLength(21);
  expect(overview!.elements.reduce((sum, element) => sum + element.standsFor!, 0)).toBe(42);
  for (const holder of overview!.elements) {
    expect(holder.id).toStartWith('file:deploy/');
    expect(holder.drill).toBeDefined();
    const [detail] = await buildViews(context, holder.drill!.spec);
    expect(detail!.elements).toHaveLength(2);
    expect(detail!.elements.find(element => element.parent === holder.id)).toBeDefined();
    expect(detail!.up!.spec).toEqual({ type: 'deployment', subject: '' });
  }
});


test('ER retains all 64 columns including combined PK/FK and parallel column labels', async () => {
  const table: GraphEntity = { key: 'code.table:shop/public.orders', kind: 'code.table', label: 'orders', properties: {}, nodeIds: [], scope: 'repo' };
  const columns = Array.from({ length: 64 }, (_, index) => ({ ...table, key: `code.column:shop/public.orders/column_${index}`, kind: 'code.column', label: `column_${index}`, properties: { table: 'shop/public.orders', name: `column_${index}`, type: 'uuid', primary_key: index === 0 } }));
  const graph = {
    find: async () => [table],
    // A table holds no tables under its key: the columns are what the graph holds there (the data model extractor's facts).
    byPrefix: async (kind: string, prefix: string, limit: number) => (kind === 'code.column' && prefix.startsWith('code.column:shop/public.orders/')
      ? { rows: columns.slice(0, limit), total: columns.length }
      : { rows: [], total: 0 }),
    neighbors: async () => [{ relation: 'code.foreign-key', direction: 'out', total: 1, edges: 2, rows: [{ entity: table, edges: 2 }] }],
    relationEdges: async () => ({ rows: [0, 63].map(index => ({ from: table, to: table, discriminator: `fk_${index}`, properties: { column: `column_${index}` } })), total: 2 }),
  } as unknown as GraphReader;
  const ctx = { graph, manifest: MANIFEST, repoOfScope: () => undefined } as unknown as RenderContext;
  const [view] = await buildViews({ ctx, lang: 'en', productTitle: 'Shop' }, { type: 'er', subject: table.key });
  expect(view!.elements[0]!.columns).toHaveLength(64);
  expect(view!.mermaid).toContain('uuid column_0 PK,FK');
  expect(view!.mermaid).toContain('uuid column_63 FK');
  expect(view!.edges.map(edge => edge.label)).toEqual(['column_0', 'column_63']);
});

for (const mode of ['roots', 'one-group'] as const) test(`oversized deployment ${mode} draws its first forty with all raw facts beside it`, async () => {
  const rows: GraphEntity[] = Array.from({ length: 45 }, (_, index) => ({ key: mode === 'roots' ? `code.dockerfile:deploy/${String(index).padStart(2, '0')}/Dockerfile` : `code.compose-service:compose.yaml#api-${String(index).padStart(2, '0')}`, kind: mode === 'roots' ? 'code.dockerfile' : 'code.compose-service', label: `api-${index}`, properties: {}, nodeIds: [], scope: 'repo' }));
  const facts = rows.slice(1).map((to, index) => ({ from: rows[index]!, to, properties: {} }));
  const graph = { list: async (kind: string) => ({ rows: kind === rows[0]!.kind ? rows : [], total: kind === rows[0]!.kind ? rows.length : 0 }), relationEdges: async (relation: string) => ({ rows: relation === 'code.depends-on' ? facts : [], total: relation === 'code.depends-on' ? facts.length : 0 }) } as unknown as GraphReader;
  const ctx = { graph, manifest: MANIFEST, repoOfScope: () => undefined } as unknown as RenderContext;
  const [view] = await buildViews({ ctx, lang: 'en', productTitle: 'Shop' }, { type: 'deployment', subject: '' });
  expect(view!.elements).toHaveLength(40);
  expect(view!.fullElements).toHaveLength(mode === 'roots' ? 45 : 46);
  expect(view!.marker).toBe(`Showing 40 of ${mode === 'roots' ? 45 : 46}.`);
  const ids = new Set(view!.elements.map(element => element.id));
  for (const element of view!.elements) if (element.parent) expect(ids.has(element.parent)).toBe(true);
  if (mode === 'one-group') {
    expect(view!.fullEdges).toHaveLength(44);
    expect(view!.elements[0]!.id).toBe('file:compose.yaml');
  }
  expect(view!.fullElements!.some(element => element.id.startsWith('folder:'))).toBe(false);
});


// Shared reader repair from graph task commit 9194a67acea12b3c4f324e5f2e008917c64bc496.
test('historical renamed file shows only explicit readable same-scope successor, never old HEAD bytes',async()=>{
 const {sourceBlock}=await import('../src/knowledge/blocks.js');type Context=import('../src/knowledge/blocks.js').RenderContext;
 const span={path:'old.ts',byteStart:0,byteEnd:0,lineStart:1,lineEnd:1};const old={key:'code.file:old.ts',kind:'code.file',label:'old.ts',properties:{},nodeIds:['1'],scope:'scope-a',span};const next={...old,key:'code.file:new.ts',label:'new.ts',span:{...span,path:'new.ts'}};let rows=[{other:next}];const reads:string[]=[];
 const ctx={language:'en',manifest:{kinds:new Map([['code.file',{}]])},repoOfScope:()=> 'fixture',readSource:async(_repo:string|null,path:string)=>{reads.push(path);return path==='new.ts'?'actual successor bytes':undefined;},graph:{edgesOf:async(entity:unknown,relation:string,direction:string)=>{expect(entity).toBe(old);expect(relation).toBe('code.renamed-to');expect(direction).toBe('out');return{total:rows.length,rows};}}} as unknown as Context;
 const result=await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3);expect(result.type).toBe('refs');if(result.type==='refs'){expect(result.total).toBe(1);expect(result.rows[0]?.entity.id).toBe(next.key);expect(result.rows[0]?.entity.location?.path).toBe('new.ts');expect(result.title).toContain('original path is absent');}expect(reads).toEqual(['old.ts','new.ts']);expect(JSON.stringify(result)).not.toContain('actual successor bytes');
 rows=[{other:{...next,scope:'scope-b'}}];expect((await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3)).type).toBe('problem');rows=[];expect((await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3)).type).toBe('problem');rows=[{other:{...next,span:{...span,path:'missing.ts'}}}];expect((await sourceBlock(ctx,{source:'graph',entity:old},{},'templates/file.md',3)).type).toBe('problem');
});

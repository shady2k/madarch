/** Guide-only preparation on the existing temporal graph and pinned Git snapshot. */
import { resolve } from 'node:path';
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import { createGitSnapshotSource, type SnapshotSource } from '../../fill/snapshot.js';
import { resolveLens } from '../../graph/reads.js';
import type { GraphStore } from '../../graph/index.js';
import type { UnitAgent } from '../run.js';
import type { GuideContext, GuideDocument, GuideGround, GuideKind, GuideLocale, GuideProcedure, GuideStep, GuideValidationHost } from './model.js';
import { GUIDE_SCHEMA } from './model.js';
import { registeredGuideOutput, type GuidePreparedUnit, type GuideWriterHost } from './host-contract.js';
import { guideDigest, guideStepDigest, sameGuideContext } from './digest.js';
import { byCodePoint } from '../../model/order.js';
import { createGuidePublication, type GuidePublicationOwner } from './publication.js';
import { readGuideReceipts } from './receipt-read.js';
import { instantText } from '../../graph/time.js';
import { isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';
import { unified } from 'unified';
import { runGit } from '../../product/git.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import remarkParse from 'remark-parse';
import { firstGuideCursor, guidePagesComplete, registerGuidePages, markGuideCurrent } from './prepared.js';
import { parseGuideArtifact } from './artifact.js';
import { ENVIRONMENT_VALUE_RECORDS } from '../../extract/operations/env.js';
import { readSyntaxTree, syntaxLanguageOf, type SyntaxLanguage } from '../../fill/stages/syntax-extract.js';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { KINDS_FILE, parseKinds } from '../../knowledge/kinds.js';
import { splitFrontMatter } from '../../knowledge/markdown.js';
import { QUESTION_KIND, CORRECTION_KIND, parseQuestion, parseCorrection } from '../../loop/entities.js';
import { parseTask } from '../../loop/tasks.js';

export const GUIDE_UNIT_VERSION = 'guide-writer@1';
const MAX_PREPARED_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_ROWS = 1200;
const MAX_SOURCE_LINES = 200;
export interface GuideEvidenceSpan {
  readonly ground: GuideGround; readonly text: string; readonly digest: string;
  /** Private decoded syntax literals from the complete source tree; never sent to the agent or persisted. */
  readonly sourceLiterals?: readonly string[];
  readonly literalReadGap?: boolean;
}
export interface GuidePreparedEvidence {
  readonly context: GuideContext;
  readonly facts: readonly unknown[];
  readonly spans: readonly GuideEvidenceSpan[];
  readonly gaps: readonly string[];
  readonly policy: { readonly version: 'withhold-config-values@1'; readonly withheldValues: number; readonly classifiedSources: readonly string[]; readonly sourceCandidateValues?: number; readonly hostSensitiveValues?: number; readonly ordinaryRefusalExcluded?: number; readonly references?: readonly string[] };
  /** Private source policy values; removed before publication or an agent sees the packet. */
  readonly configValues?: readonly string[];
  readonly configReferences?: readonly { readonly name: string; readonly path: string; readonly value: string }[];
}
/** The actual graph owner lends its snapshot, not an agent-supplied evidence callback. */
export interface GuideWriterWiring {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly snapshots: SnapshotSource;
  readonly output: string;
  readonly scope: string;
  readonly valid: string;
  readonly agent: UnitAgent;
  /** Additional host-known sensitive values; parsed configuration withholding always applies independently. */
  readonly sensitiveValues?: readonly string[];
  readonly containsSecret?: (text: string) => boolean;
  readonly afterWrite?: (path: string) => Promise<void>;
}

/** Resolve all coordinates through the graph's own state-chain policy. */
export async function resolveGuideContext(wiring: Pick<GuideWriterWiring, 'owner' | 'snapshots' | 'valid'>): Promise<GuideContext> {
  const repositories = [];
  for (const pin of await wiring.snapshots.pins()) {
    const reader = await wiring.snapshots.open(pin.id);
    repositories.push({ name: pin.id, commit: reader.commit });
  }
  const lens = await wiring.owner.transaction('snapshot', async (tx) => {
    const time = await tx.query<{ now: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now");
    const now = time.rows[0]?.now;
    if (typeof now !== 'string') throw new Error('guide context: the database did not supply its recorded-time instant');
    return await resolveLens(tx, { valid: wiring.valid }, now);
  });
  return { valid: lens.valid, known: lens.known, state: String(lens.state), repositories: repositories.sort((a, b) => byCodePoint(a.name, b.name)) };
}

const visible = (alias: string): string => `${alias}.valid_from <= $1::timestamptz AND $1::timestamptz < ${alias}.valid_to AND ${alias}.recorded_from <= $2::timestamptz AND $2::timestamptz < ${alias}.recorded_to AND ${alias}.states @> $3::bigint AND ${alias}.scope_id = $4::bigint`;
export interface GuideGraphMembership { readonly nodes: readonly Record<string, unknown>[]; readonly edges: readonly Record<string, unknown>[] }
/** The legacy knowledge graph has its own publication namespace, not fill_fact. */
export async function readGuideGraph(wiring: Pick<GuideWriterWiring, 'owner' | 'scope'>, context: GuideContext, current = false, transaction?: import('../../history/types.js').OuterTransaction): Promise<GuideGraphMembership> {
  const read = async (tx: import('../../history/types.js').OuterTransaction): Promise<GuideGraphMembership> => {
    let known = context.known;
    if (current) {
      const row = (await tx.query<{known:string}>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS known")).rows[0];
      if (row === undefined) throw new Error('guide graph: recorded-time coordinate is unavailable');
      known = row.known;
    }
    const params = [context.valid,known,context.state,wiring.scope,MAX_GRAPH_ROWS];
    let bytes=0;
    const complete=async(sql:string):Promise<Record<string,unknown>[]>=>{
      const rows:Record<string,unknown>[]=[];
      for(let offset=0;;offset+=MAX_GRAPH_ROWS){
        const page=(await tx.query<Record<string,unknown>>(sql,[...params,offset])).rows;
        for(const row of page){bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>MAX_PREPARED_BYTES)throw new Error('guide preparation: complete graph membership exceeds its byte bound; no smaller graph was returned');rows.push(row);}
        if(page.length<MAX_GRAPH_ROWS)return rows;
      }
    };
    const nodes = await complete(`SELECT v.node_id::text AS id,k.key AS kind,v.label,v.properties,v.payload_digest FROM node_version v JOIN node_kind k ON k.id=v.kind_id WHERE ${visible('v')} AND k.key LIKE 'code.%' ORDER BY k.key COLLATE "C",v.node_id,v.id LIMIT $5 OFFSET $6`);
    const edges = await complete(`SELECT v.edge_id::text AS id,r.key AS relation,v.src_id::text AS src,v.dst_id::text AS dst,v.properties,v.payload_digest FROM edge_version v JOIN relation_type r ON r.id=v.relation_type_id WHERE ${visible('v')} AND r.key LIKE 'code.%' AND EXISTS(SELECT 1 FROM node_version s WHERE s.node_id=v.src_id AND ${visible('s')}) AND EXISTS(SELECT 1 FROM node_version d WHERE d.node_id=v.dst_id AND ${visible('d')}) ORDER BY r.key COLLATE "C",v.edge_id,v.id LIMIT $5 OFFSET $6`);
    return {nodes,edges};
  };
  return transaction === undefined ? await wiring.owner.transaction('snapshot', read) : await read(transaction);
}
/** Go literals hold bytes: octal/hex escapes append one byte; Unicode escapes append UTF-8 for one rune. */
function decodedGoLiteral(node:SyntaxNode):string {
  const raw=node.text;
  if(node.type==='raw_string_literal')return raw.slice(1,-1).split('\r').join('');
  const text=raw.slice(1,-1);const bytes:number[]=[];const encoder=new TextEncoder();
  const appendRune=(code:number):void=>{
    if(code>0x10ffff||code>=0xd800&&code<=0xdfff)throw new Error('Go literal escape is not a Unicode scalar');
    bytes.push(...encoder.encode(String.fromCodePoint(code)));
  };
  for(let index=0;index<text.length;index++){
    const character=text[index]!;
    if(character!=='\\'){
      const code=text.codePointAt(index);if(code===undefined)throw new Error('missing Go literal rune');
      appendRune(code);if(code>0xffff)index++;continue;
    }
    const escaped=text[++index];if(escaped===undefined)throw new Error('incomplete Go literal escape');
    const simple:Readonly<Record<string,number>>={a:7,b:8,f:12,n:10,r:13,t:9,v:11,'\\':92,'"':34};
    const simpleByte=simple[escaped];if(simpleByte!==undefined){bytes.push(simpleByte);continue;}
    let digits:string;let radix:number;let octet:boolean;
    if(escaped==='x'||escaped==='u'||escaped==='U'){
      const width=escaped==='x'?2:escaped==='u'?4:8;
      digits=text.slice(index+1,index+1+width);index+=width;radix=16;octet=escaped==='x';
      if(digits.length!==width||[...digits].some((digit)=>!'0123456789abcdefABCDEF'.includes(digit)))throw new Error('invalid Go hexadecimal escape');
    }else if('01234567'.includes(escaped)){
      digits=escaped+text.slice(index+1,index+3);index+=2;radix=8;octet=true;
      if(digits.length!==3||[...digits].some((digit)=>!'01234567'.includes(digit)))throw new Error('invalid Go octal escape');
    }else throw new Error('unsupported Go string escape');
    const code=Number.parseInt(digits,radix);
    if(octet){if(code>255)throw new Error('Go byte escape exceeds one byte');bytes.push(code);}
    else appendRune(code);
  }
  // A non-UTF-8 byte string has no safely comparable text. Preparation withholds its span with a parser gap.
  return new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(bytes));
}

/** Decode only a parser-identified literal. This is not a source-text secret scanner. */
function decodedSyntaxLiteral(node: SyntaxNode, language: SyntaxLanguage): string | undefined {
  const raw = node.text;
  if (language === 'go' && (node.type === 'raw_string_literal' || node.type === 'interpreted_string_literal')) return decodedGoLiteral(node);
  if (node.type !== 'string' && node.type !== 'interpreted_string_literal' && node.type !== 'template_string') return undefined;
  if (node.type === 'template_string' && node.namedChildren.some((child)=>child!==null&&child.type==='template_substitution')) throw new Error('interpolated literal needs complete value proof');
  let value='';
  const text=raw.slice(1,-1);
  for(let index=0;index<text.length;index++){
    const character=text[index]!;
    if(character!=='\\'){value+=character;continue;}
    const escaped=text[++index];if(escaped===undefined)throw new Error('incomplete parsed literal escape');
    if(escaped==='a'){value+=language==='go'?'\x07':'a';continue;}
    const simple:Readonly<Record<string,string>>={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v',a:'\x07','\\':'\\','"':'"',"'":"'",'`':'`'};
    if(Object.hasOwn(simple,escaped)){value+=simple[escaped];continue;}
    if(language!=='go'&&(escaped==='\n'||escaped==='\r')){if(escaped==='\r'&&text[index+1]==='\n')index++;continue;}
    let digits='';let radix=16;
    if(escaped==='x'||escaped==='u'||language==='go'&&escaped==='U'){
      const width=escaped==='x'?2:escaped==='U'?8:4;
      if(escaped==='u'&&language!=='go'&&text[index+1]==='{'){
        index+=2;while(index<text.length&&text[index]!=='}')digits+=text[index++];
        if(text[index]!=='}')throw new Error('incomplete parsed Unicode escape');
      }else{digits=text.slice(index+1,index+1+width);index+=width;if(digits.length!==width)throw new Error('incomplete parsed numeric escape');}
      if(digits.length===0||[...digits].some((digit)=>!('0123456789abcdefABCDEF'.includes(digit))))throw new Error('invalid parsed numeric escape');
    }else if('01234567'.includes(escaped)){
      digits=escaped;radix=8;
      const width=language==='go'?3:escaped<='3'?3:2;
      while(digits.length<width&&text[index+1]!==undefined&&'01234567'.includes(text[index+1]!))digits+=text[++index];
      if(language==='go'&&digits.length!==3)throw new Error('incomplete Go octal escape');
    }else if(language==='go')throw new Error('unsupported Go string escape');
    else{value+=escaped;continue;}
    const code=Number.parseInt(digits,radix);if(code>0x10ffff)throw new Error('parsed literal code point outside Unicode');
    value+=String.fromCodePoint(code);
  }
  return value;
}
async function sourceLiteralValues(path:string,text:string):Promise<{values:readonly {line:number;endLine:number;value:string}[];gap:boolean}>{
  if(path.endsWith('.json')||path.endsWith('.yaml')||path.endsWith('.yml')){
    const documents=parseAllDocuments(text,{uniqueKeys:true});
    const values:{line:number;endLine:number;value:string}[]=[];
    const visit=(node:unknown):void=>{
      if(isMap(node)){for(const pair of node.items)visit(pair.value);}
      else if(isSeq(node)){for(const item of node.items)visit(item);}
      else if(isScalar(node)&&typeof node.value==='string'&&node.range!==undefined&&node.range!==null)values.push({line:text.slice(0,node.range[0]).split('\n').length,endLine:text.slice(0,node.range[1]).split('\n').length,value:node.value});
    };
    for(const document of documents)visit(document.contents);
    return {values,gap:documents.some((document)=>document.errors.length>0)};
  }
  if(syntaxLanguageOf(path)===undefined)return {values:[],gap:false};
  try{
    const parsed=await readSyntaxTree(path,new TextEncoder().encode(text),(file)=>{
      const values:{line:number;endLine:number;value:string}[]=[];
      const visit=(node:SyntaxNode):void=>{
        const value=decodedSyntaxLiteral(node,file.language);
        if(value!==undefined)values.push({line:node.startPosition.row+1,endLine:node.endPosition.row+1,value});
        for(const child of node.namedChildren)if(child!==null)visit(child);
      };visit(file.root);return values;
    });
    return parsed.read?{values:parsed.value,gap:!parsed.complete}:{values:[],gap:true};
  }catch{return {values:[],gap:true};}
}

/** Conservative parsed-config policy: literal configuration values are withheld, not guessed public defaults. */
function configurationReferences(path: string, text: string): readonly { name: string; path: string; value: string }[] {
  if (!path.endsWith('.yaml') && !path.endsWith('.yml') && !path.endsWith('.json')) return [];
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (documents.some((document) => document.errors.length > 0)) throw new Error('guide config policy: a configuration document could not be parsed');
  const values: { name: string; path: string; value: string }[] = [];
  const visit = (node: unknown, name: string): void => {
    if (isMap(node)) { for (const [index, pair] of node.items.entries()) visit(pair.value, `${name}.${isScalar(pair.key) ? String(pair.key.value) : `$key[${index}]`}`); }
    else if (isSeq(node)) { for (const [index, item] of node.items.entries()) visit(item, `${name}[${index}]`); }
    else if (isScalar(node) && node.value !== null && node.value !== undefined) values.push({ name, path, value: String(node.value) });
  };
  for (const [index, document] of documents.entries()) visit(document.contents, `$document[${index}]`);
  return values;
}
const alpha = (character: string): boolean => character.toLowerCase() !== character.toUpperCase();
const numeral = (character: string): boolean => character >= '0' && character <= '9';
/** A lexical shape, not a setting-name heuristic: plain words and numbers are ambiguous public language. */
export function distinctiveGuideValue(value: string): boolean {
  let letters = false; let numbers = false; let structure = false;
  for (const character of value) {
    if (alpha(character)) letters = true;
    else if (numeral(character)) numbers = true;
    else if (character.trim() !== '') structure = true;
  }
  return letters && numbers || (letters || numbers) && structure;
}
/** Delimit fields/path components; hyphens and underscores remain inside a token. */
const tokenBoundary = (character: string): boolean => character.trim() === '' || '/\\"\'()[]{}<>;,'.includes(character);
export function containsGuideSecret(text: string, sensitiveValues: readonly string[] | undefined): boolean {
  const values = new Set((sensitiveValues ?? []).filter((value) => value.length > 0));
  if (values.has(text)) return true;
  let token = '';
  for (const character of text) {
    if (tokenBoundary(character)) { if (values.has(token)) return true; token = ''; }
    else token += character;
  }
  return values.has(token);
}
export function guidePacketPolicy(evidence: GuidePreparedEvidence, knownValues: readonly string[] = [], hostChecker?: (text: string) => boolean): { readonly evidence: GuidePreparedEvidence; readonly sensitiveValues: readonly string[]; readonly containsSecret: (text: string) => boolean } {
  const known = [...new Set(knownValues.filter((value) => value.length > 0))];
  const values = new Set<string>();
  const references = [...(evidence.configReferences ?? [])];
  const classifiedSources: string[] = [...evidence.policy.classifiedSources];
  const valueRows = new Set<unknown>();
  const assignments: { path: string; line: number; endLine: number }[] = [];
  const nodeLabels = new Map(evidence.facts.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)).filter((item) => typeof item['label'] === 'string').map((item) => [String(item['id']), String(item['label'])]));
  for (const item of evidence.facts) {
    if (item === null || typeof item !== 'object') continue;
    const fact = item as Record<string, unknown>;
    const declaration = Object.values(ENVIRONMENT_VALUE_RECORDS).find((record) => (record.record === 'node' ? fact['kind'] : fact['relation']) === record.key);
    if (declaration === undefined || fact['properties'] === null || typeof fact['properties'] !== 'object') continue;
    const properties = fact['properties'] as Record<string, unknown>;
    const value = properties[declaration.field];
    if (typeof value !== 'string') continue;
    values.add(value); valueRows.add(item);
    const name = typeof properties['name'] === 'string' ? properties['name'] : typeof fact['label'] === 'string' ? fact['label'] : nodeLabels.get(String(fact['dst'])) ?? nodeLabels.get(String(fact['src'])) ?? `${String(fact['id'])}.${declaration.field}`;
    const place = properties['span'];
    let path = typeof properties['path'] === 'string' ? properties['path'] : `graph:${String(fact['id'])}`;
    if (place !== null && typeof place === 'object') {
      const span = place as Record<string, unknown>;
      if (typeof span['path'] === 'string' && typeof span['lineStart'] === 'number' && typeof span['lineEnd'] === 'number') {
        path = span['path']; assignments.push({ path, line: span['lineStart'], endLine: span['lineEnd'] });
      }
    }
    references.push({ name, path, value }); classifiedSources.push(`graph:${String(fact['id'])}`);
  }
  for (const value of evidence.configValues ?? []) values.add(value);
  for (const reference of references) values.add(reference.value);
  const distinctive = [...values].filter((value) => value.length > 0 && distinctiveGuideValue(value));
  const sensitiveValues = [...new Set([...known, ...distinctive])];
  const containsSecret = (text: string): boolean => {
    if (hostChecker !== undefined) { const checked = hostChecker(text); if (typeof checked !== 'boolean') throw new Error('host secret authority is unavailable'); if (checked) return true; }
    return known.some((value) => text.includes(value)) || containsGuideSecret(text, distinctive);
  };
  const contains = (value: unknown): boolean => {
    if (typeof value === 'string') return containsSecret(value);
    if (Array.isArray(value)) return value.some(contains);
    if (value === null || typeof value !== 'object') return false;
    return Object.entries(value).some(([name, child]) => containsSecret(name) || contains(child));
  };
  const namedReferences = [...new Set(references.map((reference) => `‹value of ${reference.path}:${reference.name}›`).filter((name) => !containsSecret(name)))].sort(byCodePoint);
  const configPaths = new Set((evidence.configReferences ?? []).map((reference) => reference.path));
  const facts = evidence.facts.map((fact) => {
    if (fact === null || typeof fact !== 'object') return fact;
    const row = fact as Record<string, unknown>;
    // Keep the original only in private dependency membership; no escaped value or payload digest reaches the packet.
    const properties = row['properties'];
    const place = properties !== null && typeof properties === 'object' ? properties as Record<string, unknown> : undefined;
    const span = place?.['span'];
    const fromConfig = typeof place?.['path'] === 'string' && configPaths.has(place['path']) || span !== null && typeof span === 'object' && configPaths.has(String((span as Record<string, unknown>)['path']));
    return valueRows.has(fact) || fromConfig || contains(row) ? { ...(row['id'] === undefined || contains(row['id']) ? {} : { id: row['id'] }), ...(row['kind'] === undefined ? {} : { kind: row['kind'] }), ...(row['relation'] === undefined ? {} : { relation: row['relation'] }), withheld: 'configuration values withheld by source policy', references: namedReferences } : row;
  });
  const spans = evidence.spans.filter((span) => !span.literalReadGap && !configPaths.has(span.ground.path) && !assignments.some((assignment) => assignment.path === span.ground.path && assignment.line <= span.ground.endLine && assignment.endLine >= span.ground.line) && !contains(span.text) && !contains(span.sourceLiterals ?? []))
    .map(({ sourceLiterals: _privateLiterals, literalReadGap: _readGap, ...span }) => span);
  const withheld = evidence.spans.length - spans.length;
  const ordinary = [...values].filter((value) => !distinctiveGuideValue(value)).length;
  const gaps = [...evidence.gaps, `${values.size} configuration values were withheld at their source occurrences; ${namedReferences.length} named setting references remain.`, ...(withheld === 0 ? [] : [`${withheld} source spans contain configuration values or lack complete literal parsing and were withheld; no public or development-default status was inferred.`]), `${ordinary} ordinary configuration values are withheld but excluded from output refusal because their lexical shape is indistinguishable from public words or numbers.`];
  const { configValues: _privateValues, configReferences: _privateReferences, ...publicEvidence } = evidence;
  return { evidence: { ...publicEvidence, facts, spans, gaps, policy: { version: 'withhold-config-values@1', withheldValues: values.size, classifiedSources: [...new Set(classifiedSources)].sort(byCodePoint), sourceCandidateValues: values.size, hostSensitiveValues: known.length, ordinaryRefusalExcluded: ordinary, references: namedReferences } }, sensitiveValues, containsSecret };
}

/** A Markdown entity is derived/loop state only when the product's pinned
 * registry owns its path AND its parsed identity agrees. Frontmatter alone
 * cannot remove an authored source document from freshness or evidence.
 */
export function guideProductEntity(path:string,text:string,manifest:import('../../knowledge/kinds.js').KindsManifest|undefined):boolean {
  if(manifest===undefined||manifest.unreadable)return false;
  const {front}=splitFrontMatter(text);if(front===null)return false;
  const documents=parseAllDocuments(front,{uniqueKeys:true});
  if(documents.length!==1)return false;
  const document=documents[0];if(document===undefined||document.errors.length>0||!isMap(document.contents))return false;
  const contents=document.contents;
  const field=(name:string):unknown=>{const value=contents.items.find((pair)=>isScalar(pair.key)&&pair.key.value===name)?.value;return isScalar(value)?value.value:undefined;};
  const kind=field('kind'),id=field('id');
  if(typeof kind!=='string'||typeof id!=='string'||!id.startsWith(`${kind}:`)||id.length===kind.length+1||id.trim()!==id)return false;
  const declaration=manifest.kinds.get(kind);
  if(declaration?.source!=='markdown'||!(declaration.file===path||(declaration.folder!==undefined&&path.startsWith(`${declaration.folder}/`))))return false;
  // Loop parsers validate their actual schema on the pinned bytes. A malformed
  // record cannot hide authored source by merely claiming a registered kind.
  try {
    if(kind===QUESTION_KIND){parseQuestion(path,text);return true;}
    if(kind===CORRECTION_KIND){parseCorrection(path,text);return true;}
    if(kind==='task'){parseTask(path,text);return true;}
  } catch {return false;}
  // Standard Markdown entities use the shared entity identity/provenance form.
  const producer=field('producer');
  if(producer!==undefined&&producer!=='agent'&&producer!=='person')return false;
  const title=contents.items.find((pair)=>isScalar(pair.key)&&pair.key.value==='title')?.value;
  if(title!==undefined&&(!isScalar(title)||typeof title.value!=='string'))return false;
  for(const name of ['relates','sources']){
    const value=contents.items.find((pair)=>isScalar(pair.key)&&pair.key.value===name)?.value;
    if(value!==undefined&&(!isSeq(value)||value.items.some((item)=>!isScalar(item)||typeof item.value!=='string')))return false;
  }
  return true;
}
async function guideProductRegistry(snapshot:import('../../fill/snapshot.js').SnapshotReader):Promise<import('../../knowledge/kinds.js').KindsManifest|undefined>{
  if(!snapshot.files().some((entry)=>String(entry.path)===KINDS_FILE))return undefined;
  const manifest=parseKinds(await snapshot.readText(KINDS_FILE),join(snapshot.root,KINDS_FILE),snapshot.root);
  if(manifest.unreadable||manifest.findings.length>0)throw new Error(`guide product registry: ${JSON.stringify(manifest.findings)}`);
  return manifest;
}
export async function productDocumentMembership(snapshot: import('../../fill/snapshot.js').SnapshotReader):Promise<string> {
  const documents:{path:string;digest:string}[]=[];
  const manifest=await guideProductRegistry(snapshot);
  // Registry/template bytes define classification. A changed declaration or
  // missing template cannot silently preserve an old dependency set.
  const definitions=new Set(manifest===undefined?[]:[KINDS_FILE,...[...manifest.kinds.values()].map((kind)=>kind.template)]);
  for(const path of [...definitions].sort(byCodePoint))documents.push({path,digest:guideDigest(await snapshot.readText(path))});
  for(const entry of snapshot.files()){
    const path=String(entry.path);if(!guideProductDocument(path)||definitions.has(path))continue;
    const text=await snapshot.readText(path);if(guideProductEntity(path,text,manifest))continue;
    documents.push({path,digest:guideDigest(text)});
  }
  return guideDigest(documents.sort((a,b)=>byCodePoint(a.path,b.path)));
}
async function sourceContextSnapshots(snapshots:SnapshotSource,context:GuideContext):Promise<SnapshotSource|undefined>{
  const pins=await snapshots.pins();
  if(pins.length!==context.repositories.length)return undefined;
  const rebound=[];
  for(const pin of pins){
    const expected=context.repositories.find((repository)=>repository.name===pin.id);if(expected===undefined)return undefined;
    const current=await snapshots.open(pin.id);
    if(current.commit===expected.commit){rebound.push({...pin,commit:expected.commit});continue;}
    if(pin.form!=='product')return undefined;
    const previous=createGitSnapshotSource([{...pin,commit:expected.commit}]);const old=await previous.open(pin.id);
    if(await productDocumentMembership(current)!==await productDocumentMembership(old))return undefined;
    rebound.push({...pin,commit:expected.commit});
  }
  return createGitSnapshotSource(rebound);
}

export function guideProductDocument(path:string):boolean {
  return (path.endsWith('.md')||path.endsWith('.markdown')) && !path.split('/').some((part)=>part.startsWith('.')) && !path.startsWith('repos/') && !path.startsWith('docs/guide-walks/') && !path.startsWith('docs/sources/') && path!=='AGENTS.md' && path!=='CLAUDE.md';
}
/** Each span belongs to this scope's one actual repository pin; no cross-repository path matching. */
export async function prepareGuideEvidence(wiring: Pick<GuideWriterWiring, 'owner' | 'scope' | 'snapshots'>, context: GuideContext): Promise<GuidePreparedEvidence> {
  const codePins=(await wiring.snapshots.pins()).filter((pin)=>pin.form==='code');
  if(codePins.length!==1)throw new Error('guide preparation: this legacy writer needs one actual code scope; no repository was omitted');
  const repository=context.repositories.find((pin)=>pin.name===codePins[0]!.id);
  if(repository===undefined)throw new Error('guide preparation: the actual code repository is absent from the context');
  const reader=await wiring.snapshots.open(repository.name);
  if(reader.commit!==repository.commit) throw new Error('guide preparation: repository pin changed');
  const membership=await readGuideGraph(wiring,context);
  const facts:readonly unknown[]=[...membership.nodes,...membership.edges];
  const spans:GuideEvidenceSpan[]=[];const seen=new Set<string>();const gaps:string[]=[];
  const configValues: string[] = [];const configReferences: { name: string; path: string; value: string }[] = [];const blockedConfigPaths=new Set<string>();const classifiedSources: string[] = [];
  for (const fact of membership.nodes) {
    if(fact['kind']!=='code.file'||fact['properties']===null||typeof fact['properties']!=='object')continue;
    const path=(fact['properties'] as Record<string,unknown>)['path'];
    if(typeof path!=='string'||(!path.endsWith('.yaml')&&!path.endsWith('.yml')&&!path.endsWith('.json')))continue;
    try {const text=await reader.readText(path);const references=configurationReferences(path,text);configReferences.push(...references);configValues.push(...references.map((reference)=>reference.value));classifiedSources.push(`${repository.name}/${path}`);}
    catch{gaps.push(`${repository.name}/${path}:1: configuration policy could not parse the complete pinned file; all its source spans were withheld`);blockedConfigPaths.add(path);}
  }
  // Document paragraphs/lists/code blocks retain parser source ranges. No heading-name heuristic selects roles.
  for (const fact of membership.nodes) {
    if (fact['kind'] !== 'code.file' || fact['properties'] === null || typeof fact['properties'] !== 'object') continue;
    const path = (fact['properties'] as Record<string,unknown>)['path'];
    if (typeof path !== 'string' || (!path.endsWith('.md') && !path.endsWith('.markdown'))) continue;
    let text: string;
    try { text = await reader.readText(path); } catch { gaps.push(`${repository.name}/${path}:1: pinned document is unavailable`); continue; }
    const document = unified().use(remarkParse).parse(text);
    const lines = text.split('\n');
    for (const node of document.children) {
      const start=node.position?.start.line;const end=node.position?.end.line;
      if(start===undefined||end===undefined){gaps.push(`${repository.name}/${path}:1: document node has no exact parser range`);continue;}
      if(end-start+1>MAX_SOURCE_LINES){gaps.push(`${repository.name}/${path}:${start}: document block exceeds ${MAX_SOURCE_LINES} lines; it was not cut`);continue;}
      const ground={repository:repository.name,commit:repository.commit,path,line:start,endLine:end};const key=guideDigest(ground);
      if(seen.has(key))continue;seen.add(key);
      const excerpt=lines.slice(start-1,end).join('\n');spans.push({ground,text:excerpt,digest:guideDigest({ground,text:excerpt})});
    }
  }
  for(const fact of membership.nodes){
    const properties=fact['properties'];
    if(properties===null||typeof properties!=='object') continue;
    const span=(properties as Record<string,unknown>)['span'];
    if(span===null||typeof span!=='object') continue;
    const place=span as Record<string,unknown>;
    if(typeof place['path']!=='string'||!Number.isInteger(place['lineStart'])||!Number.isInteger(place['lineEnd'])){gaps.push(`Graph node ${String(fact['id'])}: source span is malformed`);continue;}
    const ground={repository:repository.name,commit:repository.commit,path:place['path'],line:Number(place['lineStart']),endLine:Number(place['lineEnd'])};
    if(blockedConfigPaths.has(ground.path))continue;
    if(ground.endLine-ground.line+1>MAX_SOURCE_LINES){gaps.push(`${repository.name}/${ground.path}:${ground.line}: source span exceeds ${MAX_SOURCE_LINES} lines; it was not partially supplied`);continue;}
    const key=guideDigest(ground);if(seen.has(key))continue;seen.add(key);
    let text:string;
    try{const lines=(await reader.readText(ground.path)).split('\n');if(ground.line<1||ground.endLine>lines.length)throw new Error('span outside file');text=lines.slice(ground.line-1,ground.endLine).join('\n');}
    catch{gaps.push(`${repository.name}/${ground.path}:${ground.line}: exact pinned bytes are unavailable; no replacement source was supplied`);continue;}
    spans.push({ground,text,digest:guideDigest({ground,text})});
  }
  for(const productPin of (await wiring.snapshots.pins()).filter((pin)=>pin.form==='product')) {
    const product=await wiring.snapshots.open(productPin.id);
    const pinned=context.repositories.find((pin)=>pin.name===productPin.id);
    if(pinned===undefined||pinned.commit!==product.commit)throw new Error('guide product-document pin changed');
    const productRegistry=await guideProductRegistry(product);
    for(const entry of product.files()){
      const path=String(entry.path);
      if(!guideProductDocument(path))continue;
      let text:string;
      try{text=await product.readText(path);}catch{gaps.push(`${productPin.id}/${path}:1: pinned product document is unavailable`);continue;}
      // Only a registry-owned, parsed Markdown entity is derived/loop state.
      if(guideProductEntity(path,text,productRegistry))continue;
      try{const current=await readFile(join(product.root,path),'utf8');if(current!==text){gaps.push(`${productPin.id}/${path}:1: uncommitted product-document changes are not included in pinned grounds`);continue;}}
      catch{gaps.push(`${productPin.id}/${path}:1: working document is unavailable; committed source only was not substituted`);continue;}
      const document=unified().use(remarkParse).parse(text);const lines=text.split('\n');
      for(const node of document.children){const start=node.position?.start.line;const end=node.position?.end.line;if(start===undefined||end===undefined){gaps.push(`${productPin.id}/${path}:1: document node has no parser range`);continue;}if(end-start+1>MAX_SOURCE_LINES){gaps.push(`${productPin.id}/${path}:${start}: document block exceeds ${MAX_SOURCE_LINES} lines; no shortened block was supplied`);continue;}const ground={repository:productPin.id,commit:product.commit,path,line:start,endLine:end};const excerpt=lines.slice(start-1,end).join('\n');spans.push({ground,text:excerpt,digest:guideDigest({ground,text:excerpt})});}
    }
  }
  const sourceLiterals=new Map<string,Awaited<ReturnType<typeof sourceLiteralValues>>>();
  for(let index=0;index<spans.length;index++){
    const span=spans[index]!;
    if(span.ground.path.endsWith('.md')||span.ground.path.endsWith('.markdown'))continue;
    if(syntaxLanguageOf(span.ground.path)===undefined&&!span.ground.path.endsWith('.json')&&!span.ground.path.endsWith('.yaml')&&!span.ground.path.endsWith('.yml')){spans[index]={...span,literalReadGap:true};continue;}
    const key=`${span.ground.repository}:${span.ground.path}`;
    let literals=sourceLiterals.get(key);
    if(literals===undefined){const source=await wiring.snapshots.open(span.ground.repository);literals=await sourceLiteralValues(span.ground.path,await source.readText(span.ground.path));sourceLiterals.set(key,literals);}
    spans[index]={...span,sourceLiterals:literals.values.filter((literal)=>literal.line<=span.ground.endLine&&literal.endLine>=span.ground.line).map((literal)=>literal.value),...(literals.gap?{literalReadGap:true}:{})};
  }
  gaps.push('Source evidence does not certify execution. Procedures without instruction and expected-result proof remain gaps.');
  const evidence:GuidePreparedEvidence={context,facts,spans,gaps,configValues,configReferences,policy:{version:'withhold-config-values@1',withheldValues:configValues.length,classifiedSources}};
  if(Buffer.byteLength(JSON.stringify(evidence))>MAX_PREPARED_BYTES)throw new Error('guide preparation: complete source context exceeds its byte bound; no smaller input was returned');
  return evidence;
}

/** A proposed semantic judgement is independent of the agent's guide payload and bound to exact source bytes. */
export async function verifyGuideStep(agent: UnitAgent, evidence: GuidePreparedEvidence, step: GuideStep, procedure: GuideProcedure, guide: GuideDocument): Promise<readonly string[]> {
  const spans: GuideEvidenceSpan[] = [];
  for (const ground of step.grounds) {
    const held = evidence.spans.find((candidate) => guideDigest(candidate.ground) === guideDigest(ground));
    if (held === undefined) return ['The complete exact pinned source span is not part of the prepared evidence.'];
    spans.push(held);
  }
  if(Buffer.byteLength(JSON.stringify({step,procedure,spans}))>64*1024)return ['The exact semantic verification input exceeds its bounded context; split the step and cite narrower prepared spans.'];
  const identity = guideDigest({ step, procedure: { id: procedure.id, prerequisites: procedure.prerequisites }, context: guide.context, spans });
  let verdict: { instruction: boolean; expected: boolean } | undefined;
  await agent.run({
    id: `guide-proof:${identity}`,
    prompt: ['Judge this proposed procedure step against the exact pinned source and graph facts. It is not a request to execute anything.',
      'Return verify_guide_step once. instructionSupported and expectedSupported are true ONLY if the supplied evidence establishes the exact instruction and its exact expected status AND observation. A resolving citation, plausible convention, nearby string or successful generation is not proof. Missing or contradictory evidence means false. Your judgement is an interpretation, not an extracted fact or an execution receipt.',
      JSON.stringify({ identity, step, procedure: { role: procedure.role, goal: procedure.goal, prerequisites: procedure.prerequisites }, spans, graphMembershipDigest:guideDigest(evidence.facts), coverage:evidence.policy }),
    ].join('\n\n'),
    tools: {
      definitions: [{ name: 'verify_guide_step', description: 'Record the evidence judgement for this exact step.', inputSchema: { type: 'object', additionalProperties: false, properties: { identity: { type: 'string' }, instructionSupported: { type: 'boolean' }, expectedSupported: { type: 'boolean' } }, required: ['identity', 'instructionSupported', 'expectedSupported'] } }],
      finished: () => verdict !== undefined,
      call: async (tool, value) => {
        if (verdict !== undefined || tool !== 'verify_guide_step' || value === null || typeof value !== 'object' || Array.isArray(value)) return { isError: true, answer: { error: 'one typed evidence judgement is required' } };
        const data = value as Record<string, unknown>;
        if (Object.keys(data).length !== 3 || data['identity'] !== identity || typeof data['instructionSupported'] !== 'boolean' || typeof data['expectedSupported'] !== 'boolean') return { isError: true, answer: { error: 'the judgement must bind the exact step and both proof fields' } };
        verdict = { instruction: data['instructionSupported'], expected: data['expectedSupported'] };
        return { isError: false, answer: { recorded: true } };
      },
    },
  });
  return verdict?.instruction === true && verdict.expected === true ? [] : ['The source judgement did not support both the exact instruction and expected result.'];
}

export async function createGuideWriter(baseWiring: GuideWriterWiring): Promise<GuideWriterHost> {
  // Preparation belongs to the guide unit. A refused complete graph must not stop unrelated narrative units.
  return {
    async prepare(kind: GuideKind, locale: GuideLocale): Promise<GuidePreparedUnit> {
      let wiring = baseWiring;
      let context = await resolveGuideContext(wiring);
      const previous = await wiring.owner.run(async (tx) => (await tx.query<{context:GuideContext;membership:string}>(`SELECT v.properties->'context' AS context,v.properties->>'readMembership' AS membership FROM node_version v JOIN node_kind k ON k.id=v.kind_id JOIN work_item w ON w.id=v.opened_by WHERE v.scope_id=$1::bigint AND k.key='guide-artifact' AND w.published_at IS NOT NULL AND w.published_digest IS NOT NULL ORDER BY w.generation DESC,v.id DESC LIMIT 1`,[wiring.scope])).rows[0]);
      if(previous!==undefined && previous.context.valid===context.valid && await sourceContextSnapshots(wiring.snapshots,previous.context)!==undefined) {
        const current=await readGuideGraph(wiring,previous.context,true);
        if(guideDigest([...current.nodes,...current.edges])===previous.membership)context=previous.context;
      }
      const sourceSnapshots=await sourceContextSnapshots(wiring.snapshots,context);
      if(sourceSnapshots===undefined)throw new Error('guide current source membership is incompatible with its prepared context');
      wiring={...wiring,snapshots:sourceSnapshots};
      const privateEvidence = await prepareGuideEvidence(wiring, context);
      const protectedInput = guidePacketPolicy(privateEvidence, wiring.sensitiveValues, wiring.containsSecret);
      const evidence = protectedInput.evidence;
      wiring = { ...wiring, sensitiveValues: protectedInput.sensitiveValues };

      const output = registeredGuideOutput(wiring.output, kind);
      const inputDigest = guideDigest({ kind, locale, version: GUIDE_UNIT_VERSION, evidence });
      const verified = new Set<string>();
      const validation: GuideValidationHost = {
        file: resolve(wiring.output, output.path), expectedContext: context, expectedInputDigest: inputDigest, expectedUnitVersion: GUIDE_UNIT_VERSION,
        containsSecret: protectedInput.containsSecret,
        verifyStep: async (step, procedure, guide) => {
          const result = await verifyGuideStep(wiring.agent, evidence, step, procedure, guide);
          if (result.length === 0) verified.add(guideDigest({ document: guideDigest(guide), step: guideStepDigest(guide, procedure.id, step) }));
          return result;
        },
      };
      const publication: GuidePublicationOwner = { ...wiring, registeredPath: output.path, kind, locale, context, inputDigest, unitVersion: GUIDE_UNIT_VERSION, evidence, readMembership: guideDigest(privateEvidence.facts), verified };
      const publishChecked = await createGuidePublication(publication);
      const prepared: GuidePreparedUnit = {
        prompt: '',
        validation,
        publishChecked: async (request) => {
          if (!guidePagesComplete(prepared)) return { ok:false, diagnostics:[{file:validation.file,line:1,path:'$.context',code:'guide-context-incomplete',message:`${validation.file}:1: $.context: prepared input packets remain unread`}] };
          return await publishChecked(request);
        },
      };
      const entries:unknown[]=[{type:'coverage',context,policy:evidence.policy,facts:evidence.facts.length,spans:evidence.spans.length,gaps:evidence.gaps.length}];
      for(const fact of evidence.facts)entries.push({type:'fact',value:fact});
      for(const span of evidence.spans){
        const lines=span.text.split('\n');
        let offset=0;
        while(offset<lines.length){
          let end=offset+1;
          while(end<lines.length&&Buffer.byteLength(JSON.stringify(lines.slice(offset,end+1)))<8000)end+=1;
          const text=lines.slice(offset,end).join('\n');const ground={...span.ground,line:span.ground.line+offset,endLine:span.ground.line+end-1};
          entries.push({type:'source',ground,text,wholeSpanDigest:span.digest,part:offset===0&&end===lines.length?'whole':'bounded-part'});offset=end;
        }
      }
      for(const gap of evidence.gaps)entries.push({type:'gap',message:gap});
      registerGuidePages(prepared,inputDigest,entries);
      const held = await wiring.owner.run(async(tx)=>(await tx.query<{properties:Record<string,unknown>}>(
        `SELECT v.properties FROM node_version v JOIN node_kind k ON k.id=v.kind_id JOIN work_item w ON w.id=v.opened_by WHERE v.producer=$1 AND v.scope_id=$2::bigint AND k.key='guide-artifact' AND v.properties->>'locale'=$3 AND w.published_at IS NOT NULL AND w.published_digest IS NOT NULL ORDER BY w.generation DESC,v.id DESC LIMIT 1`,[`writer.${kind}`,wiring.scope,locale])).rows[0]?.properties);
      if(held!==undefined&&held['path']===output.path&&typeof held['artifact']==='string'){
        let working:string|undefined;
        try{working=await readFile(resolve(wiring.output,output.path),'utf8');}catch(failure){if((failure as NodeJS.ErrnoException).code!=='ENOENT')throw failure;}
        if(working!==undefined&&working!==held['artifact'])throw new Error('guide externally edited artifact differs from its actual published bytes');
        if(working!==undefined&&held['inputDigest']===inputDigest&&held['unitVersion']===GUIDE_UNIT_VERSION&&sameGuideContext(held['context'] as GuideContext,context)&&held['readMembership']===guideDigest(privateEvidence.facts)&&held['evidenceDigest']===guideDigest(evidence)){
          const durableProof=new Set(Array.isArray(held['verifiedSteps'])?held['verifiedSteps'] as string[]:[]);
          const checked=await parseGuideArtifact(validation.file,working,{
            ...validation,
            verifyStep:async(step,procedure,guide)=>durableProof.has(guideDigest({document:guideDigest(guide),step:guideStepDigest(guide,procedure.id,step)}))?[]:['The exact source interpretation is not durably published.'],
          });
          if(!checked.ok)throw new Error('guide durable current proof did not validate');
          markGuideCurrent(prepared,output.path);
        }
      }
      Object.defineProperty(prepared,'prompt',{value:JSON.stringify({schema:GUIDE_SCHEMA,id:output.id,kind,locale,unitVersion:GUIDE_UNIT_VERSION,inputDigest,context,firstCursor:firstGuideCursor(prepared),instruction:'Read every prepared context packet using read_prepared_context and follow next to null before write_guide. Source parts retain exact ranges; source verification requires their complete named prepared span. Missing evidence is a visible gap.',shape:{title:'localized title',prerequisites:[],gaps:[],procedures:[]}}),enumerable:true});
      return prepared;
    },
  };
}

/** Read the last actually published preparation and semantic judgements, not the artifact's assertions. */
export function createGuideReadFactories(wiring: {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly snapshots: SnapshotSource;
  readonly output: string;
  readonly scopeOf: (repository: string) => string | undefined;
  readonly sensitiveValues?: readonly string[];
  readonly containsSecret?: (text: string) => boolean;
}): { guideContextFor: import('./host.js').GuideContextFor; guideHostFor: import('./host.js').GuideHostFor } {
  const published = async (kind: GuideKind, locale: GuideLocale): Promise<Record<string, unknown> | undefined> => {
    const scopes = (await wiring.snapshots.pins()).filter((pin)=>pin.form==='code').map((pin) => wiring.scopeOf(pin.id));
    if (scopes.length !== 1 || scopes[0] === undefined) return undefined;
    const rows = await wiring.owner.run(async (tx) => (await tx.query<{ properties: Record<string, unknown> }>(
      `SELECT v.properties FROM node_version v JOIN node_kind k ON k.id=v.kind_id JOIN work_item w ON w.id=v.opened_by WHERE v.producer=$1 AND v.scope_id=$2::bigint AND k.key='guide-artifact' AND v.properties->>'locale'=$3 AND w.published_at IS NOT NULL AND w.published_digest IS NOT NULL ORDER BY w.generation DESC,v.id DESC LIMIT 1`, [`writer.${kind}`, scopes[0], locale],
    )).rows);
    return rows[0]?.properties;
  };
  return {
    guideContextFor: async (request) => {
      const held = await published(request.kind, request.locale);
      if (held === undefined) return undefined;
      const context = held['context'] as GuideContext | undefined;
      if (context === undefined || context.valid !== instantText(request.valid, 'guide read', 'valid')) return undefined;
      const actualPins=await wiring.snapshots.pins();
      if(guideDigest([...request.repositories].sort((a,b)=>byCodePoint(a.name,b.name)))!==guideDigest((await Promise.all(actualPins.map(async(pin)=>({name:pin.id,commit:(await wiring.snapshots.open(pin.id)).commit})))).sort((a,b)=>byCodePoint(a.name,b.name))))return undefined;
      if(await sourceContextSnapshots(wiring.snapshots,context)===undefined)return undefined;
      return context;
    },
    guideHostFor: async (request) => {
      const held = await published(request.kind, request.locale);
      if (held === undefined || !sameGuideContext(held['context'] as GuideContext, request.context)) throw new Error('guide source proof is unavailable');
      const evidence = held['evidence'] as GuidePreparedEvidence;
      if (evidence === undefined || guideDigest(evidence) !== held['evidenceDigest']) throw new Error('guide preparation digest is unavailable');
      const sourceSnapshots=await sourceContextSnapshots(wiring.snapshots,request.context);
      if(sourceSnapshots===undefined)throw new Error('guide relevant source membership changed');
      for (const span of evidence.spans) {
        const reader = await sourceSnapshots.open(span.ground.repository);
        if (reader.commit !== span.ground.commit) throw new Error('guide source pin changed');
        const text = (await reader.readText(span.ground.path)).split('\n').slice(span.ground.line-1,span.ground.endLine).join('\n');
        if (guideDigest({ground:span.ground,text}) !== span.digest || (wiring.containsSecret?.(text) === true || containsGuideSecret(text,wiring.sensitiveValues ?? []))) throw new Error('guide source proof changed or is sensitive');
      }
      const codePin = (await wiring.snapshots.pins()).find((pin)=>pin.form==='code');
      const repository = request.context.repositories.find((pin)=>pin.name===codePin?.id);
      if (repository === undefined) throw new Error('guide source scope is unavailable');
      const scope = wiring.scopeOf(repository.name);
      if (scope === undefined) throw new Error('guide source scope is unavailable');
      const privateMembership = await readGuideGraph({ owner: wiring.owner, scope }, request.context, true);
      if (guideDigest([...privateMembership.nodes,...privateMembership.edges]) !== held['readMembership']) throw new Error('guide relevant graph membership changed');
      const privateEvidence = await prepareGuideEvidence({ owner: wiring.owner, scope, snapshots: sourceSnapshots }, request.context);
      const policy = guidePacketPolicy(privateEvidence, wiring.sensitiveValues, wiring.containsSecret);
      if (guideDigest(policy.evidence) !== guideDigest(evidence) || guideDigest({kind:request.kind,locale:request.locale,version:GUIDE_UNIT_VERSION,evidence}) !== held['inputDigest'] || held['unitVersion'] !== GUIDE_UNIT_VERSION) throw new Error('guide prepared input policy, version or evidence changed');
      const verified = new Set(Array.isArray(held['verifiedSteps']) ? held['verifiedSteps'] as string[] : []);
      const output = registeredGuideOutput(wiring.output, request.kind);
      if (held['path'] !== output.path) throw new Error('guide published path differs from the current product registry');
      const file = resolve(wiring.output, output.path);
      const productSource=(await sourceSnapshots.pins()).find((pin)=>pin.form==='product');
      return {
        ...(productSource===undefined?{}:{productRepositoryId:productSource.id}),
        validation: {
          expectedContext: request.context, expectedInputDigest: String(held['inputDigest']), expectedUnitVersion: String(held['unitVersion']),
          containsSecret: policy.containsSecret,
          verifyStep: async (step,procedure,guide) => verified.has(guideDigest({ document: guideDigest(guide), step: guideStepDigest(guide,procedure.id,step) })) ? [] : ['The exact proposed semantic proof is not published for this step.'],
        },
        execution: {
          file, containsSecret: policy.containsSecret,
          verifyExecution: async () => ({ kind: 'unverified', reason: 'No independently enrolled operator execution evidence authority is available.' }),
        },
        readReceipts: async () => await readGuideReceipts(wiring.output,request.kind),
      };
    },
  };
}

/** Product source pin uses the actual repository identity namespace, never a code repository alias. */
export function guideProductPin(output:string,codeNames:readonly string[]):import('../../fill/snapshot.js').RepositoryPin {
  const id='product';
  if(codeNames.includes(id))throw new Error('guide product source: reserved product pin collides with a code repository name');
  const head=runGit(output,['rev-parse','--verify','HEAD^{commit}']);
  if(!head.ok)throw new Error('guide product source: product repository has no readable committed HEAD');
  return {id,form:'product',root:output,commit:head.output.trim()};
}

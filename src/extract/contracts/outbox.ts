/** Bounded outbox inference over copied code facts and PostgreSQL syntax trees. */
import {parsePostgres, type ParseResult} from '../../parsers/postgres.js';
import type {CodeCallFact, CodeExpressionFact, CodeFacts} from '../code/facts.js';
import type {Extraction, ExtractionGap, SourceSpan} from '../records.js';

import {outboxModels} from '../library-models/outbox-models.js';
import {libraryRegistry} from '../library-models/validate.js';

type RecordNode = {[key: string]: unknown};
const record = (value: unknown): RecordNode | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordNode : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const one = <T>(values: readonly T[]): T | undefined => values.length === 1 ? values[0] : undefined;
const contains = (outer: SourceSpan, inner: SourceSpan): boolean => outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;
const same = (a: SourceSpan, b: SourceSpan): boolean => contains(a, b) && contains(b, a);
interface Table {readonly name: string; readonly key: string}
function table(value: unknown): Table | undefined {
  const node = record(value); const name = string(node?.relname);
  if (name === undefined) return undefined;
  // JSON tuples cannot merge a quoted dotted identifier with a qualified name.
  return {name, key: JSON.stringify([string(node?.catalogname) ?? null, string(node?.schemaname) ?? null, name])};
}
export interface OutboxSqlFacts {
  readonly inserts: readonly {table: Table; topic: unknown}[];
  readonly selects: readonly {table: Table; topicIndex: number}[];
}
/** The parser owns SQL tokens, comments, case folding, quoting and statement boundaries. */
export function outboxSqlFacts(parsed: ParseResult): OutboxSqlFacts {
  const inserts: {table: Table; topic: unknown}[] = []; const selects: {table: Table; topicIndex: number}[] = [];
  const visit = (value: unknown, inherited: ReadonlySet<string>): void => {
    if (Array.isArray(value)) { for (const child of value) visit(child, inherited); return; }
    const node = record(value); if (node === undefined) return;
    const insert = record(node.InsertStmt); const select = record(node.SelectStmt);
    const statement = insert ?? select;
    const ctes = list(record(statement?.withClause)?.ctes).flatMap(cte => {
      const held = record(record(cte)?.CommonTableExpr); const name = string(held?.ctename); return name === undefined ? [] : [name];
    });
    const scope = new Set([...inherited, ...ctes]);
    if (insert !== undefined) {
      const target = table(insert.relation);
      const columns = list(insert.cols).map(col => string(record(record(col)?.ResTarget)?.name));
      const at = columns.indexOf(outboxModels.outbox.topicColumn);
      const values = list(record(record(insert.selectStmt)?.SelectStmt)?.valuesLists);
      if (target?.name === outboxModels.outbox.table) {
        if (at < 0 || values.length === 0) inserts.push({table: target, topic: undefined});
        else for (const row of values) {
          const items = list(record(record(row)?.List)?.items);
          inserts.push({table: target, topic: items.length === columns.length ? items[at] : undefined});
        }
      }
    }
    if (select !== undefined) {
      const targets = list(select.targetList);
      const topicIndexes = targets.flatMap((target, at) => {
        const ref = record(record(record(target)?.ResTarget)?.val)?.ColumnRef;
        const fields = list(record(ref)?.fields).map(field => string(record(record(field)?.String)?.sval));
        return fields.at(-1) === outboxModels.outbox.topicColumn ? [at] : [];
      });
      const topicIndex = one(topicIndexes);
      const sources = list(select.fromClause).flatMap(source => {
        const range = record(record(source)?.RangeVar); const held = table(range);
        return held === undefined || (range?.schemaname === undefined && scope.has(held.name)) ? [] : [held];
      });
      // A join or wildcard needs column lineage we do not claim here.
      const source = one(sources);
      if (source?.name === outboxModels.outbox.table && list(select.fromClause).length === 1 && topicIndex !== undefined) selects.push({table: source, topicIndex});
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'InsertStmt' || key === 'SelectStmt') {
        const held = record(child); if (held !== undefined) for (const nested of Object.values(held)) visit(nested, scope);
      } else visit(child, inherited);
    }
  };
  for (const stmt of parsed.stmts ?? []) visit(stmt.stmt, new Set());
  return {inserts, selects};
}
interface Topic {value: string; evidence: SourceSpan[]; constant?: string; constantPath?: string}
export interface OutboxPublication {span: SourceSpan; channel: string; evidence: SourceSpan[]; constant?: string; constantPath?: string}
/** Unknown topics stay unknown. A nearby topic constant is never a default. */
export async function inferOutboxPublications(
  facts: CodeFacts | undefined, code: Extraction | undefined,
  candidates: readonly {span: SourceSpan; channel?: string; evidence: readonly SourceSpan[]}[],
): Promise<{sites: OutboxPublication[]; gaps: ExtractionGap[]}> {
  const sites: OutboxPublication[] = []; const gaps: ExtractionGap[] = [];
  if (facts === undefined || code === undefined || !candidates.some(site => site.channel === undefined)) return {sites, gaps};
  const index = <T>(values: readonly T[], key: (value: T) => string): Map<string, T> => {
    const grouped = new Map<string, T[]>(); for (const value of values) { const id = key(value); grouped.set(id, [...(grouped.get(id) ?? []), value]); }
    return new Map([...grouped].flatMap(([key, values]) => values.length === 1 ? [[key, values[0]!] as const] : []));
  };
  const expressions = index(facts.expressions, node => node.id); const bindings = index(facts.bindings, binding => binding.id);
  const parsedPaths = new Set(facts.files.filter(file => file.parsed).map(file => file.path));
  const expr = (id: string | undefined): CodeExpressionFact | undefined => { const held = id === undefined ? undefined : expressions.get(id); return held !== undefined && held.path === held.span.path && parsedPaths.has(held.path) ? held : undefined; };
  const children = (node: CodeExpressionFact): CodeExpressionFact[] => node.children.flatMap(id => { const held = expr(id); return held !== undefined && contains(node.span, held.span) && held.syntaxKind !== 'comment' ? [held] : []; });
  const field = (node: CodeExpressionFact, name: string): CodeExpressionFact | undefined => { const held = expr(one(node.fields[name] ?? [])); return held !== undefined && node.children.includes(held.id) && contains(node.span, held.span) ? held : undefined; };
  const unwrap = (node: CodeExpressionFact): CodeExpressionFact => {
    const seen = new Set<string>(); let held = node;
    while (['expression_list', 'literal_element', 'parenthesized_expression', 'unary_expression'].includes(held.syntaxKind) && !seen.has(held.id)) {
      seen.add(held.id); const next = one(children(held)); if (next === undefined) break; held = next;
    }
    return held;
  };
  const calls = facts.calls.filter(call => {
    const node = expr(call.expression); return node !== undefined && same(node.span, call.span) && node.callee === call.callee && JSON.stringify(node.arguments ?? []) === JSON.stringify(call.arguments);
  });
  const holder = (span: SourceSpan): string | undefined => one(calls.filter(call => same(call.span, span)))?.holder;
  const targets = (call: CodeCallFact): string[] => {
    const callee = expr(call.callee); if (callee === undefined) return [];
    const keys = facts.sites.filter(site => site.use === 'call' && site.holder === call.holder && contains(callee.span, site.span)).flatMap(site => [site.to, ...site.fanOut]);
    return [...new Set(keys)].filter(key => code.edges.some(edge => edge.type === 'code.calls' && edge.from === call.holder && edge.to === key));
  };
  const mutated = new Set<string>();
  for (const node of expressions.values()) if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement', 'update_expression', 'inc_statement', 'dec_statement'].includes(node.syntaxKind)) {
    const mark = (target: CodeExpressionFact): void => { if (target.bindingId !== undefined) mutated.add(target.bindingId); for (const child of children(target)) mark(child); };
    if (node.fields.left !== undefined) for (const id of node.fields.left) { const left = expr(id); if (left !== undefined) mark(left); } else mark(node);
  }
  // A write kills only the same storage projection (or one of its parents).
  // The copied grammar and lexical binding IDs own this check, not row names.
  type Projection = {binding: string; members: readonly string[]};
  /**
   * The storage a binding shares with another through a pointer: `a := &row`,
   * `b := a`, `c := *p` all name `row`'s storage, while a value copy (`a := row`)
   * names its own. The copied facts decide this; nothing is matched by name.
   */
  const storageAlias = (node: CodeExpressionFact): CodeExpressionFact | undefined => {
    const seen = new Set<string>();
    let current: CodeExpressionFact | undefined = node;
    let pointer = false;
    while (current !== undefined && current.bindingId !== undefined) {
      const binding = bindings.get(current.bindingId);
      if (binding === undefined || seen.has(binding.id) || seen.size >= 32) return undefined;
      const initial = expr(binding.initializer);
      if (initial === undefined) return pointer ? current : undefined;
      seen.add(binding.id);
      if (initial.syntaxKind === 'unary_expression') pointer = true;
      current = unwrap(initial);
    }
    return pointer ? current : undefined;
  };
  const projection = (raw: CodeExpressionFact): Projection | undefined => {
    const unwrapped = unwrap(raw);
    const node = storageAlias(unwrapped) ?? unwrapped;
    if (node.bindingId !== undefined) return {binding: node.bindingId, members: []};
    const receiver = expr(node.receiver);
    const parent = receiver === undefined ? undefined : projection(receiver);
    return parent === undefined || node.member === undefined ? undefined : {binding: parent.binding, members: [...parent.members, node.member]};
  };
  const writeKinds = new Set(['assignment_expression', 'augmented_assignment_expression', 'assignment_statement', 'short_var_declaration', 'update_expression', 'inc_statement', 'dec_statement']);
  const untouched = (value: CodeExpressionFact, after: SourceSpan, before: SourceSpan): boolean => {
    const selected = projection(value);
    if (selected === undefined || after.path !== before.path || value.path !== before.path || after.byteEnd > before.byteStart) return false;
    const targets = (node: CodeExpressionFact): CodeExpressionFact[] => node.syntaxKind === 'expression_list' ? children(node).flatMap(targets) : [node];
    return ![...expressions.values()].some(write => {
      if (!writeKinds.has(write.syntaxKind) || write.path !== before.path || write.span.byteEnd <= after.byteEnd || write.span.byteStart >= before.byteStart) return false;
      const left = write.fields.left;
      const written = left === undefined ? children(write) : left.flatMap(id => {const held = expr(id); return held === undefined ? [] : [held];});
      if (written.length === 0) return true;
      return written.flatMap(targets).some(target => {
        // Go's blank identifier discards a result; it writes no storage.
        // Other unknown lvalues still invalidate the projection proof.
        if (target.syntaxKind === 'identifier' && target.name === '_' && target.bindingId === undefined && facts.files.some(file => file.path === target.path && file.parsed && file.language === 'go')) return false;
        const changed = projection(target);
        // Unsupported lvalues cannot certify that this value survived.
        if (changed === undefined) return true;
        return changed.binding === selected.binding && changed.members.length <= selected.members.length && changed.members.every((member, at) => member === selected.members[at]);
      });
    });
  };
  const parameters = (key: string): string[] | undefined => {
    const symbol = facts.symbols.find(symbol => symbol.key === key && symbol.callable); if (symbol === undefined) return undefined;
    const fn = one(facts.expressions.filter(node => contains(symbol.span, node.span) && node.span.byteEnd === symbol.span.byteEnd && ['function_declaration', 'method_declaration', 'method_definition'].includes(node.syntaxKind)));
    const params = fn === undefined ? undefined : field(fn, 'parameters'); if (params === undefined) return undefined;
    return children(params).flatMap(param => [...(param.fields.name ?? []), ...(param.fields.pattern ?? [])].flatMap(id => { const name = expr(id); return name?.bindingId === undefined ? [] : [name.bindingId]; }));
  };
  const declarationOf = (id: string): CodeExpressionFact | undefined => one(facts.expressions.filter(node =>
    ['parameter_declaration', 'variadic_parameter_declaration', 'var_spec', 'required_parameter', 'optional_parameter'].includes(node.syntaxKind) &&
    [...(node.fields.name ?? []), ...(node.fields.pattern ?? [])].some(name => expr(name)?.bindingId === id)));
  const declaredField = (node: CodeExpressionFact) => {
    const member = field(node, 'field') ?? field(node, 'property');
    const key = member === undefined ? undefined : one(facts.sites.filter(site => site.use === 'reference' && same(site.span, member.span)).map(site => site.to));
    return key === undefined ? undefined : one((facts.fields ?? []).filter(held => held.key === key));
  };
  const importedType = (raw: CodeExpressionFact): string | undefined => {
    let node = raw; let pointer = false;
    while (['type_annotation', 'pointer_type', 'parenthesized_type'].includes(node.syntaxKind)) {
      if (node.syntaxKind === 'pointer_type') {if (pointer) return undefined; pointer = true;}
      const next = one(children(node)); if (next === undefined) return undefined; node = next;
    }
    if (node.syntaxKind !== 'qualified_type') return undefined;
    const pkg = field(node, 'package'); const name = field(node, 'name');
    const binding = pkg?.bindingId === undefined ? undefined : bindings.get(pkg.bindingId);
    const imported = binding?.kind !== 'import' ? undefined : facts.imports.find(held => held.id === binding.importId && held.path === pkg?.path && held.targetPath === undefined);
    return one(outboxModels.receivers.filter(model => model.package === imported?.specifier && model.pointer === pointer && model.exportedPath.length === 1 && model.exportedPath[0] === name?.name))?.id;
  };
  const sqlReceiver = (raw: CodeExpressionFact, seen = new Set<string>()): string | undefined => {
    const node = unwrap(raw); if (seen.has(node.id) || seen.size >= 40) return undefined; seen = new Set([...seen, node.id]);
    const binding = node.bindingId === undefined ? undefined : bindings.get(node.bindingId);
    if (binding !== undefined && (!contains(binding.scope, node.span) || mutated.has(binding.id))) return undefined;
    if (binding?.initializer !== undefined) {const initial = expr(binding.initializer); if (initial !== undefined) return sqlReceiver(initial, seen);}
    if (binding !== undefined) {
      const declared = declarationOf(binding.id); const type = declared === undefined ? undefined : field(declared, 'type');
      const identity = type === undefined ? undefined : importedType(type); if (identity !== undefined) return identity;
      if (binding.kind === 'parameter') {
        const owner = one(facts.symbols.filter(symbol => symbol.callable && contains(symbol.span, binding.span)));
        const at = owner === undefined ? -1 : parameters(owner.key)?.indexOf(binding.id) ?? -1;
        const incoming = owner === undefined ? [] : calls.filter(call => targets(call).includes(owner.key));
        if (at >= 0 && incoming.length > 0) {
          const identities = incoming.map(call => {const arg = expr(call.arguments[at]); return arg === undefined ? undefined : sqlReceiver(arg, seen);});
          return identities.every(identity => identity !== undefined && identity === identities[0]) ? identities[0] : undefined;
        }
      }
    }
    if (node.receiver !== undefined) {
      const declared = declaredField(node); const type = expr(declared?.typeExpression);
      if (type !== undefined) return importedType(type);
    }
    const call = one(calls.filter(call => call.expression === node.id));
    const callee = call === undefined ? undefined : expr(call.callee);
    const receiver = expr(callee?.receiver); const identity = receiver === undefined ? undefined : sqlReceiver(receiver, seen);
    return one(outboxModels.factories.filter(model => model.member === callee?.member && identity !== undefined && model.receiverIds.includes(identity)))?.returns;
  };
  const constantAt = (node: CodeExpressionFact): typeof facts.bindings[number] | undefined => {
    const references = facts.sites.filter(site => site.use === 'reference' && contains(node.span, site.span));
    const symbol = one([...new Set(references.map(site => site.to))]);
    const declared = facts.symbols.find(held => held.key === symbol); if (declared === undefined) return undefined;
    const binding = one(facts.bindings.filter(held => held.kind === 'local' && contains(declared.span, held.span)));
    return binding;
  };
  const resolve = (raw: CodeExpressionFact, seen = new Set<string>()): Topic[] | undefined => {
    const node = unwrap(raw); if (seen.has(node.id) || seen.size >= 40) return undefined; seen = new Set([...seen, node.id]);
    if (node.literal?.kind === 'string' && typeof node.literal.value === 'string') return [{value: node.literal.value, evidence: [node.span]}];
    const binding = node.bindingId === undefined ? undefined : bindings.get(node.bindingId);
    if (binding !== undefined && mutated.has(binding.id)) return undefined;
    if (binding?.initializer !== undefined) {
      const value = expr(binding.initializer); const found = value === undefined ? undefined : resolve(value, seen);
      return found?.map(topic => ({...topic, evidence: [...topic.evidence, binding.span], ...(topic.constant === undefined ? {constant: binding.name, constantPath: binding.path} : {})}));
    }
    if (binding?.kind === 'parameter') {
      const owner = one(facts.symbols.filter(symbol => symbol.callable && symbol.bodySpan !== undefined && contains(symbol.span, binding.span)));
      const at = owner === undefined ? -1 : parameters(owner.key)?.indexOf(binding.id) ?? -1;
      const incoming = owner === undefined ? [] : calls.filter(call => targets(call).includes(owner.key));
      if (at < 0 || incoming.length === 0) return undefined;
      const values: Topic[] = [];
      for (const call of incoming) { const arg = expr(call.arguments[at]); const found = arg === undefined ? undefined : resolve(arg, seen); if (found === undefined) return undefined; values.push(...found.map(topic => ({...topic, evidence: [...topic.evidence, call.span]}))); }
      return values;
    }
    // A receiver field must reference the exact declared field, then its real
    // composite-literal initializer, not another same-spelled field/service.
    if (node.receiver !== undefined && node.member !== undefined) {
      const member = field(node, 'field') ?? field(node, 'property');
      const key = member === undefined ? undefined : one(facts.sites.filter(site => site.use === 'reference' && same(site.span, member.span)).map(site => site.to));
      const declared = one((facts.fields ?? []).filter(held => held.key === key));
      if (declared !== undefined) {
        const composites = facts.expressions.filter(held => held.compositeType?.declarationExpression === declared.ownerDeclaration);
        const values: Topic[] = [];
        for (const composite of composites) {
          const body = field(composite, 'body'); if (body === undefined) return undefined;
          const selected = children(body).flatMap(pair => {
            if (pair.syntaxKind !== 'keyed_element') return [];
            const parts = children(pair); const key = parts[0] === undefined ? undefined : unwrap(parts[0]);
            return key?.name === declared.name && parts.length === 2 ? [parts[1]!] : [];
          });
          const value = one(selected); const found = value === undefined ? undefined : resolve(value, seen); if (found === undefined) return undefined;
          values.push(...found);
        }
        if (values.length > 0) return values;
      }
      const constant = constantAt(node); const value = expr(constant?.initializer);
      if (value !== undefined && constant !== undefined) return resolve(value, seen)?.map(topic => ({...topic, constant: constant.name, constantPath: constant.path}));
    }
    return undefined;
  };
  type Query = {call: CodeCallFact; literal: CodeExpressionFact; shape: OutboxSqlFacts; values: number};
  const queries: Query[] = [];
  const cache = new Map<string, OutboxSqlFacts | undefined>();
  for (const call of calls) {
    const callee = expr(call.callee); const receiver = expr(callee?.receiver); const identity = receiver === undefined ? undefined : sqlReceiver(receiver);
    const model = one(outboxModels.operations.filter(model => model.member === callee?.member && identity !== undefined && model.receiverIds.includes(identity)));
    if (model === undefined) {
      if (outboxModels.operations.some(model => model.member === callee?.member)) gaps.push({path: call.path, reason: `contracts: line ${call.span.lineStart}: SQL candidate receiver has no exact imported database identity (${call.path})`});
      continue;
    }
    const arg = expr(call.arguments[model.sql]); if (arg === undefined) continue;
    const literal = unwrap(arg); if (literal.literal?.kind !== 'string' || typeof literal.literal.value !== 'string') continue;
    const sql = literal.literal.value;
    if (!cache.has(sql)) { try { cache.set(sql, outboxSqlFacts(await parsePostgres(sql))); } catch { cache.set(sql, undefined); } }
    const shape = cache.get(sql); if (shape !== undefined) queries.push({call, literal, shape, values: model.values});
  }
  const service = (path: string): string | undefined => { const parts = path.split('/'); return parts[0] === 'services' && parts.length >= 3 ? parts[1] : undefined; };
  const inserted: {query: Query; table: Table; topics: Topic[] | undefined}[] = [];
  for (const query of queries) for (const insert of query.shape.inserts) {
    const topic = record(insert.topic); const literal = string(record(record(topic?.A_Const)?.sval)?.sval);
    const param = record(topic?.ParamRef)?.number; let topics: Topic[] | undefined;
    if (literal !== undefined) topics = [{value: literal, evidence: [query.literal.span]}];
    else if (typeof param === 'number' && Number.isInteger(param) && param > 0) { const value = expr(query.call.arguments[query.values + param - 1]); topics = value === undefined ? undefined : resolve(value); }
    inserted.push({query, table: insert.table, topics});
  }
  for (const candidate of candidates) {
    if (candidate.channel !== undefined) continue;
    const owner = holder(candidate.span); if (owner === undefined) continue;
    for (const read of queries) for (const select of read.shape.selects) {
      if (service(candidate.span.path) === undefined || service(candidate.span.path) !== service(read.call.path)) continue;
      // The scan receiver must be the binding initialized by this exact query.
      const rowBindings = facts.bindings.filter(binding => binding.initializer === read.call.expression);
      const scan = calls.filter(call => call.holder === read.call.holder && expr(call.callee)?.member === outboxModels.scan.member && rowBindings.some(binding => expr(expr(call.callee)?.receiver)?.bindingId === binding.id));
      const scanned = one(scan); const scannedTopic = scanned === undefined ? undefined : expr(scanned.arguments[select.topicIndex]);
      const scanReceiver = scanned === undefined ? undefined : expr(expr(scanned.callee)?.receiver);
      if (scanned === undefined || scanReceiver === undefined || !untouched(scanReceiver, read.call.span, scanned.span)) continue;
      const topic = scannedTopic === undefined ? undefined : unwrap(scannedTopic); if (topic?.member !== outboxModels.outbox.topicColumn) continue;
      const candidateCall = one(calls.filter(call => same(call.span, candidate.span)));
      if (candidateCall === undefined) continue;
      // Select only the direct Kafka Message.Topic pair. Nested decoys cannot
      // supply the actual producer argument.
      const producerModel = one(libraryRegistry.models.filter(model => model.effect === 'message-publish' && model.ecosystem === 'go' && model.target.kind === 'member' && model.target.member === expr(candidateCall.callee)?.member));
      const selector = producerModel?.arguments.find(argument => argument.name === 'topic');
      if (selector === undefined || selector.path.length !== 1) continue;
      const messageTopics = candidateCall.arguments.slice(selector.index).flatMap(id => {
        const arg = expr(id); if (arg?.syntaxKind !== 'composite_literal') return [];
        const body = field(arg, 'body'); if (body === undefined) return [];
        return children(body).flatMap(pair => {
          const parts = children(pair);
          return pair.syntaxKind === 'keyed_element' && parts.length === 2 && unwrap(parts[0]!).name === selector.path[0] ? [unwrap(parts[1]!)] : [];
        });
      });
      const actual = one(messageTopics); if (actual === undefined) continue;
      const topicParameter = actual.bindingId === undefined ? undefined : bindings.get(actual.bindingId);
      const at = topicParameter?.kind === 'parameter' ? parameters(owner)?.indexOf(topicParameter.id) ?? -1 : -1;
      if (at >= 0 && topicParameter !== undefined && !untouched(actual, topicParameter.span, candidateCall.span)) continue;
      const downstream = calls.filter(call => call.holder === read.call.holder && (call.expression === candidateCall.expression || targets(call).includes(owner)));
      const sameRow = (value: CodeExpressionFact, call: CodeCallFact): boolean => {
        if (value.member !== topic.member || value.receiver === undefined || topic.receiver === undefined) return false;
        const row = expr(value.receiver); const scannedRow = expr(topic.receiver);
        if (row === undefined || scannedRow === undefined) return false;
        if (row.bindingId !== undefined && row.bindingId === scannedRow.bindingId) return untouched(topic, scanned.span, call.span);
        // Same property projection on an exactly transferred row value needs
        // no independent field-name lookup or guessed owner type.
        // Range transfers require the copied item binding and its exact scope.
        // Missing range identities are a gap, never a spelling match.
        const ranges = facts.expressions.filter(node => node.syntaxKind === 'for_statement' && contains(node.span, call.span));
        return ranges.some(loop => {
          const clause = one(children(loop).filter(node => node.syntaxKind === 'range_clause')); if (clause === undefined) return false;
          const left = field(clause, 'left'); const right = field(clause, 'right'); const body = field(loop, 'body');
          const selections = left === undefined ? [] : children(left);
          const item = selections.length === 2 ? selections[1] : undefined;
          const collection = right === undefined ? undefined : unwrap(right);
          const itemBinding = item?.bindingId === undefined ? undefined : bindings.get(item.bindingId);
          if (left?.syntaxKind !== 'expression_list' || selections.some(selection => selection.syntaxKind !== 'identifier') ||
            item?.syntaxKind !== 'identifier' || itemBinding?.kind !== 'local' || itemBinding.path !== loop.path ||
            !same(itemBinding.span, item.span) || itemBinding.initializer !== undefined || itemBinding.id !== row.bindingId ||
            !same(loop.span, itemBinding.scope) || body === undefined || !contains(body.span, call.span) || !contains(body.span, row.span) ||
            !untouched(value, left.span, call.span) || collection?.bindingId === undefined) return false;
          if (itemBinding.goRange?.clauseExpression !== clause.id || itemBinding.goRange.collectionExpression !== right?.id || itemBinding.goRange.ordinal !== 1 || itemBinding.goRange.role !== 'value') return false;
          return calls.some(append => {
            const callee = expr(append.callee);
            if (append.holder !== read.call.holder || callee?.name !== outboxModels.append.builtin || callee.bindingId !== undefined || append.span.byteStart >= loop.span.byteStart) return false;
            if (facts.bindings.some(binding => binding.path === callee.path && binding.name === outboxModels.append.builtin && contains(binding.scope, callee.span)) || facts.symbols.some(symbol => symbol.path === callee.path && symbol.name === outboxModels.append.builtin)) return false;
            const first = expr(append.arguments[outboxModels.append.collection]); const second = expr(append.arguments[outboxModels.append.element]);
            if (first?.bindingId !== collection.bindingId || second?.bindingId === undefined || second.bindingId !== scannedRow.bindingId || !untouched(topic, scanned.span, append.span)) return false;
            const appended = facts.expressions.some(assignment => assignment.syntaxKind === 'assignment_statement' && contains(assignment.span, append.span) &&
              (assignment.fields.left ?? []).some(id => {const held = expr(id); return held !== undefined && children(held).some(target => target.bindingId === collection.bindingId);}));
            // The batch the range walks must be the batch this append filled: a
            // reassignment between the append and the range clause loses it.
            const survivesToRange = ![...expressions.values()].some(write => {
              if (!writeKinds.has(write.syntaxKind) || write.path !== append.path) return false;
              if (write.span.byteEnd <= append.span.byteEnd || write.span.byteStart >= clause.span.byteStart) return false;
              return (write.fields.left ?? []).flatMap(id => {const held = expr(id); return held === undefined ? [] : [held];})
                .some(target => {const changed = projection(target); return changed !== undefined && changed.binding === collection.bindingId;});
            });
            return appended && survivesToRange;
          });
        });
      };
      // Match the producer's actual topic position, never any other argument.
      const send = one(downstream.filter(call => {
        const value = call.expression === candidateCall.expression ? actual : at < 0 ? undefined : expr(call.arguments[at]);
        return value !== undefined && sameRow(unwrap(value), call);
      }));
      if (send === undefined) continue;
      const writes = inserted.filter(write => write.table.key === select.table.key && service(write.query.call.path) === service(read.call.path));
      if (writes.length === 0 || writes.some(write => write.topics === undefined || write.topics.length === 0)) continue;
      const topics = writes.flatMap(write => write.topics ?? []); const channels = new Set(topics.map(topic => topic.value));
      if (channels.size !== 1) continue;
      const chosen = topics[0]!;
      sites.push({span: candidate.span, channel: chosen.value, ...(chosen.constant === undefined ? {} : {constant: chosen.constant, constantPath: chosen.constantPath}), evidence: [...candidate.evidence, read.literal.span, scanned!.span, send.span, ...writes.flatMap(write => [write.query.literal.span, ...(write.topics ?? []).flatMap(topic => topic.evidence)])]});
    }
  }
  for (const candidate of candidates) if (candidate.channel === undefined && !sites.some(site => same(site.span, candidate.span))) {
    gaps.push({path: candidate.span.path, reason: `contracts: line ${candidate.span.lineStart}: outbox topic/SQL receiver/row transfer is not proved by the supplied code facts (${candidate.span.path})`});
  }
  return {sites, gaps};
}

import { resolve } from 'node:path';
import type { GateModule } from './gates.js';

type Node = Record<string, unknown>;
interface Context { readonly nodes: readonly Node[]; readonly parents: Map<Node, readonly Node[]> }
const contexts = new WeakMap<GateModule, Context>();
function context(module: GateModule): Context {
  const cached = contexts.get(module);
  if (cached !== undefined) return cached;
  const nodes: Node[] = [], parents = new Map<Node, readonly Node[]>();
  const walk = (value: unknown, ancestors: readonly Node[]): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item, ancestors); return; }
    if (value === null || typeof value !== 'object') return;
    const node = value as Node, typed = typeof node['type'] === 'string';
    if (typed) { nodes.push(node); parents.set(node, ancestors); }
    for (const [key, child] of Object.entries(node)) {
      if (!['parent', 'span', 'ctxt'].includes(key)) walk(child, typed ? [node, ...ancestors] : ancestors);
    }
  };
  walk(module.tree, []);
  const result = { nodes, parents }; contexts.set(module, result); return result;
}
function parents(module: GateModule, node: Node): readonly Node[] { return context(module).parents.get(node) ?? []; }
function named(node: unknown, name: string): boolean {
  return node !== null && typeof node === 'object' && (node as Node)['type'] === 'Identifier' && (node as Node)['value'] === name;
}
function same(left: Node | null | undefined, right: Node | null | undefined): boolean {
  return left?.['type'] === 'Identifier' && right?.['type'] === 'Identifier' && left['value'] === right['value'] && left['ctxt'] === right['ctxt'];
}
function value(node: Node | null | undefined): string | undefined { return node?.['type'] === 'StringLiteral' ? node['value'] as string : undefined; }
function typeOf(node: Node | null | undefined): Node | undefined {
  const annotation = node?.['typeAnnotation'] as Node | undefined;
  return annotation?.['type'] === 'TsTypeAnnotation' ? annotation['typeAnnotation'] as Node : annotation;
}
function exported(module: GateModule, node: Node): boolean { return parents(module, node)[0]?.['type'] === 'ExportDeclaration'; }
interface Declaration { readonly module: GateModule; readonly node: Node }

/** Resolve the actual lexical declaration, including renamed named imports; spelling alone grants nothing. */
function declaration(module: GateModule, identifier: Node, modules: Map<string, GateModule>): Declaration | undefined {
  for (const scope of [...parents(module, identifier), module.tree]) {
    const candidates = context(module).nodes.filter(node => {
      if (!['TsInterfaceDeclaration', 'TsTypeAliasDeclaration'].includes(String(node['type']))) return false;
      const id = node['id'] as Node;
      if (!same(id, identifier)) return false;
      const owner = parents(module, node).find(parent => ['Module', 'Script', 'BlockStatement', 'TsModuleBlock'].includes(String(parent['type'])));
      return owner === scope;
    });
    if (candidates.length === 1) return { module, node: candidates[0]! };
  }
  for (const entry of context(module).nodes) {
    if (entry['type'] !== 'ImportDeclaration') continue;
    const specifier = (entry['specifiers'] as Node[]).find(item => item['type'] === 'ImportSpecifier' && same(item['local'] as Node, identifier));
    if (specifier === undefined) continue;
    const path = resolve('/', module.file, '..', value(entry['source'] as Node) ?? '').replace(/\.js$/u, '.ts').slice(1);
    const authority = modules.get(path);
    if (authority === undefined) return undefined;
    const imported = specifier['imported'] ?? specifier['local'];
    const target = context(authority).nodes.find(item => ['TsInterfaceDeclaration', 'TsTypeAliasDeclaration'].includes(String(item['type']))
      && named(item['id'], String((imported as Node)['value'])) && exported(authority, item));
    return target === undefined ? undefined : { module: authority, node: target };
  }
  return undefined;
}
function isDeclaration(held: Declaration | undefined, file: string, name: string): boolean {
  return held !== undefined && held.module.file === file && named(held.node['id'], name) && exported(held.module, held.node);
}
function reference(module: GateModule, type: Node | null | undefined, modules: Map<string, GateModule>): Declaration | undefined {
  return type != null && type['type'] === 'TsTypeReference' && (type['typeName'] as Node)?.['type'] === 'Identifier'
    ? declaration(module, type['typeName'] as Node, modules) : undefined;
}
function member(module: GateModule, type: Node, key: string, modules: Map<string, GateModule>, depth = 0): { module: GateModule; type: Node } | undefined {
  if (depth > 8) return undefined;
  if (type['type'] === 'TsUnionType') {
    const parts = (type['types'] as Node[]).filter(part => !(part['type'] === 'TsKeywordType' && ['undefined', 'null'].includes(String(part['kind']))));
    const slots = parts.map(part => member(module, part, key, modules, depth + 1));
    const first = slots[0];
    return first !== undefined && slots.every(slot => slot !== undefined && equivalentType(first.module, first.type, slot.module, slot.type, modules)) ? first : undefined;
  }
  if (type['type'] === 'TsTypeLiteral') {
    const property = (type['members'] as Node[]).find(part => part['type'] === 'TsPropertySignature' && named(part['key'], key));
    const held = property === undefined ? undefined : typeOf(property);
    return held === undefined ? undefined : { module, type: held };
  }
  if (type['type'] === 'TsTypeReference' && named(type['typeName'], 'Pick')) {
    const args = (type['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined;
    if (args?.length !== 2 || args[1]?.['type'] !== 'TsLiteralType' || value(args[1]['literal'] as Node) !== key) return undefined;
    return member(module, args[0]!, key, modules, depth + 1);
  }
  const held = reference(module, type, modules);
  if (held === undefined) return undefined;
  if (held.node['type'] === 'TsTypeAliasDeclaration') return member(held.module, held.node['typeAnnotation'] as Node, key, modules, depth + 1);
  const body = held.node['body'] as Node;
  const property = (body['body'] as Node[]).find(part => ['TsPropertySignature', 'TsMethodSignature'].includes(String(part['type'])) && named(part['key'], key));
  if (property === undefined) return undefined;
  return { module: held.module, type: typeOf(property) ?? property };
}

function equivalentType(leftModule: GateModule, left: Node, rightModule: GateModule, right: Node, modules: Map<string, GateModule>): boolean {
  if (left === right && leftModule === rightModule) return true;
  const leftElement = arrayElement(left), rightElement = arrayElement(right);
  if (leftElement !== undefined && rightElement !== undefined) return equivalentType(leftModule, leftElement, rightModule, rightElement, modules);
  const leftDeclaration = reference(leftModule, left, modules), rightDeclaration = reference(rightModule, right, modules);
  return leftDeclaration !== undefined && rightDeclaration !== undefined && leftDeclaration.node === rightDeclaration.node && leftDeclaration.module === rightDeclaration.module;
}
function arrayElement(type: Node): Node | undefined {
  if (type['type'] === 'TsTypeOperator' && type['op'] === 'readonly') return arrayElement(type['typeAnnotation'] as Node);
  return type['type'] === 'TsArrayType' ? type['elemType'] as Node : undefined;
}
function expressionType(module: GateModule, expression: Node, modules: Map<string, GateModule>, depth = 0): { module: GateModule; type: Node } | undefined {
  if (depth > 12) return undefined;
  const infer = (part: Node) => expressionType(module, part, modules, depth + 1);
  if (expression['type'] === 'TsNonNullExpression' || expression['type'] === 'ParenthesisExpression') return infer(expression['expression'] as Node);
  if (expression['type'] === 'OptionalChainingExpression') return infer(expression['base'] as Node);
  if (expression['type'] === 'NewExpression' && named(expression['callee'], 'Map')) {
    const callee = expression['callee'] as Node;
    if (context(module).nodes.some(node => ['VariableDeclarator', 'ClassDeclaration', 'FunctionDeclaration', 'ImportSpecifier', 'ImportDefaultSpecifier'].includes(String(node['type']))
      && [node['id'], node['identifier'], node['local']].some(binding => binding != null && same(binding as Node, callee)))) return undefined;
    if (parents(module, expression).some(scope => {
      const params = ((scope['function'] ?? scope) as Node)['params'];
      return Array.isArray(params) && params.some(parameter => same(((parameter as Node)['pat'] ?? parameter) as Node, callee));
    })) return undefined;
    const args = (expression['typeArguments'] as Node | undefined)?.['params'] as Node[] | undefined;
    return args?.length === 2 ? { module, type: { type: 'TsTypeReference', typeName: expression['callee'], typeParams: { params: args } } } : undefined;
  }
  if (expression['type'] === 'CallExpression') {
    const callee = expression['callee'] as Node;
    if (callee['type'] !== 'MemberExpression' || !named(callee['property'], 'get')) return undefined;
    const receiver = infer(callee['object'] as Node);
    if (receiver?.type['type'] !== 'TsTypeReference' || !named(receiver.type['typeName'], 'Map')) return undefined;
    const args = (receiver.type['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined;
    return args?.length === 2 ? { module: receiver.module, type: args[1]! } : undefined;
  }
  if (expression['type'] === 'ArrayExpression') {
    const elements = expression['elements'] as { spread?: unknown; expression: Node }[];
    const types = elements.map(element => element.spread == null ? undefined : infer(element.expression));
    if (types.some(type => type === undefined)) return undefined;
    const itemTypes = types.map(type => arrayElement(type!.type));
    if (itemTypes.some(type => type === undefined)) return undefined;
    const first = types[0];
    if (first === undefined || !types.every(type => type!.module === first.module)) return undefined;
    return { module: first.module, type: { type: 'TsArrayType', elemType: { type: 'TsUnionType', types: itemTypes } } };
  }
  if (expression['type'] === 'Identifier') {
    for (const scope of parents(module, expression)) {
      const fn = (scope['function'] ?? scope) as Node;
      const params = fn['params'];
      if (Array.isArray(params)) {
        const binding = params.map(item => (item as Node)['pat'] ?? item).find(item => same(item as Node, expression)) as Node | undefined;
        if (binding !== undefined) {
          const type = typeOf(binding);
          if (type != null) return { module, type };
          if (scope['type'] === 'ArrowFunctionExpression' && same((params[0] as Node), expression)) {
            const call = parents(module, scope)[0], callee = call?.['callee'] as Node | undefined;
            if (call?.['type'] === 'CallExpression' && (call['arguments'] as { expression: Node }[])[0]?.expression === scope
              && callee?.['type'] === 'MemberExpression' && named(callee['property'], 'map')) {
              const collection = infer(callee['object'] as Node), element = collection === undefined ? undefined : arrayElement(collection.type);
              return collection === undefined || element === undefined ? undefined : { module: collection.module, type: element };
            }
          }
          return undefined;
        }
      }
      if (scope['type'] === 'ForOfStatement') {
        const left = scope['left'] as Node;
        const binding = context(module).nodes.find(node => node['type'] === 'VariableDeclarator'
          && parents(module, node).includes(left) && same(node['id'] as Node, expression));
        if (binding !== undefined) {
          const collection = infer(scope['right'] as Node);
          const type = collection === undefined ? undefined : arrayElement(collection.type);
          return type === undefined || collection === undefined ? undefined : { module: collection.module, type };
        }
      }
      if (!['BlockStatement', 'Module'].includes(String(scope['type']))) continue;
      const bindings = context(module).nodes.filter(node => node['type'] === 'VariableDeclarator' && same(node['id'] as Node, expression)
        && parents(module, node).find(parent => ['BlockStatement', 'Module', 'ForOfStatement', 'ForInStatement', 'ForStatement'].includes(String(parent['type']))) === scope);
      if (bindings.length === 1) {
        const binding = bindings[0]!, type = typeOf(binding['id'] as Node);
        if (type != null) {
          if (type['type'] === 'TsUnionType') {
            const parts = (type['types'] as Node[]).filter(part => !(part['type'] === 'TsKeywordType' && ['undefined', 'null'].includes(String(part['kind']))));
            if (parts.length === 1) return { module, type: parts[0]! };
          }
          return { module, type };
        }
        if (parents(module, binding)[0]?.['kind'] !== 'const') return undefined;
        const init = binding['init'] as Node | undefined;
        if (init?.['type'] === 'TsAsExpression') return { module, type: init['typeAnnotation'] as Node };
        return init == null ? undefined : infer(init);
      }
    }
    return undefined;
  }
  if (expression['type'] !== 'MemberExpression' || (expression['property'] as Node)['type'] !== 'Identifier') return undefined;
  const key = String((expression['property'] as Node)['value']);
  const receiver = expression['object'] as Node;
  if (receiver['type'] === 'ThisExpression') {
    const enclosing = parents(module, expression);
    const ownerIndex = enclosing.findIndex(node => ['ClassDeclaration', 'ClassExpression'].includes(String(node['type'])));
    if (ownerIndex < 0 || enclosing.slice(0, ownerIndex).some(node => ['FunctionDeclaration', 'FunctionExpression'].includes(String(node['type'])))) return undefined;
    const owner = enclosing[ownerIndex]!;
    const body = owner['body'] as Node[];
    const property = body.find(node => node['type'] === 'ClassProperty' && named(node['key'], key));
    if (property !== undefined) { const type = typeOf(property); return type === undefined ? undefined : { module, type }; }
    const constructor = body.find(node => node['type'] === 'Constructor');
    const parameter = (constructor?.['params'] as Node[] | undefined)?.find(node => node['type'] === 'TsParameterProperty' && named(node['param'], key));
    const type = parameter === undefined ? undefined : typeOf(parameter['param'] as Node);
    return type === undefined ? undefined : { module, type };
  }
  const held = infer(receiver);
  return held === undefined ? undefined : member(held.module, held.type, key, modules);
}
function vocabulary(modules: Map<string, GateModule>, file: string, name: string, word: string): boolean {
  const authority = modules.get(file);
  const alias = authority === undefined ? undefined : context(authority).nodes.find(node => node['type'] === 'TsTypeAliasDeclaration' && named(node['id'], name) && exported(authority, node));
  const type = alias?.['typeAnnotation'] as Node | undefined;
  const parts = type?.['type'] === 'TsUnionType' ? type['types'] as Node[] : type === undefined ? [] : [type];
  if (parts.some(part => part['type'] === 'TsLiteralType' && value(part['literal'] as Node) === word)) return true;
  if (authority === undefined || type?.['type'] !== 'TsIndexedAccessType') return false;
  const indexed = type['indexType'] as Node, object = type['objectType'] as Node;
  const query = object['type'] === 'TsParenthesizedType' ? object['typeAnnotation'] as Node : object;
  if (indexed['type'] !== 'TsKeywordType' || indexed['kind'] !== 'number' || query['type'] !== 'TsTypeQuery') return false;
  const tuple = context(authority).nodes.find(part => part['type'] === 'VariableDeclarator' && same(part['id'] as Node, query['exprName'] as Node)
    && parents(authority, part)[0]?.['kind'] === 'const' && parents(authority, part)[1]?.['type'] === 'ExportDeclaration');
  const assertion = tuple?.['init'] as Node | undefined, array = assertion?.['expression'] as Node | undefined;
  if (assertion?.['type'] !== 'TsConstAssertion' || array?.['type'] !== 'ArrayExpression') return false;
  const entries = array['elements'] as ({ expression: Node; spread?: unknown } | null)[];
  return entries.every(entry => entry != null && entry.spread == null && entry.expression['type'] === 'StringLiteral')
    && entries.some(entry => value(entry?.expression) === word);
}

/** Exact field boundary declarations, typed field comparisons and owner transaction argument zero. */
export function declarationProtocolLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const word = value(node);
  if (word === undefined) return false;
  const ancestors = parents(module, node), parent = ancestors[0];
  if (module.file === 'src/sql-driver.ts' && parent?.['type'] === 'TsLiteralType') {
    const alias = ancestors.find(part => part['type'] === 'TsTypeAliasDeclaration');
    if (alias !== undefined && named(alias['id'], 'SqlTransactionKind') && exported(module, alias)) {
      const owner = modules.get('src/adapters/database-owner.ts');
      const contract = owner === undefined ? undefined : context(owner).nodes.find(part => part['type'] === 'TsInterfaceDeclaration' && named(part['id'], 'DatabaseOwner') && exported(owner, part));
      const method = ((contract?.['body'] as Node | undefined)?.['body'] as Node[] | undefined)?.find(part => part['type'] === 'TsMethodSignature' && named(part['key'], 'transaction'));
      const parameter = (method?.['params'] as Node[] | undefined)?.[0];
      const consumed = owner === undefined ? undefined : reference(owner, typeOf(parameter), modules);
      if (consumed?.module === module && consumed.node === alias && vocabulary(modules, module.file, 'SqlTransactionKind', word)) return true;
    }
  }
  if (snapshotFormLiteral(module, node, modules) || gitArgumentLiteral(module, node) || writtenAtMemberLiteral(module, node, modules)
    || evidenceDiagnosticLiteral(module, node, modules) || snapshotMemberKeyLiteral(module, node, modules) || pageFormatTupleLiteral(module, node, modules)
    || guardedPageFormatLiteral(module, node, modules) || graphConditionObjectLiteral(module, node, modules) || evidenceLocatorArgumentLiteral(module, node, modules)
    || valueStorageValidationLiteral(module, node, modules) || sourceLanguageLiteral(module, node, modules)) return true;
  // Plugin fields reuse precisely FieldDecl's type member, not arbitrary indexed keys.
  if (word === 'type' && module.file === 'src/product/manifest/kinds.ts' && parent?.['type'] === 'TsLiteralType') {
    const access = ancestors[1], property = ancestors[2], owner = ancestors.find(part => part['type'] === 'TsInterfaceDeclaration');
    if (access?.['type'] === 'TsIndexedAccessType' && access['indexType'] === parent
      && property?.['type'] === 'TsTypeAnnotation' && ancestors[3]?.['type'] === 'TsPropertySignature'
      && named(ancestors[3]!['key'], 'type') && owner !== undefined && named(owner['id'], 'PluginFieldDecl') && exported(module, owner)
      && isDeclaration(reference(module, access['objectType'] as Node, modules), module.file, 'FieldDecl')) return true;
  }
  if (vocabulary(modules, 'src/plugin/repository-snapshot.ts', 'GitTreeObjectType', word)) {
    if (module.file === 'src/plugin/repository-snapshot.ts' && parent?.['type'] === 'ArrayExpression' && ancestors[1]?.['type'] === 'TsConstAssertion'
      && ancestors[2]?.['type'] === 'VariableDeclarator' && named(ancestors[2]['id'], 'GIT_TREE_OBJECT_TYPES') && ancestors[4]?.['type'] === 'ExportDeclaration') return true;
    const other = parent?.['type'] === 'BinaryExpression' && ['===', '!=='].includes(String(parent['operator']))
      ? (parent['left'] === node ? parent['right'] : parent['left']) as Node : undefined;
    const held = other?.['type'] === 'Identifier' ? expressionType(module, other, modules) : undefined;
    if (held !== undefined && isDeclaration(reference(held.module, held.type, modules), 'src/plugin/repository-snapshot.ts', 'GitTreeObjectType')) return true;
  }
  if (parent?.['type'] === 'BinaryExpression' && ['===', '!=='].includes(String(parent['operator']))) {
    const expression = (parent['left'] === node ? parent['right'] : parent['left']) as Node;
    const other = expression['type'] === 'OptionalChainingExpression' ? expression['base'] as Node : expression;
    if (other['type'] === 'MemberExpression' && named(other['property'], 'storage')) {
      const held = expressionType(module, other['object'] as Node, modules);
      if (held !== undefined && isDeclaration(reference(held.module, held.type, modules), 'src/graph/value-types.ts', 'ValueTypeDeclaration')) {
        const storage = member(held.module, held.type, 'storage', modules)?.type;
        if (storage !== undefined && isDeclaration(reference(held.module, storage, modules), 'src/graph/contract.ts', 'FieldType')
          && vocabulary(modules, 'src/graph/contract.ts', 'FieldType', word)) return true;
        if (storage?.['type'] === 'TsUnionType' && (storage['types'] as Node[]).some(part => part['type'] === 'TsLiteralType' && value(part['literal'] as Node) === word)) return true;
      }
    }
  }
  const fieldWord = vocabulary(modules, 'src/graph/contract.ts', 'FieldType', word);
  if (fieldWord) {
    if (module.file === 'src/graph/contract.ts' && parent?.['type'] === 'ArrayExpression' && ancestors[1]?.['type'] === 'TsConstAssertion'
      && ancestors[2]?.['type'] === 'VariableDeclarator' && named(ancestors[2]['id'], 'FIELD_TYPES') && ancestors[3]?.['kind'] === 'const' && ancestors[4]?.['type'] === 'ExportDeclaration') {
      const alias = context(module).nodes.find(part => part['type'] === 'TsTypeAliasDeclaration' && named(part['id'], 'FieldType') && exported(module, part));
      const indexed = alias?.['typeAnnotation'] as Node | undefined, query = indexed?.['objectType'] as Node | undefined;
      const object = query?.['type'] === 'TsParenthesizedType' ? query['typeAnnotation'] as Node : query;
      if (indexed?.['type'] === 'TsIndexedAccessType' && object?.['type'] === 'TsTypeQuery' && same(object['exprName'] as Node, ancestors[2]['id'] as Node)) return true;
    }
    const property = ancestors.find(part => part['type'] === 'TsPropertySignature');
    const owner = ancestors.find(part => part['type'] === 'TsInterfaceDeclaration');
    if (property !== undefined && owner !== undefined && exported(module, owner)) {
      const direct = module.file === 'src/product/manifest/kinds.ts' && ['FieldDecl', 'PluginFieldDecl'].some(name => named(owner['id'], name)) && named(property['key'], 'type');
      const mapped = module.file === 'src/knowledge/graph-read.ts' && ['GeneratedKindRead', 'GeneratedEdgeRead'].some(name => named(owner['id'], name)) && named(property['key'], 'types');
      if (direct && parent?.['type'] === 'TsLiteralType' && ancestors[1]?.['type'] === 'TsUnionType' && typeOf(property) === ancestors[1]) return true;
      if (mapped && recordArgument(typeOf(property), 1) === ancestors[1] && parent?.['type'] === 'TsLiteralType') return true;
    }
    if (module.file === 'src/graphql/names.ts') {
      const declarator = ancestors.find(part => part['type'] === 'VariableDeclarator' && named(part['id'], 'SCALAR_NAMES'));
      if (declarator !== undefined && ancestors.some(part => part['type'] === 'ExportDeclaration') && recordArgument(typeOf(declarator['id'] as Node), 0) === ancestors[1]) return true;
    }
    if (parent?.['type'] === 'KeyValueProperty' && named(parent['key'], 'type') && parent['value'] === node) {
      const object = ancestors[1], array = ancestors[2], declarator = ancestors[3];
      if (object?.['type'] === 'ObjectExpression' && array?.['type'] === 'ArrayExpression' && declarator?.['type'] === 'VariableDeclarator' && declarator['init'] === array) {
        const annotation = typeOf(declarator['id'] as Node);
        const element = annotation?.['type'] === 'TsArrayType' ? annotation['elemType'] as Node : undefined;
        const held = element === undefined ? undefined : reference(module, element, modules);
        if (isDeclaration(held, 'src/graphql/manifest.ts', 'PublishedField')
          || isDeclaration(held, 'src/product/manifest/kinds.ts', 'FieldDecl')
          || isDeclaration(held, 'src/product/manifest/kinds.ts', 'PluginFieldDecl')) return true;
      }
    }
    const comparison = parent;
    const switchNode = comparison?.['type'] === 'SwitchCase' && comparison['test'] === node ? ancestors[1] : undefined;
    const expression = switchNode?.['type'] === 'SwitchStatement' ? switchNode['discriminant'] as Node
      : comparison?.['type'] === 'BinaryExpression' && ['===', '!=='].includes(String(comparison['operator']))
        ? (comparison['left'] === node ? comparison['right'] : comparison['left']) as Node : undefined;
    const other = expression?.['type'] === 'OptionalChainingExpression' ? expression['base'] as Node : expression;
    if (other?.['type'] === 'Identifier') {
      const held = expressionType(module, other, modules);
      if (held !== undefined && isDeclaration(reference(held.module, held.type, modules), 'src/graph/contract.ts', 'FieldType')) return true;
    }
    if (other?.['type'] === 'MemberExpression' && named(other['property'], 'type')) {
      const held = expressionType(module, other['object'] as Node, modules);
      const declared = held === undefined ? undefined : reference(held.module, held.type, modules);
      if (isDeclaration(declared, 'src/graphql/manifest.ts', 'PublishedField') || isDeclaration(declared, 'src/graph/contract.ts', 'FieldContract')
        || isDeclaration(declared, 'src/product/manifest/kinds.ts', 'FieldDecl') || isDeclaration(declared, 'src/product/manifest/kinds.ts', 'PluginFieldDecl')) {
        const slot = member(held!.module, held!.type, 'type', modules);
        if (slot !== undefined && isDeclaration(reference(slot.module, slot.type, modules), 'src/graph/contract.ts', 'FieldType')) return true;
      }
    }
  }
  const discriminant = parent?.['type'] === 'SwitchCase' && parent['test'] === node && ancestors[1]?.['type'] === 'SwitchStatement'
    ? ancestors[1]['discriminant'] as Node : undefined;
  if (discriminant !== undefined || parent?.['type'] === 'BinaryExpression' && ['===', '!=='].includes(String(parent['operator']))) {
    const other = discriminant ?? (parent!['left'] === node ? parent!['right'] : parent!['left']) as Node;
    if (other['type'] === 'MemberExpression' && named(other['property'], 'type')) {
      const held = expressionType(module, other['object'] as Node, modules);
      const declared = held === undefined ? undefined : reference(held.module, held.type, modules);
      if (isDeclaration(declared, 'src/graph/evidence-targets.ts', 'EvidenceLocatorDraft')
        || isDeclaration(declared, 'src/knowledge/graph-verdict-rules.ts', 'GraphCondition')) {
        const union = declared!.node['typeAnnotation'] as Node;
        const variants = union['type'] === 'TsUnionType' ? union['types'] as Node[] : [union];
        if (variants.some(part => part['type'] === 'TsTypeLiteral'
          && (part['members'] as Node[]).some(slot => slot['type'] === 'TsPropertySignature' && named(slot['key'], 'type')
            && typeOf(slot)?.['type'] === 'TsLiteralType' && value(typeOf(slot)!['literal'] as Node) === word))) return true;
      }
    }
  }
  if (!vocabulary(modules, 'src/sql-driver.ts', 'SqlTransactionKind', word)) return false;
  if (parent?.['type'] === 'VariableDeclarator' && parent['init'] === node && (parent['id'] as Node)?.['type'] === 'Identifier') {
    const binding = parent['id'] as Node, modeType = typeOf(binding);
    if (isDeclaration(reference(module, modeType, modules), 'src/sql-driver.ts', 'SqlTransactionKind')) {
      const consumed = context(module).nodes.some(part => {
        const callee = part['callee'] as Node | undefined;
        const first = (part['arguments'] as { expression: Node }[] | undefined)?.[0]?.expression;
        if (part['type'] !== 'CallExpression' || callee?.['type'] !== 'MemberExpression' || !named(callee['property'], 'transaction') || !same(first, binding)) return false;
        const held = expressionType(module, callee['object'] as Node, modules);
        return held !== undefined && ownerTransactionType(held.module, held.type, modules);
      });
      if (consumed) return true;
    }
  }
  const argument = parent?.['type'] === 'ConditionalExpression' && (parent['consequent'] === node || parent['alternate'] === node) ? parent : node;
  const call = argument === node ? parent : ancestors[1];
  const callee = call?.['callee'] as Node | undefined;
  if (call?.['type'] !== 'CallExpression' || callee?.['type'] !== 'MemberExpression' || !named(callee['property'], 'transaction')
    || (call['arguments'] as { expression: Node }[])[0]?.expression !== argument) return false;
  const held = expressionType(module, callee['object'] as Node, modules);
  if (held === undefined) return false;
  return ownerTransactionType(held.module, held.type, modules);
}
function ownerTransactionType(module: GateModule, type: Node | undefined | null, modules: Map<string, GateModule>, depth = 0): boolean {
  if (type == null || depth > 8) return false;
  const declared = reference(module, type, modules);
  if (isDeclaration(declared, 'src/adapters/database-owner.ts', 'DatabaseOwner')) return true;
  if (declared?.node['type'] === 'TsTypeAliasDeclaration') return ownerTransactionType(declared.module, declared.node['typeAnnotation'] as Node, modules, depth + 1);
  if (type['type'] === 'TsIntersectionType') {
    const parts = type['types'] as Node[];
    const owners = parts.filter(part => ownerTransactionType(module, part, modules, depth + 1));
    return owners.length === 1 && parts.every(part => part === owners[0] || part['type'] === 'TsTypeLiteral'
      && (part['members'] as Node[]).every(slot => slot['type'] === 'TsPropertySignature' && (slot['key'] as Node)?.['type'] === 'Identifier' && !named(slot['key'], 'transaction')));
  }
  const args = (type['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined;
  if (type['type'] !== 'TsTypeReference' || !named(type['typeName'], 'Pick') || args?.length !== 2
    || args[1]?.['type'] !== 'TsLiteralType' || value(args[1]['literal'] as Node) !== 'transaction') return false;
  // A lexical declaration named Pick is not TypeScript's built-in utility.
  if (declaration(module, type['typeName'] as Node, modules) !== undefined) return false;
  return ownerTransactionType(module, args[0]!, modules, depth + 1);
}
function recordArgument(type: Node | undefined, index: number): Node | undefined {
  if (type?.['type'] !== 'TsTypeReference' || !named(type['typeName'], 'Readonly')) return undefined;
  const record = ((type['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined)?.[0];
  if (record?.['type'] !== 'TsTypeReference' || !named(record['typeName'], 'Record')) return undefined;
  return ((record['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined)?.[index];
}

/** Snapshot forms come from the tuple that the exported entry's form type indexes. */
function snapshotFormLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const file = 'src/plugin/repository-snapshot.ts', authority = modules.get(file);
  if (authority === undefined) return false;
  const all = context(authority).nodes;
  const tuple = all.find(part => part['type'] === 'VariableDeclarator' && named(part['id'], 'SNAPSHOT_ENTRY_FORMS')
    && parents(authority, part)[0]?.['kind'] === 'const' && parents(authority, part).some(owner => owner === authority.tree));
  const assertion = tuple?.['init'] as Node | undefined;
  const array = assertion?.['type'] === 'TsConstAssertion' ? assertion['expression'] as Node : undefined;
  if (array?.['type'] !== 'ArrayExpression') return false;
  const entries = (array['elements'] as { expression: Node }[]).map(entry => entry?.expression);
  if (!entries.every(entry => entry?.['type'] === 'StringLiteral') || !entries.some(entry => value(entry) === value(node))) return false;
  const alias = all.find(part => part['type'] === 'TsTypeAliasDeclaration' && named(part['id'], 'SnapshotEntryForm'));
  const indexed = alias?.['typeAnnotation'] as Node | undefined;
  const objectType = indexed?.['objectType'] as Node | undefined;
  const query = objectType?.['type'] === 'TsParenthesizedType' ? objectType['typeAnnotation'] as Node : objectType;
  const index = indexed?.['indexType'] as Node | undefined;
  if (indexed?.['type'] !== 'TsIndexedAccessType' || query?.['type'] !== 'TsTypeQuery'
    || !same(query['exprName'] as Node, tuple!['id'] as Node) || index?.['type'] !== 'TsKeywordType' || index['kind'] !== 'number') return false;
  const entry = all.find(part => part['type'] === 'TsInterfaceDeclaration' && named(part['id'], 'SnapshotEntry') && exported(authority, part));
  const slot = entry === undefined ? undefined : ((entry['body'] as Node)['body'] as Node[]).find(part => part['type'] === 'TsPropertySignature' && named(part['key'], 'form'));
  const slotType = slot === undefined ? undefined : typeOf(slot);
  if (slotType === undefined || reference(authority, slotType, modules)?.node !== alias) return false;
  const ancestors = parents(module, node), parent = ancestors[0];
  if (module === authority && parent === array) return true;
  if (module === authority && parent?.['type'] === 'KeyValueProperty' && parent['value'] === node) {
    const object = ancestors[1], declarator = ancestors[2];
    if (object?.['type'] === 'ObjectExpression' && declarator?.['type'] === 'VariableDeclarator' && declarator['init'] === object
      && named(declarator['id'], 'FORM_OF_MODE')) {
      const target = recordArgument(typeOf(declarator['id'] as Node), 1);
      if (target !== undefined && reference(module, target, modules)?.node === alias) return true;
    }
  }
  const switchNode = parent?.['type'] === 'SwitchCase' && parent['test'] === node ? ancestors[1] : undefined;
  const expression = switchNode?.['type'] === 'SwitchStatement' ? switchNode['discriminant'] as Node
    : parent?.['type'] === 'BinaryExpression' && ['===', '!=='].includes(String(parent['operator']))
      ? (parent['left'] === node ? parent['right'] : parent['left']) as Node : undefined;
  const other = expression?.['type'] === 'OptionalChainingExpression' ? expression['base'] as Node : expression;
  if (other?.['type'] !== 'MemberExpression' || !named(other['property'], 'form')) return false;
  const held = expressionType(module, other['object'] as Node, modules);
  if (held === undefined) return false;
  const form = member(held.module, held.type, 'form', modules);
  if (form === undefined) return false;
  if (reference(form.module, form.type, modules)?.node === alias) return true;
  if (form.type['type'] !== 'TsIndexedAccessType') return false;
  const key = form.type['indexType'] as Node;
  if (key['type'] !== 'TsLiteralType' || value(key['literal'] as Node) !== 'form'
    || !isDeclaration(reference(form.module, form.type['objectType'] as Node, modules), file, 'SnapshotEntry')) return false;
  const importedForm = member(form.module, form.type['objectType'] as Node, 'form', modules);
  return importedForm !== undefined && reference(importedForm.module, importedForm.type, modules)?.node === alias;
}

/** Git command words occupy argv, forwarded by this exact lexical adapter to child_process.execFile. */
function gitArgumentLiteral(module: GateModule, node: Node): boolean {
  const ancestors = parents(module, node), array = ancestors[0], call = ancestors[1];
  const word = value(node);
  if (array?.['type'] !== 'ArrayExpression' || call?.['type'] !== 'CallExpression'
    || (call['arguments'] as { expression: Node }[])[1]?.expression !== array) return false;
  const args = array['elements'] as { expression: Node }[];
  const snapshotBlob = module.file === 'src/plugin/repository-snapshot.ts' && word === 'blob'
    && args[1]?.expression === node && value(args[0]?.expression ?? {}) === 'cat-file';
  const ownWikiMerge = module.file === 'src/product/own-wiki.ts' && word === 'merge' && args[0]?.expression === node;
  if (!snapshotBlob && !ownWikiMerge) return false;
  const callee = call['callee'] as Node;
  if (!named(callee, 'git')) return false;
  const target = context(module).nodes.find(part => part['type'] === 'FunctionDeclaration' && same(part['identifier'] as Node, callee)
    && parents(module, part)[0] === module.tree);
  if (target === undefined) return false;
  const parameter = ((target['params'] as Node[])[1]?.['pat']) as Node | undefined;
  if (parameter?.['type'] !== 'Identifier') return false;
  return context(module).nodes.some(part => {
    if (part['type'] !== 'CallExpression' || !parents(module, part).includes(target)) return false;
    const exec = part['callee'] as Node;
    if (exec['type'] !== 'Identifier') return false;
    const imported = context(module).nodes.some(item => item['type'] === 'ImportDeclaration' && value(item['source'] as Node) === 'node:child_process'
      && (item['specifiers'] as Node[]).some(specifier => specifier['type'] === 'ImportSpecifier'
        && same(specifier['local'] as Node, exec) && named(specifier['imported'] ?? specifier['local'], 'execFile')));
    const actual = part['arguments'] as { expression: Node }[];
    if (!imported || value(actual[0]?.expression ?? {}) !== 'git') return false;
    const argv = actual[1]?.expression;
    if (argv === undefined) return false;
    if (ownWikiMerge) return same(argv, parameter);
    if (argv['type'] !== 'ArrayExpression') return false;
    const forwarded = argv['elements'] as { spread?: unknown; expression: Node }[];
    return forwarded.length === 3 && value(forwarded[0]?.expression ?? {}) === '-C'
      && forwarded[2]?.spread != null && same(forwarded[2].expression, parameter);
  });
}

/** A validator may inspect only keys of its imported WrittenAt mapped input shape. */
function writtenAtMemberLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const ancestors = parents(module, node), computed = ancestors[0], access = ancestors[1];
  if (computed?.['type'] !== 'Computed' || computed['expression'] !== node || access?.['type'] !== 'MemberExpression') return false;
  const held = expressionType(module, access['object'] as Node, modules);
  if (held?.type['type'] !== 'TsMappedType' || held.type['optional'] !== true) return false;
  const parameter = held.type['typeParam'] as Node | undefined;
  const constraint = parameter?.['constraint'] as Node | undefined;
  const result = held.type['typeAnnotation'] as Node | undefined;
  if (constraint?.['type'] !== 'TsTypeOperator' || constraint['op'] !== 'keyof' || result?.['type'] !== 'TsKeywordType' || result['kind'] !== 'unknown') return false;
  const authority = reference(held.module, constraint['typeAnnotation'] as Node, modules);
  if (!isDeclaration(authority, 'src/knowledge/index/page.ts', 'WrittenAt')) return false;
  const members = (authority!.node['body'] as Node)['body'] as Node[];
  return members.some(part => part['type'] === 'TsPropertySignature' && named(part['key'], value(node) ?? ''));
}

function snapshotMemberKeyLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const ancestors = parents(module, node), literal = ancestors[0], access = ancestors[1];
  if (literal?.['type'] !== 'TsLiteralType' || access?.['type'] !== 'TsIndexedAccessType' || access['indexType'] !== literal || value(node) !== 'form') return false;
  const held = reference(module, access['objectType'] as Node, modules);
  return isDeclaration(held, 'src/plugin/repository-snapshot.ts', 'SnapshotEntry')
    && ((held!.node['body'] as Node)['body'] as Node[]).some(part => part['type'] === 'TsPropertySignature' && named(part['key'], 'form'));
}

/** A diagnostic field argument must name the actual typed member passed to the same assertion helper. */
function evidenceDiagnosticLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const call = parents(module, node)[0];
  if (call?.['type'] !== 'CallExpression' && call?.['type'] !== 'NewExpression') return false;
  const args = call['arguments'] as { expression: Node }[];
  const checked = args[call['type'] === 'NewExpression' ? 2 : 0]?.expression;
  if (args[1]?.expression !== node || checked?.['type'] !== 'MemberExpression' || !named(checked['property'], value(node) ?? '')) return false;
  const held = expressionType(module, checked['object'] as Node, modules);
  const declared = held === undefined ? undefined : reference(held.module, held.type, modules);
  if (!isDeclaration(declared, 'src/graph/evidence-targets.ts', 'EvidenceLocatorDraft')) return false;
  const union = declared!.node['typeAnnotation'] as Node;
  if (union['type'] !== 'TsUnionType' || !(union['types'] as Node[]).some(part => part['type'] === 'TsTypeLiteral'
    && (part['members'] as Node[]).some(property => property['type'] === 'TsPropertySignature' && named(property['key'], value(node) ?? '')))) return false;
  const callee = call['callee'] as Node;
  if (callee['type'] !== 'Identifier') return false;
  if (call['type'] === 'NewExpression') {
    return module.file === 'src/graph/evidence-targets.ts' && context(module).nodes.some(part => part['type'] === 'ClassDeclaration'
      && named(part['identifier'], 'EvidenceTargetError') && same(part['identifier'] as Node, callee) && exported(module, part));
  }
  const helper = context(module).nodes.find(part => part['type'] === 'FunctionDeclaration' && same(part['identifier'] as Node, callee)
    && parents(module, part)[0] === module.tree);
  const returns = helper?.['returnType'] as Node | undefined;
  const predicate = returns?.['typeAnnotation'] as Node | undefined;
  const first = ((helper?.['params'] as Node[] | undefined)?.[0]?.['pat']) as Node | undefined;
  if (predicate?.['type'] !== 'TsTypePredicate' || predicate['asserts'] !== true || first === undefined || !same(predicate['paramName'] as Node, first)) return false;
  const second = ((helper?.['params'] as Node[] | undefined)?.[1]?.['pat']) as Node | undefined;
  if (second === undefined) return false;
  return context(module).nodes.some(part => {
    if (part['type'] !== 'NewExpression' || !parents(module, part).includes(helper!)) return false;
    const error = part['callee'] as Node;
    const errorType = context(module).nodes.find(candidate => candidate['type'] === 'ClassDeclaration'
      && named(candidate['identifier'], 'EvidenceTargetError') && same(candidate['identifier'] as Node, error) && exported(module, candidate));
    return module.file === 'src/graph/evidence-targets.ts' && errorType !== undefined
      && same((part['arguments'] as { expression: Node }[])[1]?.expression ?? {}, second);
  });
}

/** FORMATS is vocabulary only when its exact enum-bearing component schema reaches template validation. */
function pageFormatTupleLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  if (module.file !== 'src/page-contract/schema.ts') return false;
  const ancestors = parents(module, node), array = ancestors[0], assertion = ancestors[1], tuple = ancestors[2];
  if (array?.['type'] !== 'ArrayExpression' || assertion?.['type'] !== 'TsConstAssertion' || assertion['expression'] !== array
    || tuple?.['type'] !== 'VariableDeclarator' || !named(tuple['id'], 'FORMATS') || tuple['init'] !== assertion || ancestors[3]?.['kind'] !== 'const') return false;
  const all = context(module).nodes;
  const schemas = all.find(part => part['type'] === 'VariableDeclarator' && named(part['id'], 'COMPONENT_SCHEMAS') && parents(module, part).some(owner => owner['type'] === 'ExportDeclaration'));
  if (schemas === undefined || !all.some(part => part['type'] === 'KeyValueProperty' && named(part['key'], 'enum')
    && same(part['value'] as Node, tuple['id'] as Node) && parents(module, part).includes(schemas)
    && parents(module, part).some(owner => owner['type'] === 'KeyValueProperty' && named(owner['key'], 'format')))) return false;
  const parameters = all.find(part => part['type'] === 'FunctionDeclaration' && named(part['identifier'], 'parametersSchema') && exported(module, part));
  if (parameters === undefined) return false;
  const selected = all.find(part => part['type'] === 'VariableDeclarator' && parents(module, part).includes(parameters)
    && (part['init'] as Node | undefined)?.['type'] === 'MemberExpression' && same((part['init'] as Node)['object'] as Node, schemas['id'] as Node));
  if (selected === undefined || !all.some(part => part['type'] === 'KeyValueProperty' && named(part['key'], 'properties')
    && (part['value'] as Node | undefined)?.['type'] === 'MemberExpression' && named((part['value'] as Node)['property'], 'parameters')
    && same((part['value'] as Node)['object'] as Node, selected['id'] as Node) && parents(module, part).some(owner => owner['type'] === 'ReturnStatement' && parents(module, owner).includes(parameters)))) return false;
  const reader = modules.get('src/page-contract/template.ts'), validator = modules.get('src/page-contract/validate.ts');
  if (reader === undefined || validator === undefined || !context(validator).nodes.some(part => part['type'] === 'FunctionDeclaration' && named(part['identifier'], 'validateNode') && exported(validator, part))) return false;
  const imported = (callee: Node, source: string, name: string): boolean => context(reader).nodes.some(part => part['type'] === 'ImportDeclaration' && value(part['source'] as Node) === source
    && (part['specifiers'] as Node[]).some(specifier => specifier['type'] === 'ImportSpecifier' && same(specifier['local'] as Node, callee) && named(specifier['imported'] ?? specifier['local'], name)));
  return context(reader).nodes.some(part => {
    if (part['type'] !== 'CallExpression' || !imported(part['callee'] as Node, './validate.js', 'validateNode')) return false;
    const schema = (part['arguments'] as { expression: Node }[])[2]?.expression;
    return schema?.['type'] === 'CallExpression' && imported(schema['callee'] as Node, './schema.js', 'parametersSchema');
  });
}

/** A format comparison follows the real tuple-backed predicate, never an arbitrary string guard. */
function guardedPageFormatLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const comparison = parents(module, node)[0];
  if (comparison?.['type'] !== 'BinaryExpression' || !['===', '!=='].includes(String(comparison['operator']))) return false;
  const receiver = (comparison['left'] === node ? comparison['right'] : comparison['left']) as Node;
  if (receiver['type'] !== 'Identifier') return false;
  const candidates = context(module).nodes.filter(part => part['type'] === 'VariableDeclarator' && same(part['id'] as Node, receiver)
    && parents(module, part)[0]?.['kind'] === 'const');
  if (candidates.length !== 1) return false;
  const init = candidates[0]!['init'] as Node | undefined;
  if (init?.['type'] !== 'ConditionalExpression' || value(init['alternate'] as Node) !== 'text') return false;
  const test = init['test'] as Node;
  if (test['type'] !== 'CallExpression') return false;
  const argument = (test['arguments'] as { expression: Node }[])[0]?.expression;
  const consequent = init['consequent'] as Node;
  if (argument?.['type'] !== 'MemberExpression' || consequent['type'] !== 'MemberExpression'
    || !named(argument['property'], 'format') || !named(consequent['property'], 'format')
    || !same(argument['object'] as Node, consequent['object'] as Node)) return false;
  const authority = modules.get('src/page-contract/schema.ts');
  if (authority === undefined) return false;
  const imported = context(module).nodes.some(part => part['type'] === 'ImportDeclaration'
    && resolve('/', module.file, '..', value(part['source'] as Node) ?? '') === '/src/page-contract/schema.js'
    && (part['specifiers'] as Node[]).some(specifier => specifier['type'] === 'ImportSpecifier'
      && same(specifier['local'] as Node, test['callee'] as Node) && named(specifier['imported'] ?? specifier['local'], 'isFieldFormat')));
  if (!imported) return false;
  const all = context(authority).nodes;
  const guard = all.find(part => part['type'] === 'FunctionDeclaration' && named(part['identifier'], 'isFieldFormat') && exported(authority, part));
  const predicate = (guard?.['returnType'] as Node | undefined)?.['typeAnnotation'] as Node | undefined;
  const parameter = ((guard?.['params'] as Node[] | undefined)?.[0]?.['pat']) as Node | undefined;
  if (predicate?.['type'] !== 'TsTypePredicate' || predicate['asserts'] === true || parameter === undefined || !same(predicate['paramName'] as Node, parameter)) return false;
  const alias = reference(authority, ((predicate['typeAnnotation'] as Node | undefined)?.['typeAnnotation'] ?? predicate['typeAnnotation']) as Node, modules);
  if (!isDeclaration(alias, authority.file, 'FieldFormat')) return false;
  const indexed = alias!.node['typeAnnotation'] as Node;
  const object = indexed['objectType'] as Node | undefined;
  const query = object?.['type'] === 'TsParenthesizedType' ? object['typeAnnotation'] as Node : object;
  const index = indexed['indexType'] as Node | undefined;
  if (indexed['type'] !== 'TsIndexedAccessType' || query?.['type'] !== 'TsTypeQuery' || index?.['type'] !== 'TsKeywordType' || index['kind'] !== 'number') return false;
  const tuple = all.find(part => part['type'] === 'VariableDeclarator' && named(part['id'], 'FORMATS') && same(part['id'] as Node, query['exprName'] as Node));
  const array = ((tuple?.['init'] as Node | undefined)?.['expression']) as Node | undefined;
  if (array?.['type'] !== 'ArrayExpression') return false;
  const matching = (array['elements'] as { expression: Node }[]).find(entry => value(entry.expression) === value(node));
  if (matching === undefined || !pageFormatTupleLiteral(authority, matching.expression, modules)) return false;
  return all.some(part => {
    const callee = part['callee'] as Node | undefined;
    if (part['type'] !== 'CallExpression' || callee?.['type'] !== 'MemberExpression' || !named(callee['property'], 'some')
      || !same(callee['object'] as Node, tuple!['id'] as Node) || !parents(authority, part).includes(guard!)) return false;
    const conjunction = parents(authority, part)[0], returned = parents(authority, part)[1];
    const check = conjunction?.['left'] as Node | undefined;
    const typeofValue = check?.['left'] as Node | undefined;
    if (conjunction?.['type'] !== 'BinaryExpression' || conjunction['operator'] !== '&&' || conjunction['right'] !== part
      || returned?.['type'] !== 'ReturnStatement' || returned['argument'] !== conjunction
      || check?.['type'] !== 'BinaryExpression' || check['operator'] !== '===' || value(check['right'] as Node) !== 'string'
      || typeofValue?.['type'] !== 'UnaryExpression' || typeofValue['operator'] !== 'typeof' || !same(typeofValue['argument'] as Node, parameter)) return false;
    const callback = (part['arguments'] as { expression: Node }[])[0]?.expression;
    if (callback?.['type'] !== 'ArrowFunctionExpression') return false;
    const item = (callback['params'] as Node[])[0], body = callback['body'] as Node;
    return item !== undefined && body['type'] === 'BinaryExpression' && body['operator'] === '==='
      && ((same(body['left'] as Node, item) && same(body['right'] as Node, parameter)) || (same(body['right'] as Node, item) && same(body['left'] as Node, parameter)));
  });
}

/** Contextual object typing starts at a declared array and follows only actual structural member slots. */
function graphConditionObjectLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const ancestors = parents(module, node), property = ancestors[0], object = ancestors[1];
  if (property?.['type'] !== 'KeyValueProperty' || !named(property['key'], 'type') || property['value'] !== node || object?.['type'] !== 'ObjectExpression') return false;
  const root = ancestors.find(part => part['type'] === 'VariableDeclarator' && part['init'] !== null && typeOf(part['id'] as Node) != null);
  if (root === undefined) return false;
  let held = { module, type: typeOf(root['id'] as Node)! };
  const path = [...ancestors.slice(1, ancestors.indexOf(root))].reverse();
  if (path[0] !== root['init'] || path.some(part => !['ArrayExpression', 'ObjectExpression', 'KeyValueProperty'].includes(String(part['type'])))) return false;
  let shape: Node | undefined;
  for (const part of path) {
    if (part['type'] === 'ObjectExpression') shape = part;
    if (part['type'] === 'ArrayExpression') {
      const type = arrayElement(held.type);
      if (type === undefined) return false;
      held = { module: held.module, type };
    } else if (part['type'] === 'KeyValueProperty') {
      if ((part['key'] as Node)['type'] !== 'Identifier') return false;
      const discriminant = (shape?.['properties'] as Node[] | undefined)?.find(entry => entry['type'] === 'KeyValueProperty' && named(entry['key'], 'type'));
      const slot = contextualMember(held.module, held.type, String((part['key'] as Node)['value']), modules, 0,
        discriminant === undefined ? undefined : value(discriminant['value'] as Node));
      if (slot === undefined) return false;
      held = slot;
    }
  }
  const declaration = reference(held.module, held.type, modules);
  if (!isDeclaration(declaration, 'src/knowledge/graph-verdict-rules.ts', 'GraphCondition')) return false;
  const union = declaration!.node['typeAnnotation'] as Node;
  return union['type'] === 'TsUnionType' && (union['types'] as Node[]).some(part => part['type'] === 'TsTypeLiteral'
    && (part['members'] as Node[]).some(slot => slot['type'] === 'TsPropertySignature' && named(slot['key'], 'type')
      && typeOf(slot)?.['type'] === 'TsLiteralType' && value(typeOf(slot)!['literal'] as Node) === value(node)));
}
function contextualMember(module: GateModule, type: Node, key: string, modules: Map<string, GateModule>, depth = 0, discriminant?: string): { module: GateModule; type: Node } | undefined {
  if (depth > 8) return undefined;
  const declared = reference(module, type, modules);
  if (declared?.node['type'] === 'TsTypeAliasDeclaration') return contextualMember(declared.module, declared.node['typeAnnotation'] as Node, key, modules, depth + 1, discriminant);
  if (type['type'] !== 'TsUnionType') return member(module, type, key, modules);
  const variants = (type['types'] as Node[]).filter(part => discriminant === undefined || part['type'] === 'TsTypeLiteral'
    && (part['members'] as Node[]).some(slot => slot['type'] === 'TsPropertySignature' && named(slot['key'], 'type')
      && typeOf(slot)?.['type'] === 'TsLiteralType' && value(typeOf(slot)!['literal'] as Node) === discriminant));
  const slots = variants.map(part => contextualMember(module, part, key, modules, depth + 1));
  const first = slots[0];
  return first !== undefined && slots.every(slot => slot !== undefined && equivalentType(first.module, first.type, slot.module, slot.type, modules)) ? first : undefined;
}

function evidenceLocatorArgumentLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const ancestors = parents(module, node), property = ancestors[0], object = ancestors[1], call = ancestors[2];
  if (property?.['type'] !== 'KeyValueProperty' || !named(property['key'], 'type') || property['value'] !== node
    || object?.['type'] !== 'ObjectExpression' || call?.['type'] !== 'CallExpression') return false;
  const index = (call['arguments'] as { expression: Node }[]).findIndex(argument => argument.expression === object);
  const functions = context(module).nodes.filter(part => part['type'] === 'FunctionDeclaration' && same(part['identifier'] as Node, call['callee'] as Node));
  if (index < 0 || functions.length !== 1) return false;
  const parameter = (functions[0]!['params'] as Node[])[index]?.['pat'] as Node | undefined;
  const type = typeOf(parameter);
  if (type?.['type'] !== 'TsIndexedAccessType' || !isDeclaration(reference(module, type['objectType'] as Node, modules), 'src/graph/evidence-targets.ts', 'EvidenceTarget')) return false;
  const key = type['indexType'] as Node;
  if (key['type'] !== 'TsLiteralType' || value(key['literal'] as Node) !== 'locator') return false;
  const slot = member(module, type['objectType'] as Node, 'locator', modules);
  if (slot === undefined) return false;
  const variants = slot.type['type'] === 'TsUnionType' ? slot.type['types'] as Node[] : [slot.type];
  return variants.some(variant => {
    const discriminant = member(slot.module, variant, 'type', modules)?.type;
    const literals = discriminant?.['type'] === 'TsUnionType' ? discriminant['types'] as Node[] : discriminant === undefined ? [] : [discriminant];
    return literals.some(literal => literal['type'] === 'TsLiteralType' && value(literal['literal'] as Node) === value(node));
  });
}

/** The storage list validates the value binding of an actual typed Object.entries loop. */
function valueStorageValidationLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const ancestors = parents(module, node), array = ancestors[0], callee = ancestors[1], call = ancestors[2];
  if (array?.['type'] !== 'ArrayExpression' || callee?.['type'] !== 'MemberExpression' || callee['object'] !== array
    || !named(callee['property'], 'includes') || call?.['type'] !== 'CallExpression' || call['callee'] !== callee) return false;
  const checked = (call['arguments'] as { expression: Node }[])[0]?.expression;
  if (checked?.['type'] !== 'MemberExpression' || !named(checked['property'], 'storage')) return false;
  const identifier = checked['object'] as Node;
  if (identifier['type'] !== 'Identifier') return false;
  const scopes = parents(module, checked);
  const loop = scopes.find(part => part['type'] === 'ForOfStatement');
  if (loop === undefined || scopes.slice(0, scopes.indexOf(loop)).some(part => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(String(part['type'])))) return false;
  const left = loop['left'] as Node;
  const binding = (left['declarations'] as Node[] | undefined)?.[0]?.['id'] as Node | undefined;
  const elements = binding?.['type'] === 'ArrayPattern' ? binding['elements'] as Node[] : undefined;
  if (elements?.length !== 2 || !same(elements[1], identifier)) return false;
  // An inner binding must not borrow the loop value's annotation.
  if (context(module).nodes.some(part => part['type'] === 'VariableDeclarator' && part['id'] !== binding && same(part['id'] as Node, identifier)
    && parents(module, part).includes(loop))) return false;
  const entries = loop['right'] as Node, method = entries['callee'] as Node | undefined;
  if (entries['type'] !== 'CallExpression' || method?.['type'] !== 'MemberExpression' || !named(method['object'], 'Object') || !named(method['property'], 'entries')) return false;
  const builtin = method['object'] as Node;
  if (context(module).nodes.some(part => [part['id'], part['identifier'], part['local'], part['pat']].some(candidate => candidate != null && same(candidate as Node, builtin)))) return false;
  const input = (entries['arguments'] as { expression: Node }[])[0]?.expression;
  if (input === undefined) return false;
  const held = expressionType(module, input, modules), declaration = held === undefined ? undefined : reference(held.module, held.type, modules);
  if (!isDeclaration(declaration, 'src/graph/value-types.ts', 'ValueTypes')) return false;
  const valueType = recordArgument(declaration!.node['typeAnnotation'] as Node, 1);
  if (valueType === undefined || !isDeclaration(reference(declaration!.module, valueType, modules), 'src/graph/value-types.ts', 'ValueTypeDeclaration')) return false;
  const storage = member(declaration!.module, valueType, 'storage', modules)?.type;
  if (storage?.['type'] !== 'TsUnionType') return false;
  const allowed = (storage['types'] as Node[]).map(part => part['type'] === 'TsLiteralType' ? value(part['literal'] as Node) : undefined);
  const listed = (array['elements'] as ({ expression: Node; spread?: unknown } | null)[]).map(part => part?.spread == null ? value(part?.expression) : undefined);
  return allowed.every(word => word !== undefined && listed.includes(word)) && listed.every(word => word !== undefined && allowed.includes(word));
}

function sourceLanguageLiteral(module: GateModule, node: Node, modules: Map<string, GateModule>): boolean {
  const authority = modules.get('src/page-contract/source-response.ts');
  if (authority === undefined) return false;
  const all = context(authority).nodes;
  const alias = all.find(part => part['type'] === 'TsTypeAliasDeclaration' && named(part['id'], 'SourceLanguage') && exported(authority, part));
  const type = alias?.['typeAnnotation'] as Node | undefined;
  const argument = ((type?.['typeParams'] as Node | undefined)?.['params'] as Node[] | undefined)?.[0];
  if (type?.['type'] !== 'TsTypeReference' || argument?.['type'] !== 'TsTypeQuery') return false;
  const imported = (identifier: Node, name: string): boolean => all.some(part => part['type'] === 'ImportDeclaration' && value(part['source'] as Node) === 'typebox'
    && (part['specifiers'] as Node[]).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['imported'] ?? specifier['local'], name) && same(specifier['local'] as Node, identifier)));
  if (!imported(type['typeName'] as Node, 'Static')) return false;
  const schema = all.find(part => part['type'] === 'VariableDeclarator' && named(part['id'], 'SOURCE_LANGUAGE_SCHEMA') && same(part['id'] as Node, argument['exprName'] as Node)
    && parents(authority, part)[0]?.['kind'] === 'const' && parents(authority, part)[1]?.['type'] === 'ExportDeclaration');
  const init = schema?.['init'] as Node | undefined, callee = init?.['callee'] as Node | undefined;
  if (init?.['type'] !== 'CallExpression' || callee?.['type'] !== 'MemberExpression' || !named(callee['property'], 'Union') || !imported(callee['object'] as Node, 'Type')) return false;
  const array = (init['arguments'] as { expression: Node }[])[0]?.expression;
  if (array?.['type'] !== 'ArrayExpression') return false;
  const matching = (array['elements'] as { expression: Node }[]).some(entry => {
    const literal = entry?.expression, method = literal?.['callee'] as Node | undefined;
    return literal?.['type'] === 'CallExpression' && method?.['type'] === 'MemberExpression' && named(method['property'], 'Literal')
      && same(method['object'] as Node, callee['object'] as Node) && value((literal['arguments'] as { expression: Node }[])[0]?.expression) === value(node);
  });
  if (!matching) return false;
  const response = all.find(part => part['type'] === 'VariableDeclarator' && named(part['id'], 'SOURCE_RESPONSE_SCHEMA')
    && parents(authority, part)[1]?.['type'] === 'ExportDeclaration');
  const responseInit = response?.['init'] as Node | undefined, responseCallee = responseInit?.['callee'] as Node | undefined;
  if (response === undefined || responseInit?.['type'] !== 'CallExpression' || responseCallee?.['type'] !== 'MemberExpression'
    || !named(responseCallee['property'], 'Object') || !same(responseCallee['object'] as Node, callee['object'] as Node)
    || !all.some(part => part['type'] === 'KeyValueProperty' && named(part['key'], 'language')
    && same(part['value'] as Node, schema!['id'] as Node) && parents(authority, part).includes(response))) return false;
  const decoder = all.find(part => part['type'] === 'FunctionDeclaration' && named(part['identifier'], 'decodeSourceResponse') && exported(authority, part));
  const parameter = ((decoder?.['params'] as Node[] | undefined)?.[0]?.['pat']) as Node | undefined;
  if (parameter === undefined || !all.some(part => part['type'] === 'ReturnStatement' && same(part['argument'] as Node, parameter) && parents(authority, part).includes(decoder!))) return false;
  const check = all.find(part => {
    const method = part['callee'] as Node | undefined, args = part['arguments'] as { expression: Node }[] | undefined;
    return part['type'] === 'CallExpression' && method?.['type'] === 'MemberExpression' && named(method['property'], 'Check')
      && same(args?.[0]?.expression, response['id'] as Node) && same(args?.[1]?.expression, parameter)
      && all.some(entry => entry['type'] === 'ImportDeclaration' && value(entry['source'] as Node) === 'typebox/value'
        && (entry['specifiers'] as Node[]).some(specifier => specifier['type'] === 'ImportSpecifier' && named(specifier['imported'] ?? specifier['local'], 'Value') && same(specifier['local'] as Node, method['object'] as Node)))
      && parents(authority, part).includes(decoder!);
  });
  const negation = check === undefined ? undefined : parents(authority, check)[0], condition = check === undefined ? undefined : parents(authority, check)[1];
  if (negation?.['type'] !== 'UnaryExpression' || negation['operator'] !== '!' || condition?.['type'] !== 'IfStatement' || condition['test'] !== negation
    || !all.some(part => part['type'] === 'ThrowStatement' && parents(authority, part)[0] === condition['consequent'])) return false;
  const body = decoder!['body'] as Node | undefined, statements = body?.['stmts'] as Node[] | undefined;
  const guardAt = statements?.indexOf(condition), returnedAt = statements?.findIndex(part => part['type'] === 'ReturnStatement' && same(part['argument'] as Node, parameter));
  if (statements === undefined || guardAt !== 0 || returnedAt !== 1 || statements.length !== 2) return false;
  const ancestors = parents(module, node), parent = ancestors[0];
  if (module === authority && parent?.['type'] === 'CallExpression' && (parent['arguments'] as { expression: Node }[])[0]?.expression === node
    && ancestors.includes(array)) {
    const literalMethod = parent['callee'] as Node;
    if (literalMethod['type'] === 'MemberExpression' && named(literalMethod['property'], 'Literal')
      && same(literalMethod['object'] as Node, callee['object'] as Node)) return true;
  }
  if (parent?.['type'] === 'KeyValueProperty' && parent['value'] === node) {
    const object = ancestors[1], binding = ancestors[2];
    if (object?.['type'] === 'ObjectExpression' && binding?.['type'] === 'VariableDeclarator' && binding['init'] === object) {
      const target = recordArgument(typeOf(binding['id'] as Node), 1);
      if (target !== undefined && reference(module, target, modules)?.node === alias) return true;
    }
  }
  const returned = ancestors.find(part => part['type'] === 'ReturnStatement');
  if (returned === undefined) return false;
  const expression = returned['argument'] as Node;
  if (expression !== node && !(expression['type'] === 'BinaryExpression' && expression['operator'] === '??' && expression['right'] === node)) return false;
  const fn = parents(module, returned).find(part => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(String(part['type'])));
  return fn !== undefined && reference(module, typeOf(fn['returnType'] as Node), modules)?.node === alias;
}

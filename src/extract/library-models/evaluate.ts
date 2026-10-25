/** Bounded origin/role interpretation of immutable facts. No source text is read. */
import type { CodeBindingFact, CodeCallFact, CodeExpressionFact, CodeFacts, CodeImportFact } from '../code/facts.js';
import type { SourceSpan } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import { libraryRegistry, validateLibraryRegistry } from './validate.js';
import type { ArgumentSelector, LibraryDiagnostic, LibraryEffect, LibraryEvaluation, LibraryModel, LibraryOrigin, LibraryRegistry, LibraryRole, SelectedArgument } from './model.js';

type OriginValue = {
  readonly kind: 'export'; readonly imported: CodeImportFact; readonly exportedPath: readonly string[];
  readonly origin: LibraryOrigin;
} | {
  readonly kind: 'role'; readonly imported: CodeImportFact; readonly role: LibraryRole;
  readonly origin: LibraryOrigin; readonly roleOrigin: string;
} | {
  readonly kind: 'member'; readonly receiver: RoleValue; readonly member: string;
  readonly receiverExpression: string; readonly origin: LibraryOrigin;
};
type RoleValue = Extract<OriginValue, { readonly kind: 'role' }>;

export function evaluateLibraryModels(facts: CodeFacts, input: LibraryRegistry = libraryRegistry): LibraryEvaluation {
  const registry = validateLibraryRegistry(input);
  const effects = new Map<string, LibraryEffect>();
  const diagnostics = new Map<string, LibraryDiagnostic>();
  const report = (code: LibraryDiagnostic['code'], at: CodeExpressionFact | CodeCallFact | CodeBindingFact,
    reason: string, modelId?: string): void => {
    const expression = 'expression' in at ? at.expression : at.id;
    const item: LibraryDiagnostic = { code, path: at.path, span: at.span, expression, reason,
      ...(modelId === undefined ? {} : { modelId }) };
    diagnostics.set(JSON.stringify([code, expression, modelId, reason]), item);
  };
  const index = <T>(items: readonly T[], idOf: (item: T) => string, atOf: (item: T) => CodeExpressionFact | CodeCallFact | CodeBindingFact): ReadonlyMap<string, T> => {
    const result = new Map<string, T>(); const ambiguous = new Set<string>();
    for (const item of items) {
      const id = idOf(item);
      if (result.has(id) || ambiguous.has(id)) {
        result.delete(id); ambiguous.add(id);
        report('ambiguous-fact', atOf(item), `duplicate fact identity ${id}`);
      } else result.set(id, item);
    }
    return result;
  };
  const expressions = index(facts.expressions, (item) => item.id, (item) => item);
  const bindings = index(facts.bindings, (item) => item.id, (item) => item);
  const calls = index(facts.calls, (item) => item.expression, (item) => item);
  // Imports have the same source-position fields needed by diagnostics.
  const imports = index(facts.imports, (item) => item.id, (item) => ({ ...item, syntaxKind: 'import', children: [], fields: {} }));
  const exports = index(facts.exports ?? [], (item) => item.id, (item) => ({ ...item, syntaxKind: 'export', children: [], fields: {} }));
  const exportNames = new Map<string, number>();
  for (const entry of facts.exports ?? []) {
    const key = JSON.stringify([entry.path, entry.name]);
    exportNames.set(key, (exportNames.get(key) ?? 0) + 1);
  }
  const files = new Map(facts.files.map((file) => [file.path, file]));
  const invalidExpressions = new Set<string>();
  const exportRules = new Map<string, LibraryModel[]>(); const memberRules = new Map<string, LibraryModel[]>();
  for (const model of registry.models) {
    if (model.target.kind === 'export') {
      for (const form of model.target.importRoles) for (const path of model.target.exportedPaths) {
        const key = JSON.stringify([model.ecosystem, model.package, model.invoke, form, path]);
        exportRules.set(key, [...(exportRules.get(key) ?? []), model]);
      }
    } else {
      const key = JSON.stringify([model.ecosystem, model.package, model.invoke, model.target.receiverRole, model.target.member]);
      memberRules.set(key, [...(memberRules.get(key) ?? []), model]);
    }
  }
  const ecosystemOf = (imported: CodeImportFact): 'node' | 'go' | undefined => {
    const file = files.get(imported.path);
    return file === undefined ? undefined : file.language === 'go' ? 'go' : 'node';
  };
  const importedOf = (value: OriginValue): CodeImportFact => value.kind === 'member' ? value.receiver.imported : value.imported;
  const matching = (value: OriginValue, invoke: LibraryModel['invoke']): readonly LibraryModel[] => {
    const imported = importedOf(value); const ecosystem = ecosystemOf(imported);
    if (ecosystem === undefined || imported.targetPath !== undefined || imported.typeOnly) return [];
    if (imported.package !== undefined && (imported.package.ecosystem !== ecosystem || (imported.package.name !== imported.specifier && !imported.specifier.startsWith(`${imported.package.name}/`)))) return [];
    if (value.kind === 'export') return exportRules.get(JSON.stringify([ecosystem, imported.specifier, invoke, imported.imported.form, value.exportedPath])) ?? [];
    if (value.kind !== 'member') return [];
    const prefix = [ecosystem, imported.specifier, invoke, value.receiver.role];
    return [...(memberRules.get(JSON.stringify([...prefix, value.member])) ?? []),
      ...(invoke === 'read' ? memberRules.get(JSON.stringify([...prefix, '*'])) ?? [] : [])];
  };
  const getExpression = (id: string, at: CodeExpressionFact | CodeCallFact | CodeBindingFact): CodeExpressionFact | undefined => {
    const expression = expressions.get(id);
    if (expression === undefined) {
      report('dangling-fact', at, `expression ${id} is missing or ambiguous`);
      invalidExpressions.add('expression' in at ? at.expression : at.id);
    }
    return expression;
  };
  // Validate every retained reference, not only references that happen to match a model.
  for (const binding of facts.bindings) {
    if (binding.importId !== undefined && !imports.has(binding.importId)) report('dangling-fact', binding, `import ${binding.importId} is missing or ambiguous`);
    if (binding.initializer !== undefined) getExpression(binding.initializer, binding);
    if (binding.typeDeclaration !== undefined) for (const id of [binding.typeDeclaration.expression, binding.typeDeclaration.nameExpression,
      binding.typeDeclaration.typeExpression,binding.typeDeclaration.scopeExpression]) getExpression(id,binding);
  }
  for (const expression of facts.expressions) {
    if (expression.bindingId !== undefined && !bindings.has(expression.bindingId)) {
      report('dangling-fact', expression, `binding ${expression.bindingId} is missing or ambiguous`);
      invalidExpressions.add(expression.id);
    }
    for (const id of new Set([...expression.children, ...Object.values(expression.fields).flat(),
      ...(expression.receiver === undefined ? [] : [expression.receiver]),
      ...(expression.callee === undefined ? [] : [expression.callee]), ...(expression.arguments ?? []),
      ...(expression.compositeType===undefined?[]:[expression.compositeType.typeExpression,...(expression.compositeType.declarationExpression===undefined?[]:[expression.compositeType.declarationExpression])])])) getExpression(id, expression);
  }
  for (const call of facts.calls) {
    const expression = getExpression(call.expression, call);
    getExpression(call.callee, call);
    for (const id of call.arguments) getExpression(id, call);
    if (expression !== undefined && (expression.callee !== call.callee || JSON.stringify(expression.arguments ?? []) !== JSON.stringify(call.arguments))) {
      report('ambiguous-fact', call, 'call and expression disagree about callee or arguments');
    }
  }

  // Missing structural dependencies poison only expressions that depend on them.
  let invalidChanged = true;
  while (invalidChanged) {
    invalidChanged = false;
    for (const expression of facts.expressions) {
      const dependencies = [...expression.children, ...Object.values(expression.fields).flat(),
        ...(expression.receiver === undefined ? [] : [expression.receiver]),
        ...(expression.callee === undefined ? [] : [expression.callee]), ...(expression.arguments ?? []),
        ...(expression.compositeType===undefined?[]:[expression.compositeType.typeExpression,...(expression.compositeType.declarationExpression===undefined?[]:[expression.compositeType.declarationExpression])])];
      if (!invalidExpressions.has(expression.id) && dependencies.some((id) => invalidExpressions.has(id))) {
        invalidExpressions.add(expression.id); invalidChanged = true;
      }
    }
  }
  // Without a reaching-definition fact a later write invalidates the initializer's
  // identity for the whole scope. Conservative missing facts beat false origins.
  const writtenBindings = new Set<string>();
  const collectWrites = (id: string, seen: Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const expression = expressions.get(id);
    if (expression === undefined) return;
    if (expression.bindingId !== undefined) writtenBindings.add(expression.bindingId);
    for (const child of expression.children) collectWrites(child, seen);
  };
  for (const expression of facts.expressions) {
    if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement'].includes(expression.syntaxKind)) {
      for (const left of expression.fields.left ?? []) collectWrites(left, new Set());
    } else if (['update_expression', 'inc_statement', 'dec_statement'].includes(expression.syntaxKind)) {
      for (const child of expression.children) collectWrites(child, new Set());
    }
  }
  // A write through an alias also invalidates selection through the original.
  // No distinction between rebinding and property mutation is claimed here.
  const aliasPairs: (readonly [string, string])[] = [];
  for (const binding of facts.bindings) {
    if (binding.initializer !== undefined) {
      const initializer = expressions.get(binding.initializer);
      if (initializer?.bindingId !== undefined) aliasPairs.push([binding.id, initializer.bindingId]);
    }
    if (binding.importId !== undefined) {
      const imported = imports.get(binding.importId);
      const target = imported?.targetExpression === undefined ? undefined : expressions.get(imported.targetExpression);
      if (target?.bindingId !== undefined) aliasPairs.push([binding.id, target.bindingId]);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of aliasPairs) {
      if (writtenBindings.has(left) && !writtenBindings.has(right)) { writtenBindings.add(right); changed = true; }
      if (writtenBindings.has(right) && !writtenBindings.has(left)) { writtenBindings.add(left); changed = true; }
    }
  }
  const valueCache = new Map<string, OriginValue | undefined>();
  const bindingCache = new Map<string, OriginValue | undefined>();
  const activeExpressions = new Set<string>(); const activeBindings = new Set<string>();
  const extend = (value: OriginValue, id: string): OriginValue => ({ ...value, origin: { ...value.origin, chain: [...value.origin.chain, id] } });
  const originFromImport = (imported: CodeImportFact): OriginValue => {
    const exportedPath = imported.imported.form === 'named' ? [imported.imported.name]
      : imported.imported.form === 'default' ? ['default'] : [];
    return { kind: 'export', imported, exportedPath,
      origin: { importId: imported.id, importSpan: imported.span, exportedPath, chain: [imported.id] } };
  };
  const bindingValue = (id: string, at: CodeExpressionFact): OriginValue | undefined => {
    const binding = bindings.get(id);
    if (binding === undefined) return undefined;
    if (activeBindings.has(id)) { report('cyclic-origin', at, `cyclic initializer at ${id}`); return undefined; }
    if (binding.path !== at.path || at.span.byteStart < binding.scope.byteStart || at.span.byteEnd > binding.scope.byteEnd) {
      report('ambiguous-fact', at, 'binding identity is outside its declared file or scope'); return undefined;
    }
    if (binding.kind === 'local' && at.span.byteStart < binding.span.byteStart) {
      report('unknown-origin', at, 'local binding is used before its declaration'); return undefined;
    }
    if (writtenBindings.has(id)) {
      report('unknown-origin', at, 'binding is reassigned; no reaching-definition proof is available'); return undefined;
    }
    if (bindingCache.has(id)) return bindingCache.get(id);
    activeBindings.add(id);
    let result: OriginValue | undefined;
    if (binding.importId !== undefined && binding.initializer !== undefined) report('ambiguous-fact', binding, 'binding has both an import and an initializer');
    else if (binding.importId !== undefined) {
      const imported = imports.get(binding.importId);
      if (binding.kind !== 'import') report('ambiguous-fact', binding, 'non-import binding carries import identity');
      else if (imported !== undefined && imported.path === binding.path) {
        if (imported.typeOnly) report('unknown-origin', binding, 'type-only import cannot prove a runtime library value');
        else if (imported.targetPath === undefined) result = originFromImport(imported);
        else if (imported.targetExpression !== undefined) {
          const target = expressions.get(imported.targetExpression);
          const exportedName = imported.imported.form === 'named' ? imported.imported.name : imported.imported.form === 'default' ? 'default' : undefined;
          const chain = imported.targetChain ?? [];
          const proof = chain.map((id) => exports.get(id));
          const first = proof[0]; const last = proof[proof.length - 1];
          const complete = chain.length > 0 && new Set(chain).size === chain.length && proof.every((entry) => entry !== undefined && !entry.typeOnly &&
            Number(entry.expression !== undefined) + Number(entry.localBinding !== undefined) + Number(entry.reexport !== undefined) === 1 &&
            exportNames.get(JSON.stringify([entry.path, entry.name])) === 1);
          const linked = proof.every((entry, index) => entry !== undefined && (index === 0 || proof[index - 1]?.reexport?.targetPath === entry.path && proof[index - 1]?.reexport?.name === entry.name));
          const terminal = last?.localBinding === undefined ? undefined : bindings.get(last.localBinding);
          const endpoint = last !== undefined && target !== undefined && last.reexport === undefined && last.path === target.path &&
            (last.expression === target.id && last.localBinding === undefined || terminal !== undefined && terminal.path === last.path && terminal.id === target.bindingId && last.expression === undefined);
          if (target === undefined || first === undefined || first.path !== imported.targetPath || first.name !== exportedName || !complete || !linked || !endpoint) {
            report('dangling-fact', binding, 'internal import has no matching exported expression proof');
          } else {
            result = valueOf(imported.targetExpression);
            if (result !== undefined) for (const id of [imported.id, ...(imported.targetChain ?? [])]) result = extend(result, id);
          }
        } else report('unknown-origin', binding, 'internal import has no shared resolved exported value');
      }
      else report('dangling-fact', binding, 'import binding has no same-file import');
    } else if (binding.kind === 'local' && binding.initializer !== undefined) result = valueOf(binding.initializer);
    if (result !== undefined) result = extend(result, id);
    activeBindings.delete(id); bindingCache.set(id, result); return result;
  };
  const singleField = (expression: CodeExpressionFact, name: string): CodeExpressionFact | undefined => {
    const ids = expression.fields[name] ?? [];
    if (ids.length !== 1) return undefined;
    const id = ids[0]; return id === undefined ? undefined : getExpression(id, expression);
  };
  const staticKey = (expression: CodeExpressionFact, seen = new Set<string>()): string | undefined => {
    if (seen.has(expression.id)) { report('cyclic-origin', expression, 'cyclic structural object key'); return undefined; }
    seen.add(expression.id);
    if (expression.syntaxKind === 'literal_element' && expression.children.length === 1) {
      const id = expression.children[0]; const child = id === undefined ? undefined : getExpression(id, expression);
      return child === undefined ? undefined : staticKey(child, seen);
    }
    if (typeof expression.literal?.value === 'string') return expression.literal.value;
    if (['property_identifier', 'field_identifier', 'identifier'].includes(expression.syntaxKind)) return expression.name;
    return undefined;
  };
  const sameSpan = (left: SourceSpan, right: SourceSpan): boolean => left.path === right.path && left.byteStart === right.byteStart &&
    left.byteEnd === right.byteEnd && left.lineStart === right.lineStart && left.lineEnd === right.lineEnd;
  const contains = (outer: CodeExpressionFact, inner: CodeExpressionFact): boolean => outer.path === inner.path &&
    outer.span.path === outer.path && inner.span.path === inner.path && outer.span.byteStart <= inner.span.byteStart &&
    inner.span.byteStart < inner.span.byteEnd && inner.span.byteEnd <= outer.span.byteEnd;
  const pairParts = (pair: CodeExpressionFact): readonly [CodeExpressionFact, CodeExpressionFact] | undefined => {
    const keys = pair.fields.key; const values = pair.fields.value;
    if (pair.syntaxKind === 'pair') {
      const key = singleField(pair, 'key'); const value = singleField(pair, 'value');
      return key === undefined || value === undefined ? undefined : [key, value];
    }
    if (pair.syntaxKind !== 'keyed_element' || files.get(pair.path)?.language !== 'go') return undefined;
    const explicit = keys !== undefined || values !== undefined;
    let key: CodeExpressionFact | undefined; let value: CodeExpressionFact | undefined;
    if (explicit) {
      if (keys?.length === 1 && values?.length === 1) {
        key = getExpression(keys[0]!, pair); value = getExpression(values[0]!, pair);
      }
    } else if (pair.syntaxKind === 'keyed_element' && files.get(pair.path)?.language === 'go' && pair.children.length === 2) {
      key = getExpression(pair.children[0]!, pair); value = getExpression(pair.children[1]!, pair);
      if (key?.syntaxKind !== 'literal_element' || value?.syntaxKind !== 'literal_element' || key.children.length !== 1 || value.children.length !== 1) {
        key = undefined; value = undefined;
      }
    }
    if (key === undefined || value === undefined || key.syntaxKind !== 'literal_element' || value.syntaxKind !== 'literal_element' ||
      key.children.length !== 1 || value.children.length !== 1 || key.id === value.id || pair.children.length !== 2 ||
      pair.children[0] !== key.id || pair.children[1] !== value.id || !contains(pair, key) || !contains(pair, value) || key.span.byteEnd > value.span.byteStart) {
      report('unsupported-selector', pair, 'keyed element has no complete, ordered and contained key/value proof'); return undefined;
    }
    for (const part of [key, value]) if (part.syntaxKind === 'literal_element') {
      const child = part.children.length === 1 ? getExpression(part.children[0]!, part) : undefined;
      if (child?.id === part.id) { report('cyclic-origin', part, 'cyclic structural key/value wrapper'); return undefined; }
      if (child === undefined || !contains(part, child)) {
        report('unsupported-selector', part, 'literal element has no unique contained expression'); return undefined;
      }
    }
    return [key, value];
  };
  const directTypeScope = (spec: CodeExpressionFact): CodeExpressionFact | undefined => {
    const parents = (child: CodeExpressionFact): CodeExpressionFact[] => facts.expressions.filter((entry)=>entry.children.includes(child.id));
    const declarations=parents(spec);
    if(declarations.length!==1 || declarations[0]?.syntaxKind!=='type_declaration')return undefined;
    const declaration=declarations[0]; const containers=parents(declaration);
    if(containers.length!==1)return undefined;
    let scope=containers[0];
    if(scope?.syntaxKind==='statement_list'){
      const blocks=parents(scope);if(blocks.length!==1)return undefined;scope=blocks[0];
    }
    return scope!==undefined && ['source_file','block'].includes(scope.syntaxKind) && contains(scope,spec)?scope:undefined;
  };
  const structComposite = (expression: CodeExpressionFact): boolean => {
    if(files.get(expression.path)?.language!=='go' || files.get(expression.path)?.parsed!==true)return false;
    const type = singleField(expression, 'type');
    if (type === undefined || !contains(expression, type) || expression.children.filter((id) => id === type.id).length !== 1) return false;
    if (type.syntaxKind === 'struct_type') {
      const proof = expression.compositeType;
      return proof?.shape === 'struct' && proof.bindingId===undefined && proof.declarationExpression===undefined && proof.typeExpression === type.id &&
        sameSpan(proof.declarationSpan, type.span);
    }
    if (type.syntaxKind === 'type_identifier') {
      const proof=expression.compositeType; const binding=type.bindingId===undefined?undefined:bindings.get(type.bindingId);
      const declaration=binding?.typeDeclaration;
      if(proof?.shape!=='struct' || proof.bindingId===undefined || binding?.kind!=='type' || declaration?.shape!=='struct' || proof.bindingId!==binding.id ||
        type.name!==binding.name || proof.declarationExpression!==declaration.expression || proof.typeExpression!==type.id || !sameSpan(proof.declarationSpan,declaration.declarationSpan) ||
        binding.path!==expression.path || binding.scope.path!==expression.path || type.span.byteStart<declaration.scopeStart ||
        type.span.byteStart<binding.scope.byteStart || type.span.byteEnd>binding.scope.byteEnd ||
        facts.bindings.filter((entry)=>entry.path===binding.path&&entry.name===binding.name&&sameSpan(entry.scope,binding.scope)).length!==1) return false;
      const spec=getExpression(declaration.expression,type); const name=spec===undefined?undefined:singleField(spec,'name');
      const body=spec===undefined?undefined:singleField(spec,'type'); const scope=getExpression(declaration.scopeExpression,type);
      if(scope===undefined || !sameSpan(scope.span,binding.scope) || !contains(scope,type) || spec===undefined || !contains(scope,spec) ||
        directTypeScope(spec)?.id!==scope.id || invalidExpressions.has(spec.id) ||
        !['source_file','block'].includes(scope.syntaxKind) || declaration.scopeStart!==(scope.syntaxKind==='source_file'?scope.span.byteStart:binding.span.byteStart)) return false;
      return spec.syntaxKind==='type_spec' && name!==undefined && body?.syntaxKind==='struct_type' &&
        declaration.nameExpression===name.id && declaration.typeExpression===body.id && name.name===binding.name &&
        sameSpan(binding.span,name.span) && sameSpan(spec.span,declaration.declarationSpan) && contains(spec,name) && contains(spec,body) &&
        spec.children.filter((id)=>id===name.id).length===1 && spec.children.filter((id)=>id===body.id).length===1 &&
        name.span.byteEnd<=body.span.byteStart && declaration.scopeStart>=binding.scope.byteStart &&
        (spec.fields.type_parameters??[]).length===0 && !facts.bindings.some((candidate)=>candidate.id!==binding.id && candidate.path===type.path &&
          candidate.name===binding.name && candidate.scope.byteStart>=binding.scope.byteStart && candidate.scope.byteEnd<=binding.scope.byteEnd &&
          candidate.scope.byteStart<=type.span.byteStart && type.span.byteEnd<=candidate.scope.byteEnd &&
          type.span.byteStart>=(candidate.typeDeclaration?.scopeStart??candidate.span.byteStart));
    }
    if (expression.compositeType !== undefined) return false;
    if (type.syntaxKind !== 'qualified_type' || type.member === undefined || type.receiver === undefined) return false;
    const receiver = getExpression(type.receiver, type);
    const name = singleField(type, 'name');
    if (receiver?.bindingId === undefined || name === undefined || !contains(type, receiver) || singleField(type, 'package')?.id !== receiver.id ||
      name.name !== type.member || !contains(type, name) || type.children.length !== 2 ||
      type.children[0] !== receiver.id || type.children[1] !== name.id || receiver.span.byteEnd > name.span.byteStart) return false;
    const binding = bindings.get(receiver.bindingId);
    if (binding?.kind !== 'import' || binding.importId === undefined || writtenBindings.has(binding.id) || binding.path !== expression.path ||
      binding.scope.path !== expression.path || binding.scope.byteStart > receiver.span.byteStart || binding.scope.byteEnd < receiver.span.byteEnd) return false;
    const imported = imports.get(binding.importId);
    if (imported === undefined || imported.typeOnly || imported.targetPath !== undefined || imported.targetExpression !== undefined || imported.targetChain !== undefined ||
      imported.path !== binding.path || imported.local !== binding.name || receiver.name !== binding.name || imported.imported.form !== 'namespace' ||
      !sameSpan(imported.span, binding.span) ||
      facts.imports.filter((entry) => entry.path === imported.path && entry.local === imported.local).length !== 1 ||
      facts.bindings.filter((entry) => entry.importId === imported.id).length !== 1) return false;
    if (imported.package !== undefined && (imported.package.ecosystem !== 'go' ||
      imported.specifier !== imported.package.name && !imported.specifier.startsWith(`${imported.package.name}/`))) return false;
    if(facts.bindings.some((candidate)=>candidate.id!==binding.id && candidate.path===receiver.path && candidate.name===binding.name &&
      candidate.scope.byteStart>=binding.scope.byteStart && candidate.scope.byteEnd<=binding.scope.byteEnd &&
      candidate.scope.byteStart<=receiver.span.byteStart && receiver.span.byteEnd<=candidate.scope.byteEnd &&
      receiver.span.byteStart>=(candidate.typeDeclaration?.scopeStart??candidate.span.byteStart)))return false;
    const origin = valueOf(type.id);
    return origin?.kind === 'export' && origin.imported.id === imported.id &&
      (registry.types ?? []).filter((entry) => entry.ecosystem === 'go' && entry.package === imported.specifier &&
        JSON.stringify(entry.exportedPath) === JSON.stringify(origin.exportedPath)).length === 1;
  };
  const objectMember = (expression: CodeExpressionFact, key: string, seen: Set<string>, struct = false): CodeExpressionFact | undefined => {
    if (seen.has(expression.id)) { report('cyclic-origin', expression, 'cyclic argument initializer'); return undefined; }
    seen.add(expression.id);
    if (expression.bindingId !== undefined) {
      const binding = bindings.get(expression.bindingId);
      if (writtenBindings.has(expression.bindingId)) {
        report('unsupported-selector', expression, 'argument binding or one of its properties is reassigned'); return undefined;
      }
      if (binding?.kind !== 'local' || binding.initializer === undefined) return undefined;
      if (expression.span.byteStart < binding.span.byteStart) {
        report('unsupported-selector', expression, 'argument binding is used before declaration'); return undefined;
      }
      if (binding.path !== expression.path || expression.span.byteStart < binding.scope.byteStart || expression.span.byteEnd > binding.scope.byteEnd) {
        report('ambiguous-fact', expression, 'argument binding is outside its declared file or scope'); return undefined;
      }
      const initializer = getExpression(binding.initializer, expression);
      return initializer === undefined ? undefined : objectMember(initializer, key, seen);
    }
    if (['parenthesized_expression', 'await_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'literal_element'].includes(expression.syntaxKind)) {
      const childId = expression.children[0];
      const child = childId === undefined ? undefined : getExpression(childId, expression);
      return expression.children.length === 1 && child !== undefined ? objectMember(child, key, seen) : undefined;
    }
    if (expression.syntaxKind === 'composite_literal') {
      const body = singleField(expression, 'body');
      if (body === undefined || !contains(expression, body)) return undefined;
      const provedStruct = structComposite(expression);
      if (!provedStruct && files.get(expression.path)?.language === 'go') {
        report('unsupported-selector', expression, 'composite type has no unique struct-shape proof'); return undefined;
      }
      return objectMember(body, key, seen, provedStruct);
    }
    if (expression.syntaxKind !== 'object' && expression.syntaxKind !== 'literal_value') return undefined;
    const found: CodeExpressionFact[] = [];
    for (const childId of expression.children) {
      const child = getExpression(childId, expression);
      if (child === undefined) return undefined;
      if (child.syntaxKind === 'comment') continue;
      if (files.get(expression.path)?.language === 'go' && !contains(expression, child)) {
        report('unsupported-selector', child, 'keyed element is outside its composite body'); return undefined;
      }
      if (child.syntaxKind !== 'pair' && child.syntaxKind !== 'keyed_element') {
        report('unsupported-selector', child, 'object spread, shorthand or non-keyed element is not an exact property proof'); return undefined;
      }
      const parts = pairParts(child);
      if (parts === undefined) return undefined;
      const [property, selected] = parts;
      let terminal = property;
      if (terminal.syntaxKind === 'literal_element' && terminal.children.length === 1) terminal = getExpression(terminal.children[0]!, terminal) ?? terminal;
      if (files.get(expression.path)?.language === 'go' && typeof terminal.literal?.value !== 'string' && !struct) {
        report('unsupported-selector', property, 'identifier key needs a proven struct type, not a named map or unknown type'); return undefined;
      }
      const name = staticKey(property);
      if (name === undefined) { report('unsupported-selector', property, 'object key has no grammar-decoded static value'); return undefined; }
      if (name === key) found.push(selected);
    }
    if (found.length > 1) { report('ambiguous-fact', expression, `duplicate object property ${key}`); return undefined; }
    return found[0];
  };
  const select = (selector: ArgumentSelector, call: CodeCallFact, model: LibraryModel): SelectedArgument => {
    const id = call.arguments[selector.index];
    let expression = id === undefined ? undefined : getExpression(id, call);
    for (const key of selector.path) {
      if (expression === undefined) break;
      expression = objectMember(expression, key, new Set());
    }
    if (expression === undefined && selector.required) report('unsupported-selector', call, `argument ${selector.name} cannot be selected exactly`, model.id);
    return { name: selector.name, required: selector.required,
      ...(expression === undefined ? {} : { expression: expression.id, span: expression.span }) };
  };
  const holderAt = (span: SourceSpan): string => {
    const symbols = facts.symbols.filter((symbol) => symbol.callable && symbol.path === span.path && symbol.span.byteStart <= span.byteStart && span.byteEnd <= symbol.span.byteEnd)
      .sort((a, b) => (a.span.byteEnd - a.span.byteStart) - (b.span.byteEnd - b.span.byteStart) || byCodePoint(a.key, b.key));
    return symbols[0]?.key ?? `code.file:${span.path}`;
  };
  const apply = (models: readonly LibraryModel[], source: OriginValue, expression: CodeExpressionFact, call?: CodeCallFact): OriginValue | undefined => {
    if (models.length > 1) { report('ambiguous-model', expression, `multiple models match: ${models.map((model) => model.id).join(', ')}`); return undefined; }
    const model = models[0]; if (model === undefined) return undefined;
    const imported = importedOf(source);
    const origin: LibraryOrigin = { ...source.origin,
      exportedPath: source.kind === 'export' ? source.exportedPath : source.origin.exportedPath,
      chain: [...source.origin.chain, model.id, expression.id] };
    const roleOrigin = source.kind === 'member' ? source.receiver.roleOrigin
      : source.kind === 'role' ? source.roleOrigin : expression.id;
    const args = call === undefined ? [] : model.arguments.map((selector) => select(selector, call, model));
    if (args.some((arg) => arg.required && arg.expression === undefined)) return undefined;
    if (model.effect !== undefined) {
      const effect: LibraryEffect = { kind: model.effect, modelId: model.id, package: model.package,
        expression: expression.id, span: call?.span ?? expression.span, holder: call?.holder ?? holderAt(expression.span), origin,
        ...(source.kind === 'member' ? { receiverExpression: source.receiverExpression, member: source.member, roleOrigin } : {}),
        ...(model.returnRole === undefined ? {} : { returnRole: model.returnRole }), arguments: args };
      effects.set(JSON.stringify([model.id, expression.id]), effect);
    }
    return model.returnRole === undefined ? undefined : { kind: 'role', imported, role: model.returnRole, origin, roleOrigin };
  };
  const valueOf = (id: string): OriginValue | undefined => {
    if (valueCache.has(id)) return valueCache.get(id);
    const expression = expressions.get(id); if (expression === undefined) return undefined;
    if (invalidExpressions.has(id)) { report('dangling-fact', expression, 'expression depends on missing or ambiguous facts'); return undefined; }
    if (files.get(expression.path)?.parsed !== true) {
      report('unknown-origin', expression, 'source file has no successful parse fact'); return undefined;
    }
    if (activeExpressions.has(id)) { report('cyclic-origin', expression, 'cyclic expression origin'); return undefined; }
    activeExpressions.add(id);
    let result: OriginValue | undefined;
    const call = calls.get(id);
    if (call !== undefined) {
      if (expression.callee !== call.callee || JSON.stringify(expression.arguments ?? []) !== JSON.stringify(call.arguments)) {
        report('ambiguous-fact', call, 'call and expression disagree about callee or arguments');
      } else {
        const callee = valueOf(call.callee);
        if (callee !== undefined) {
          const candidates = matching(callee, call.construct ? 'construct' : 'call');
          if (candidates.length === 0) report('unknown-origin', call, 'proven origin has no supported invocation model');
          else result = apply(candidates, callee, expression, call);
        } else report('unknown-origin', call, 'callee has no proven imported origin or receiver role');
      }
    } else if (expression.bindingId !== undefined) result = bindingValue(expression.bindingId, expression);
    else if (expression.receiver !== undefined && expression.member !== undefined) {
      const receiver = valueOf(expression.receiver);
      if (receiver?.kind === 'export') {
        const path = [...receiver.exportedPath, expression.member];
        result = { ...receiver, exportedPath: path, origin: { ...receiver.origin, exportedPath: path } };
      } else if (receiver?.kind === 'role') result = { kind: 'member', receiver, member: expression.member, receiverExpression: expression.receiver, origin: receiver.origin };
      else report('unknown-origin', expression, 'full member receiver has no proven library role');
    } else if (expression.syntaxKind === 'subscript_expression' || expression.syntaxKind === 'index_expression') {
      const receiver = singleField(expression, expression.syntaxKind === 'subscript_expression' ? 'object' : 'operand');
      const index = singleField(expression, 'index');
      const key = index?.literal?.value;
      if (typeof key !== 'string') report('dynamic-member', expression, 'computed member has no grammar-decoded string key');
      else if (receiver !== undefined) {
        const source = valueOf(receiver.id);
        if (source?.kind === 'export') result = { ...source, exportedPath: [...source.exportedPath, key] };
        else if (source?.kind === 'role') result = { kind: 'member', receiver: source, member: key, receiverExpression: receiver.id, origin: source.origin };
        else report('unknown-origin', expression, 'computed member receiver has no proven library role');
      }
    } else if (['parenthesized_expression', 'await_expression', 'as_expression', 'satisfies_expression', 'non_null_expression'].includes(expression.syntaxKind)) {
      const child = expression.children[0];
      // An assertion's type child never supplies an origin.
      if (child !== undefined) result = valueOf(child);
    }
    if (result !== undefined) {
      result = extend(result, id);
      const read = matching(result, 'read');
      if (read.length > 0) result = apply(read, result, expression);
    }
    activeExpressions.delete(id); valueCache.set(id, result); return result;
  };
  for (const expression of [...facts.expressions].sort((a, b) => byCodePoint(a.path, b.path) || a.span.byteStart - b.span.byteStart || byCodePoint(a.id, b.id))) valueOf(expression.id);
  const orderedDiagnostics = [...diagnostics.values()].sort((a, b) => byCodePoint(a.path, b.path) || a.span.byteStart - b.span.byteStart || byCodePoint(a.code, b.code) || byCodePoint(a.reason, b.reason));
  return {
    roles: [...valueCache.entries()].flatMap(([expression, value]) => value?.kind === 'role'
      ? [{ expression, role: value.role, roleOrigin: value.roleOrigin, origin: value.origin }] : [])
      .sort((a, b) => byCodePoint(a.expression, b.expression)),
    effects: [...effects.values()].sort((a, b) => byCodePoint(a.span.path, b.span.path) || a.span.byteStart - b.span.byteStart || byCodePoint(a.modelId, b.modelId)),
    diagnostics: orderedDiagnostics,
    gaps: [...facts.gaps, ...orderedDiagnostics.map((item) => ({ path: item.path,
      reason: `${item.path}:${item.span.lineStart}: ${item.code}: ${item.reason}${item.modelId === undefined ? '' : ` [${item.modelId}]`}` }))],
  };
}

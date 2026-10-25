import { describe, expect, test } from 'bun:test';
import type { CodeBindingFact, CodeCallFact, CodeExpressionFact, CodeFacts, CodeImportFact } from '../src/extract/code/facts.js';
import type { SourceSpan } from '../src/extract/records.js';
import { evaluateLibraryModels } from '../src/extract/library-models/evaluate.js';
import type { LibraryModel, LibraryRegistry, LibraryRole } from '../src/extract/library-models/model.js';
import { canonicalLibraryModels, libraryModelDigest, libraryRegistry, libraryRegistryDigest, validateLibraryRegistry } from '../src/extract/library-models/validate.js';

/** Fixtures build the real immutable fact shape, never a parallel source scanner. */
class FactsFixture {
  readonly expressions: CodeExpressionFact[] = [];
  readonly bindings: CodeBindingFact[] = [];
  readonly imports: CodeImportFact[] = [];
  readonly calls: CodeCallFact[] = [];
  readonly path: string;
  private next = 10;
  constructor(readonly go = false) { this.path = go ? 'packages/telemetry/sample.go' : 'modules/instrumentation/sample.ts'; }
  span(): SourceSpan { const at = this.next; this.next += 10; return { path: this.path, byteStart: at, byteEnd: at + 5, lineStart: Math.floor(at / 10), lineEnd: Math.floor(at / 10) }; }
  scope(): SourceSpan { return { path: this.path, byteStart: 0, byteEnd: 100000, lineStart: 1, lineEnd: 10000 }; }
  expression(syntaxKind: string, rest: Partial<Omit<CodeExpressionFact, 'id' | 'path' | 'span' | 'syntaxKind'>> = {}): string {
    const span = this.span(); const id = `${this.path}:${span.byteStart}:${syntaxKind}`;
    this.expressions.push({ id, path: this.path, syntaxKind, span, children: [], fields: {}, ...rest }); return id;
  }
  literal(value: string): string { return this.expression(this.go ? 'interpreted_string_literal' : 'string', { literal: { kind: 'string', raw: JSON.stringify(value), value } }); }
  binding(name: string, kind: CodeBindingFact['kind'], initializer?: string, importId?: string): string {
    const span = this.span(); const id = `${this.path}:${span.byteStart}:binding`;
    this.bindings.push({ id, name, kind, path: this.path, span, scope: this.scope(), ...(initializer === undefined ? {} : { initializer }), ...(importId === undefined ? {} : { importId }) }); return id;
  }
  identifier(name: string, bindingId?: string): string { return this.expression('identifier', { name, ...(bindingId === undefined ? {} : { bindingId }) }); }
  alias(value: string, name = 'renamedLocal'): string { return this.identifier(name, this.binding(name, 'local', value)); }
  imported(pkg: string, form: 'named' | 'default' | 'namespace' = 'namespace', exportedName = ''): string {
    const span = this.span(); const id = `${this.path}:${span.byteStart}:import`;
    const imported = form === 'named' ? { form, name: exportedName } : { form };
    this.imports.push({ id, path: this.path, local: 'renamedPackage', specifier: pkg, imported, span });
    return this.identifier('renamedPackage', this.binding('renamedPackage', 'import', undefined, id));
  }
  member(receiver: string, member: string): string { return this.expression(this.go ? 'selector_expression' : 'member_expression', { receiver, member, children: [receiver] }); }
  call(callee: string, args: readonly string[] = [], construct = false): string {
    const id = this.expression(construct ? 'new_expression' : 'call_expression', { callee, arguments: args, children: [callee, ...args], fields: { function: [callee], arguments: args } });
    const expression = this.expressions.find((entry) => entry.id === id);
    if (expression === undefined) throw new Error('fixture call expression missing');
    this.calls.push({ expression: id, path: this.path, span: expression.span, callee, arguments: args, construct, holder: `code.symbol:${this.path}#arbitraryWorker` }); return id;
  }
  object(properties: ReadonlyMap<string, string>): string {
    const pairs = [...properties].map(([key, value]) => {
      const property = this.expression(this.go ? 'identifier' : 'property_identifier', { name: key });
      if (!this.go) return this.expression('pair', { children: [property, value], fields: { key: [property], value: [value] } });
      const wrappedKey = this.expression('literal_element', { children: [property] });
      const wrappedValue = this.expression('literal_element', { children: [value] });
      return this.expression('keyed_element', { children: [wrappedKey, wrappedValue] });
    });
    const body = this.expression(this.go ? 'literal_value' : 'object', { children: pairs });
    if (!this.go) return body;
    const type = this.expression('struct_type');
    const composite = this.expression('composite_literal', { children: [type, body], fields: { type: [type], body: [body] } });
    // Synthetic cases use the exact raw grammar shape and coherent spans, not
    // invented key/value fields. Real-parser cases independently check this ABI.
    const locate = (id: string, start: number): number => {
      const index = this.expressions.findIndex((entry) => entry.id === id);
      const entry = this.expressions[index]; if (entry === undefined) throw new Error(`missing fixture ${id}`);
      let end = start + 1;
      for (const child of entry.children) end = locate(child, end) + 1;
      this.expressions[index] = { ...entry, span: { ...entry.span, byteStart: start, byteEnd: end } };
      return end;
    };
    this.next = locate(composite, this.next) + 10;
    const typeFact = this.expressions.find((entry) => entry.id === type);
    const index = this.expressions.findIndex((entry) => entry.id === composite);
    const expression = this.expressions[index];
    if (typeFact === undefined || expression === undefined) throw new Error('missing fixture composite');
    this.expressions[index] = { ...expression, compositeType: { shape: 'struct', typeExpression: type, declarationSpan: typeFact.span } };
    return composite;
  }
  argumentsFor(model: LibraryModel): readonly string[] {
    const byIndex = new Map<number, Map<string, string>>();
    for (const selector of model.arguments) {
      const properties = byIndex.get(selector.index) ?? new Map<string, string>();
      if (selector.path.length === 1 && selector.path[0] !== undefined) properties.set(selector.path[0], this.literal(`value-${selector.name}`));
      byIndex.set(selector.index, properties);
    }
    const max = Math.max(-1, ...byIndex.keys());
    return Array.from({ length: max + 1 }, (_, index) => {
      const properties = byIndex.get(index); return properties !== undefined && properties.size > 0 ? this.object(properties) : this.literal(`argument-${index}`);
    });
  }
  invoke(model: LibraryModel, suppliedReceiver?: string): string {
    let target: string;
    if (model.target.kind === 'export') {
      const path = model.target.exportedPaths[0];
      if (path === undefined) throw new Error('fixture needs an exported path');
      const form = model.target.importRoles.includes('namespace') ? 'namespace' : model.target.importRoles[0];
      if (form === undefined) throw new Error('fixture needs an import role');
      target = this.imported(model.package, form, path[0]);
      const suffix = form === 'namespace' ? path : path.slice(1);
      for (const part of suffix) target = this.member(target, part);
    } else {
      const receiver = suppliedReceiver ?? this.role(model.package, model.target.receiverRole);
      target = this.member(receiver, model.target.member === '*' ? 'WHATEVER_KEY' : model.target.member);
    }
    return model.invoke === 'read' ? target : this.call(target, this.argumentsFor(model), model.invoke === 'construct');
  }
  role(pkg: string, role: LibraryRole, seen: readonly string[] = []): string {
    if (seen.includes(role)) throw new Error(`fixture provider cycle ${role}`);
    const providers = libraryRegistry.models.filter((entry) => entry.package === pkg && entry.returnRole === role);
    const provider = providers.find((entry) => entry.target.kind === 'export') ?? providers[0];
    if (provider === undefined) throw new Error(`fixture provider missing ${pkg}:${role}`);
    const supplied = provider.target.kind === 'member' ? this.role(pkg, provider.target.receiverRole, [...seen, role]) : undefined;
    return this.alias(this.invoke(provider, supplied));
  }
  facts(): CodeFacts {
    return { files: [{ path: this.path, language: this.go ? 'go' : 'typescript', parsed: true }], symbols: [], imports: this.imports,
      bindings: this.bindings, expressions: this.expressions, calls: this.calls, sites: [], gaps: [] };
  }
}

function hasOutcome(model: LibraryModel, expression: string, facts: CodeFacts): boolean {
  const result = evaluateLibraryModels(facts);
  return model.effect !== undefined ? result.effects.some((effect) => effect.modelId === model.id && effect.expression === expression)
    : result.roles.some((role) => role.expression === expression && role.role === model.returnRole && role.origin.chain.includes(model.id));
}

// Every model declares unique check IDs and has actual behavior coverage, not just schema presence.
describe('all library registry entries', () => {
  for (const model of libraryRegistry.models) {
    test(model.checks.positive, () => {
      const fixture = new FactsFixture(model.ecosystem === 'go'); const expression = fixture.invoke(model);
      expect(hasOutcome(model, expression, fixture.facts())).toBe(true);
      const result = evaluateLibraryModels(fixture.facts());
      const effect = result.effects.find((entry) => entry.modelId === model.id && entry.expression === expression);
      if (effect !== undefined) {
        const declared = fixture.expressions.find((entry) => entry.id === expression);
        const imported = fixture.imports.find((entry) => entry.id === effect.origin.importId);
        if (declared === undefined || imported === undefined) throw new Error(`fixture ${expression} for model ${model.id} in ${fixture.path} has no exact expression/import origin ${effect.origin.importId}`);
        expect(effect.span).toEqual(declared.span);
        expect(effect.origin.chain).toContain(model.id);
        expect(effect.origin.importSpan).toEqual(imported.span);
        if (model.invoke !== 'read') expect(effect.holder).toBe(`code.symbol:${fixture.path}#arbitraryWorker`);
      }
    });
    test(model.checks.negative, () => {
      const wrongPackage = new FactsFixture(model.ecosystem === 'go'); const first = wrongPackage.invoke(model);
      const wrongFacts = wrongPackage.facts();
      expect(hasOutcome(model, first, { ...wrongFacts, imports: wrongFacts.imports.map((entry) => ({ ...entry, specifier: 'unrelated-library' })) })).toBe(false);
      const shadow = new FactsFixture(model.ecosystem === 'go'); const second = shadow.invoke(model); const shadowFacts = shadow.facts();
      expect(hasOutcome(model, second, { ...shadowFacts, bindings: shadowFacts.bindings.map((entry): CodeBindingFact => entry.kind === 'import'
        ? { id: entry.id, name: entry.name, path: entry.path, span: entry.span, scope: entry.scope, kind: 'parameter' } : entry) })).toBe(false);
      if (model.target.kind === 'member') {
        const qualified = new FactsFixture(model.ecosystem === 'go');
        // A suffix equal to the declared local name is not the local's identity.
        const fake = qualified.member(qualified.identifier('unrelatedReceiver'), 'renamedLocal');
        const third = qualified.invoke(model, fake);
        expect(hasOutcome(model, third, qualified.facts())).toBe(false);
      }
    });
  }
});

describe('independent receiver regressions', () => {
  test('renamed pino declaration and use exclude other.logger.info and parameter shadows', () => {
    const f = new FactsFixture();
    const factory = f.imported('pino', 'default'); const declaration = f.call(factory);
    const logger = f.alias(declaration, 'logger'); const real = f.call(f.member(logger, 'info'), [f.literal('notice')]);
    const other = f.identifier('other', f.binding('other', 'parameter'));
    const decoy = f.call(f.member(f.member(other, 'logger'), 'info'));
    const shadow = f.identifier('logger', f.binding('logger', 'parameter')); const shadowCall = f.call(f.member(shadow, 'info'));
    const result = evaluateLibraryModels(f.facts());
    expect(result.effects.filter((entry) => entry.kind === 'logger-declare').map((entry) => entry.expression)).toEqual([declaration]);
    expect(result.effects.filter((entry) => entry.kind === 'logger-use').map((entry) => entry.expression)).toEqual([real]);
    expect(result.effects.some((entry) => entry.expression === decoy || entry.expression === shadowCall)).toBe(false);
  });
  test('prom-client named alias: standalone requests.inc is not other.requests.inc', () => {
    const f = new FactsFixture(); const constructor = f.imported('prom-client', 'named', 'Counter');
    const options = f.object(new Map([['name', f.literal('arbitrary_total')]]));
    const declaration = f.call(constructor, [options], true); const metric = f.alias(declaration, 'requests');
    const real = f.call(f.member(metric, 'inc')); const other = f.identifier('other', f.binding('other', 'parameter'));
    const decoy = f.call(f.member(f.member(other, 'requests'), 'inc'));
    const result = evaluateLibraryModels(f.facts());
    expect(result.effects.filter((entry) => entry.kind === 'metric-declare').map((entry) => entry.expression)).toEqual([declaration]);
    expect(result.effects.filter((entry) => entry.kind === 'metric-update').map((entry) => entry.expression)).toEqual([real]);
    expect(result.effects.some((entry) => entry.expression === decoy)).toBe(false);
  });
  test('later reassignment cannot keep the imported factory return identity', () => {
    const f = new FactsFixture(); const logger = f.alias(f.call(f.imported('pino', 'default')), 'changed');
    const use = f.call(f.member(logger, 'info'));
    f.expression('assignment_expression', { children: [logger, f.literal('other')], fields: { left: [logger] } });
    const result = evaluateLibraryModels(f.facts());
    expect(result.effects.some((entry) => entry.expression === use)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.reason.includes('reassigned'))).toBe(true);
  });
  test('mutating options through a property or alias cannot select stale topic data', () => {
    const f = new FactsFixture(); const producer = f.role('kafkajs', 'message-producer');
    const opts = f.alias(f.object(new Map([['topic', f.literal('old-event')], ['messages', f.literal('payload')]])), 'options');
    const alias = f.alias(opts, 'alternateOptions');
    const target = f.member(alias, 'topic');
    f.expression('assignment_expression', { children: [target, f.literal('new-event')], fields: { left: [target] } });
    const call = f.call(f.member(producer, 'send'), [opts]); const result = evaluateLibraryModels(f.facts());
    expect(result.effects.some((entry) => entry.expression === call)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'unsupported-selector')).toBe(true);
  });
  test('cached valid binding origin cannot escape its lexical scope', () => {
    const f = new FactsFixture(); const made = f.call(f.imported('pino', 'default'));
    const local = f.alias(made, 'localLogger'); const first = f.call(f.member(local, 'info'));
    const use = f.identifier('localLogger', f.expressions.find((entry) => entry.id === local)?.bindingId);
    const outside = f.call(f.member(use, 'info')); const facts = f.facts();
    const bindingId = f.expressions.find((entry) => entry.id === local)?.bindingId;
    const at = f.expressions.find((entry) => entry.id === first)?.span.byteEnd;
    if (at === undefined) throw new Error('first call span absent');
    const result = evaluateLibraryModels({ ...facts, bindings: facts.bindings.map((entry) => entry.id === bindingId
      ? { ...entry, scope: { ...entry.scope, byteEnd: at } } : entry) });
    expect(result.effects.some((entry) => entry.expression === first)).toBe(true);
    expect(result.effects.some((entry) => entry.expression === outside)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.reason.includes('outside'))).toBe(true);
  });
  test('a constructed Kafka client has no publish effect before send', () => {
    const f = new FactsFixture(); const client = f.alias(f.call(f.member(f.imported('kafkajs'), 'Kafka'), [], true));
    f.alias(f.call(f.member(client, 'producer')));
    expect(evaluateLibraryModels(f.facts()).effects.some((entry) => entry.kind === 'message-publish')).toBe(false);
  });
  test('Go os import alias has exact env-read source and holder', () => {
    const f = new FactsFixture(true); const call = f.call(f.member(f.imported('os'), 'Getenv'), [f.literal('SOME_CONFIGURATION')]);
    const effect = evaluateLibraryModels(f.facts()).effects.find((entry) => entry.expression === call);
    expect(effect?.kind).toBe('env-read'); expect(effect?.arguments[0]?.expression).toBe(f.calls[0]?.arguments[0]);
    expect(effect?.holder).toBe(`code.symbol:${f.path}#arbitraryWorker`);
  });
  test('dynamic environment indexing is an explicit gap, not a guessed variable', () => {
    const f = new FactsFixture(); const env = f.member(f.imported('node:process', 'default'), 'env');
    const key = f.identifier('dynamicKey', f.binding('dynamicKey', 'parameter'));
    f.expression('subscript_expression', { children: [env, key], fields: { object: [env], index: [key] } });
    const result = evaluateLibraryModels(f.facts());
    expect(result.effects.some((entry) => entry.kind === 'env-read')).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'dynamic-member')).toBe(true);
  });
});

describe('registry validation and failure transparency', () => {
  const first = libraryRegistry.models[0];
  if (first === undefined) throw new Error('registry must have entries');
  test('rejects executable, unknown, duplicate and conflicting data', () => {
    expect(() => validateLibraryRegistry({ ...libraryRegistry, sourceRegex: 'anything' })).toThrow('unknown field');
    expect(() => validateLibraryRegistry({ ...libraryRegistry, models: [{ ...first, target: { kind: 'name-only', member: 'info' } }] })).toThrow();
    expect(() => validateLibraryRegistry({ ...libraryRegistry, models: [first, first] })).toThrow('duplicate');
    const conflict = { ...first, id: 'conflict', checks: { positive: 'conflict-positive', negative: 'conflict-negative' } };
    expect(() => validateLibraryRegistry({ ...libraryRegistry, models: [first, conflict] })).toThrow('conflicting');
    expect(() => validateLibraryRegistry({ ...libraryRegistry, models: [{ ...first, arguments: [{ name: 'x', index: -1, path: [], required: true }] }] })).toThrow('nonnegative');
  });
  test('canonical digest verifies content and ignores JSON object-key and model ordering', () => {
    const reordered: LibraryRegistry = { models: [...libraryRegistry.models].reverse(), types: [...(libraryRegistry.types ?? [])].reverse(), schemaVersion: 1 };
    expect(canonicalLibraryModels(reordered)).toBe(canonicalLibraryModels(libraryRegistry));
    expect(libraryRegistryDigest(reordered)).toBe(libraryModelDigest);
    const changed = { ...libraryRegistry, models: libraryRegistry.models.map((entry) => entry.id === first.id ? { ...entry, reference: `${entry.reference}#new-reference` } : entry) };
    expect(libraryRegistryDigest(changed)).not.toBe(libraryModelDigest);
    expect(() => libraryRegistryDigest({ schemaVersion: 2, models: [] })).toThrow();
  });
  test('preserves unread source gap and reports dangling facts with exact locations', () => {
    const f = new FactsFixture(); const at = f.expression('identifier', { bindingId: 'absent' });
    f.call('missing-expression'); const facts = f.facts(); const gap = { path: 'broken.ts', reason: 'source unreadable' };
    const result = evaluateLibraryModels({ ...facts, gaps: [gap] });
    expect(result.gaps[0]).toEqual(gap);
    expect(result.diagnostics.find((entry) => entry.expression === at)?.code).toBe('dangling-fact');
    expect(result.gaps.some((entry) => entry.reason.includes(`${f.path}:`))).toBe(true);
    expect(result.effects).toEqual([]);
  });
  test('duplicate fact IDs and cyclic aliases cannot invent origins', () => {
    const f = new FactsFixture(); const bindingId = f.binding('cycle', 'local'); const expression = f.identifier('cycle', bindingId);
    const facts = f.facts();
    const cyclic = { ...facts, bindings: facts.bindings.map((entry) => entry.id === bindingId ? { ...entry, initializer: expression } : entry) };
    expect(evaluateLibraryModels(cyclic).diagnostics.some((entry) => entry.code === 'cyclic-origin')).toBe(true);
    expect(evaluateLibraryModels({ ...facts, expressions: [...facts.expressions, ...facts.expressions] }).diagnostics.some((entry) => entry.code === 'ambiguous-fact')).toBe(true);
  });
  test('single-child Go key wrapper is structural, cyclic key wrapper is a located gap', () => {
    const f = new FactsFixture(true); const value = f.literal('neutral_total');
    const options = f.object(new Map([['Name', value]]));
    const wrapped = f.expressions.find((entry) => entry.syntaxKind === 'literal_element' &&
      entry.children.some((id) => f.expressions.find((child) => child.id === id)?.name === 'Name'))?.id;
    if (wrapped === undefined) throw new Error('fixture key wrapper missing');
    const declaration = f.call(f.member(f.imported('github.com/prometheus/client_golang/prometheus'), 'NewCounter'), [options]);
    expect(evaluateLibraryModels(f.facts()).effects.some((entry) => entry.expression === declaration)).toBe(true);
    const facts = f.facts(); const result = evaluateLibraryModels({ ...facts, expressions: facts.expressions.map((entry) => entry.id === wrapped ? { ...entry, children: [wrapped] } : entry) });
    expect(result.effects.some((entry) => entry.expression === declaration)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'cyclic-origin')).toBe(true);
  });
  test('writing other.logger does not invalidate the standalone logger binding', () => {
    const f = new FactsFixture(); const logger = f.alias(f.call(f.imported('pino', 'default')), 'logger');
    const other = f.identifier('other', f.binding('other', 'parameter')); const property = f.member(other, 'logger');
    f.expression('assignment_expression', { children: [property, f.literal('replacement')], fields: { left: [property] } });
    const use = f.call(f.member(logger, 'info'));
    expect(evaluateLibraryModels(f.facts()).effects.some((entry) => entry.expression === use && entry.kind === 'logger-use')).toBe(true);
  });
  test('missing required declaration selector cannot grant an update receiver role', () => {
    const f = new FactsFixture(); const declaration = f.call(f.imported('prom-client', 'named', 'Counter'), [f.object(new Map())], true);
    const update = f.call(f.member(f.alias(declaration), 'inc')); const result = evaluateLibraryModels(f.facts());
    expect(result.effects.some((entry) => entry.expression === declaration || entry.expression === update)).toBe(false);
    expect(result.roles.some((entry) => entry.expression === declaration)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'unsupported-selector')).toBe(true);
  });
  test('dangling optional argument is not an intact call with a valid effect', () => {
    const f = new FactsFixture(); const declaration = f.call(f.imported('pino', 'default'), ['missing-optional-options']);
    const result = evaluateLibraryModels(f.facts());
    expect(result.effects.some((entry) => entry.expression === declaration)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'dangling-fact')).toBe(true);
  });
  test('missing required publish arguments emit a gap, not publication', () => {
    const f = new FactsFixture(); const producer = f.role('kafkajs', 'message-producer');
    const call = f.call(f.member(producer, 'send'), [f.object(new Map([['topic', f.literal('arbitrary-event')]]))]);
    const result = evaluateLibraryModels(f.facts());
    expect(result.effects.some((entry) => entry.expression === call)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.expression === call && entry.code === 'unsupported-selector')).toBe(true);
  });
  test('same package spelling cannot override an internal target or a manifest mismatch', () => {
    const f = new FactsFixture(); const made = f.call(f.imported('pino', 'default')); const facts = f.facts();
    const internal = { ...facts, imports: facts.imports.map((entry) => ({ ...entry, targetPath: 'modules/not-a-library.ts' })) };
    expect(evaluateLibraryModels(internal).effects.some((entry) => entry.expression === made)).toBe(false);
    const mismatched = { ...facts, imports: facts.imports.map((entry): CodeImportFact => ({ ...entry,
      package: { ecosystem: 'node', name: 'different-package', manifestPath: 'package.json', declaredVersion: '1' } })) };
    expect(evaluateLibraryModels(mismatched).effects.some((entry) => entry.expression === made)).toBe(false);
  });
  test('unparsed files and disagreement between call records never emit effects', () => {
    const f = new FactsFixture(); const made = f.call(f.imported('pino', 'default')); const facts = f.facts();
    expect(evaluateLibraryModels({ ...facts, files: facts.files.map((entry) => ({ ...entry, parsed: false })) }).effects).toEqual([]);
    const result = evaluateLibraryModels({ ...facts, calls: facts.calls.map((entry) => ({ ...entry, callee: 'different-callee' })) });
    expect(result.effects.some((entry) => entry.expression === made)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'ambiguous-fact')).toBe(true);
  });
  test('duplicate object keys and unknown spreads do not prove a metric name', () => {
    const f = new FactsFixture(); const constructor = f.imported('prom-client', 'named', 'Counter');
    const first = f.object(new Map([['name', f.literal('one')]])); const second = f.object(new Map([['name', f.literal('two')]]));
    const pairs = f.expressions.filter((entry) => entry.id === first || entry.id === second).flatMap((entry) => entry.children);
    const duplicate = f.expression('object', { children: pairs }); const declaration = f.call(constructor, [duplicate], true);
    const result = evaluateLibraryModels(f.facts());
    expect(result.effects.some((entry) => entry.expression === declaration)).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'ambiguous-fact')).toBe(true);
  });
  test('no grammar-decoded computed key means no property proof', () => {
    const f = new FactsFixture(); const env = f.member(f.imported('node:process', 'default'), 'env');
    const key = f.expression('string', { literal: { kind: 'string', raw: "'NOT_DECODED'" } });
    f.expression('subscript_expression', { children: [env, key], fields: { object: [env], index: [key] } });
    expect(evaluateLibraryModels(f.facts()).diagnostics.some((entry) => entry.code === 'dynamic-member')).toBe(true);
  });
});


describe('closed external type schemas', () => {
  test('type schemas are ordered, hashed and checked independently of invocation models', () => {
    const type = { id:'fixture.Options.struct', ecosystem:'go', package:'example.test/options', exportedPath:['Options'], shape:'struct',
      reference:'https://example.test/options#Options', checks:{positive:'fixture.Options.positive',negative:'fixture.Options.negative'} };
    const registry = validateLibraryRegistry({schemaVersion:1,models:[],types:[type]});
    expect(registry.types?.map((entry)=>entry.id)).toEqual(['fixture.Options.struct']);
    expect(libraryRegistryDigest(registry)).not.toBe(libraryRegistryDigest({schemaVersion:1,models:[],types:[]}));
    for (const invalid of [
      {...type, shape:'map'}, {...type, ecosystem:'node'}, {...type, exportedPath:[]}, {...type, reference:'file:///tmp/type'},
      {...type, executable:'source'}, {...type, checks:{positive:'same',negative:'same'}},
    ]) expect(()=>validateLibraryRegistry({schemaVersion:1,models:[],types:[invalid]})).toThrow();
    expect(()=>validateLibraryRegistry({schemaVersion:1,models:[],types:[type,type]})).toThrow('duplicate');
    expect(()=>validateLibraryRegistry({schemaVersion:1,models:[],types:[type,{...type,id:'other',checks:{positive:'other.p',negative:'other.n'}}]})).toThrow('duplicate');
  });
});

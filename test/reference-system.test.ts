import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel, type CompiledModel } from '../src/index.js';

/**
 * The invented reference system the views of readable-views draw. The
 * expected values come from its brief (madarch-mk5.2.1), not from the model:
 * a landscape of ten boxes or fewer, domains that all have children, a
 * service with modules, a name on every relation, and every kind of thing a
 * real system has (stores, a broker, topics, REST and gRPC, externals,
 * persons, zones and transfers of personal and card data).
 */
const REFERENCE_SYSTEM = fileURLToPath(new URL('../examples/reference-system', import.meta.url));

function compiled(): CompiledModel {
  const { model, errors, warnings } = loadAndCompileModel(REFERENCE_SYSTEM);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
  expect(model).toBeDefined();
  return model!;
}

describe('the reference system', () => {
  test('loads and compiles with no errors and no warnings', () => {
    const { model, errors, warnings } = loadAndCompileModel(REFERENCE_SYSTEM);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(model).toBeDefined();
  });

  test('its top level has at most ten elements: domains, externals and persons', () => {
    const top = compiled().elements.filter((element) => element.parent === undefined);

    expect(top.length).toBeLessThanOrEqual(10);
    const kinds = new Set(top.map((element) => element.kind));
    expect([...kinds].sort()).toEqual(['domain', 'external', 'person']);
    expect(top.filter((element) => element.kind === 'domain').length).toBeGreaterThanOrEqual(6);
    expect(top.filter((element) => element.kind === 'external').length).toBeGreaterThanOrEqual(3);
  });

  test('every domain has children', () => {
    const model = compiled();
    const parents = new Set(model.elements.map((element) => element.parent));

    const domains = model.elements.filter((element) => element.kind === 'domain');
    expect(domains.length).toBeGreaterThan(0);
    for (const domain of domains) {
      expect({ domain: domain.id, hasChildren: parents.has(domain.id) }).toEqual({ domain: domain.id, hasChildren: true });
    }
  });

  test('at least one service has modules', () => {
    const model = compiled();
    const kindById = new Map(model.elements.map((element) => [element.id, element.kind]));

    const servicesWithModules = new Set(
      model.elements
        .filter((element) => element.kind === 'module' && element.parent !== undefined && kindById.get(element.parent) === 'service')
        .map((element) => element.parent),
    );
    expect(servicesWithModules.size).toBeGreaterThanOrEqual(1);
  });

  test('every relation has a non-empty name', () => {
    const relations = compiled().relations;

    expect(relations.length).toBeGreaterThan(0);
    expect(relations.filter((relation) => relation.name === undefined || relation.name.trim() === '').map((relation) => relation.id)).toEqual([]);
  });

  test('it has a store, a broker, an external and a person', () => {
    const kinds = new Set(compiled().elements.map((element) => element.kind));

    for (const kind of ['store', 'broker', 'external', 'person'] as const) {
      expect({ kind, present: kinds.has(kind) }).toEqual({ kind, present: true });
    }
  });

  test('it has a topic, an http and a grpc interface', () => {
    const contractKinds = new Set(compiled().interfaces.map((iface) => iface.contract.split('::')[0]));

    for (const kind of ['topic', 'http', 'grpc']) {
      expect({ kind, present: contractKinds.has(kind) }).toEqual({ kind, present: true });
    }
  });

  test('it declares the zones internet, dmz, internal and pci and the categories personal, payment-card and order', () => {
    const model = compiled();

    expect(model.zones.map((zone) => zone.id)).toEqual(expect.arrayContaining(['internet', 'dmz', 'internal', 'pci']));
    expect(model.categories.map((category) => category.id)).toEqual(expect.arrayContaining(['personal', 'payment-card', 'order']));
  });

  test('transfers carry personal and payment-card data', () => {
    const categories = new Set(compiled().relations.flatMap((relation) => (relation.transfers ?? []).flatMap((transfer) => transfer.categories)));

    expect(categories.has('personal')).toBe(true);
    expect(categories.has('payment-card')).toBe(true);
  });

  test('it declares the data entities its transfers carry, each with its classification stated', () => {
    const model = compiled();

    const categoriesById = new Map(model.entities.map((entity) => [entity.id, entity.categories]));
    expect([...categoriesById.keys()].sort()).toEqual([
      'card-number',
      'card-token',
      'contact-details',
      'order-contents',
      'order-number',
      'session-id',
      'settlement-report',
      'shipping-address',
      'user-name',
    ]);
    // Each entity states its classification: a list of the model's categories,
    // or an empty list where the author checked and found nothing sensitive.
    expect(categoriesById.get('session-id')).toEqual(['communications-secrecy']);
    expect(categoriesById.get('user-name')).toEqual(['personal']);
    expect(categoriesById.get('settlement-report')).toEqual(['commercial-secret']);
    expect(categoriesById.get('order-number')).toEqual([]);
    for (const entity of model.entities) {
      expect({ entity: entity.id, categories: entity.categories }).toEqual({ entity: entity.id, categories: expect.any(Array) });
    }
  });

  test('every entity is named by at least one transfer', () => {
    const model = compiled();
    const named = new Set(model.relations.flatMap((relation) => (relation.transfers ?? []).flatMap((transfer) => transfer.entities)));

    expect(model.entities.length).toBeGreaterThan(0);
    for (const entity of model.entities) {
      expect({ entity: entity.id, namedByATransfer: named.has(entity.id) }).toEqual({ entity: entity.id, namedByATransfer: true });
    }
  });

  test("a transfer's compiled categories are the union of its own and its entities', each once, sorted by code point", () => {
    const model = compiled();

    const signIn = model.relations.find((relation) => relation.id === 'web-shop-signs-in')!.transfers![0]!
    expect(signIn.entities).toEqual(['session-id', 'user-name']);
    expect(signIn.categories).toEqual(['communications-secrecy', 'personal']);

    const placed = model.relations.find((relation) => relation.id === 'orders-publishes-placed')!.transfers![0]!
    expect(placed.entities).toEqual(['order-contents', 'order-number', 'shipping-address', 'user-name']);
    expect(placed.categories).toEqual(['order', 'personal']);

    const settlements = model.relations.find((relation) => relation.id === 'reconciliation-fetches-settlements')!.transfers![0]!
    expect(settlements.entities).toEqual(['settlement-report']);
    expect(settlements.categories).toEqual(['commercial-secret']);
  });
});

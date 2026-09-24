import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel } from '../src/index.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** The 1-based line of the first line in `relativeYamlPath` matching `predicate`. */
function lineOf(fixtureRoot: string, relativeYamlPath: string, predicate: (line: string) => boolean): number {
  const lines = readFileSync(`${fixtureRoot}/${relativeYamlPath}`, 'utf8').split('\n');
  const index = lines.findIndex(predicate);
  expect(index).toBeGreaterThan(-1);
  return index + 1;
}

describe('loadAndCompileModel', () => {
  test('compiles a model folder with one element', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model?.schemaVersion).toBe(1);
    expect(model?.elements).toEqual([{ id: 'shop', kind: 'domain', name: 'Shop', ancestors: [] }]);
  });

  test('reports an unknown field with its file, line and path', () => {
    const fixtureRoot = fixture('unknown-field');
    const ownerLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('owner:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: ownerLine,
        path: 'elements[0].owner',
      }),
    );
  });

  test('loads normally once the unknown field is removed', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('strict YAML', () => {
  test('refuses a duplicate key, naming the file and line', () => {
    const fixtureRoot = fixture('duplicate-key');
    const secondParentLine = lineOf(
      fixtureRoot,
      'madarch/model.yaml',
      (line) => line.trim() === 'parent: b',
    );

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === secondParentLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('parent');
  });

  test('refuses an anchor and its alias, naming the anchor line', () => {
    const fixtureRoot = fixture('anchor-alias');
    const anchorLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.includes('&shop'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: anchorLine,
      }),
    );
  });

  test('loads normally once the anchor and alias are removed', () => {
    const { model, errors } = loadAndCompileModel(fixture('two-elements'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('schema', () => {
  test('refuses a missing required field, naming the file, line and path', () => {
    const fixtureRoot = fixture('missing-required-field');
    const elementLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('- id: shop'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: elementLine,
        path: 'elements[0]',
      }),
    );
  });

  test('refuses a value of the wrong kind, naming the file, line and path', () => {
    const fixtureRoot = fixture('wrong-kind-of-value');
    const parentLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('parent:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: parentLine,
        path: 'elements[0].parent',
      }),
    );
  });

  test('reports three independent schema errors from two files at once', () => {
    const fixtureRoot = fixture('all-errors');
    const ownerLine = lineOf(fixtureRoot, 'madarch/first.yaml', (line) => line.trim().startsWith('owner:'));
    const checkoutLine = lineOf(fixtureRoot, 'madarch/first.yaml', (line) => line.trim().startsWith('- id: checkout'));
    const parentLine = lineOf(fixtureRoot, 'madarch/second.yaml', (line) => line.trim().startsWith('parent:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/first.yaml', line: ownerLine, path: 'elements[0].owner' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/first.yaml', line: checkoutLine, path: 'elements[1]' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/second.yaml', line: parentLine, path: 'elements[0].parent' }),
    );
  });

  test('loads normally once the schema errors are fixed', () => {
    const { model, errors } = loadAndCompileModel(fixture('two-elements'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('files', () => {
  test('a model split across three files compiles to the same output as one file', () => {
    const oneFile = loadAndCompileModel(fixture('split-model-one-file'));
    const threeFiles = loadAndCompileModel(fixture('split-model-three-files'));

    expect(oneFile.errors).toEqual([]);
    expect(threeFiles.errors).toEqual([]);
    expect(JSON.stringify(threeFiles.model)).toBe(JSON.stringify(oneFile.model));
  });
});

describe('ids', () => {
  test('refuses an id with invalid syntax', () => {
    const fixtureRoot = fixture('invalid-id-syntax');
    const idLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('- id:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: idLine }),
    );
  });

  test('loads normally once the id has valid syntax', () => {
    const { model, errors } = loadAndCompileModel(fixture('two-elements'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });

  test('refuses two elements with the same id, naming both files and lines', () => {
    const fixtureRoot = fixture('duplicate-element-id');
    const lineA = lineOf(fixtureRoot, 'madarch/a.yaml', (line) => line.trim().startsWith('- id:'));
    const lineB = lineOf(fixtureRoot, 'madarch/b.yaml', (line) => line.trim().startsWith('- id:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ file: 'madarch/a.yaml', line: lineA }));
    expect(errors).toContainEqual(expect.objectContaining({ file: 'madarch/b.yaml', line: lineB }));
  });
});

describe('references', () => {
  test('refuses an element whose parent does not exist', () => {
    const fixtureRoot = fixture('unknown-parent');
    const parentLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('parent:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === parentLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('checkout-web');
    expect(error?.message).toContain('billing');
  });

  test('loads normally once the parent exists', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-parent'));

    expect(errors).toEqual([]);
    expect(model?.elements).toEqual([
      { id: 'checkout-web', kind: 'service', name: 'Checkout web', parent: 'shop', ancestors: ['shop'] },
      { id: 'shop', kind: 'domain', name: 'Shop', ancestors: [] },
    ]);
  });
});

describe('nesting', () => {
  test('refuses a cycle of parents, naming the elements in it', () => {
    const fixtureRoot = fixture('parent-cycle');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    const error = errors[0]!;
    expect(error.message).toContain('"a"');
    expect(error.message).toContain('"b"');
  });

  test('loads normally once the cycle is broken', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-parent'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('compiled model', () => {
  test('compiling the same model twice gives byte-identical output', () => {
    const first = loadAndCompileModel(fixture('split-model-one-file'));
    const second = loadAndCompileModel(fixture('split-model-one-file'));

    expect(first.errors).toEqual([]);
    expect(JSON.stringify(first.model)).toBe(JSON.stringify(second.model));
  });
});

describe('nesting', () => {
  test('service-gains-internal-elements: ancestors and the relation ends reflect the current structure', () => {
    const before = loadAndCompileModel(fixture('nesting-before'));
    const after = loadAndCompileModel(fixture('nesting-after'));

    expect(before.errors).toEqual([]);
    expect(after.errors).toEqual([]);

    const beforeCheckoutWeb = before.model?.elements.find((e) => e.id === 'checkout-web');
    expect(beforeCheckoutWeb?.ancestors).toEqual(['shop']);
    const beforeRelation = before.model?.relations.find((r) => r.id === 'checkout-uses-payments');
    expect(beforeRelation).toMatchObject({ from: 'checkout-web', to: 'payments-api' });

    const afterCheckoutCart = after.model?.elements.find((e) => e.id === 'checkout-cart');
    expect(afterCheckoutCart?.ancestors).toEqual(['shop', 'checkout-web']);
    const afterRelation = after.model?.relations.find((r) => r.id === 'checkout-uses-payments');
    expect(afterRelation).toMatchObject({ from: 'checkout-cart', to: 'payments-api' });
  });
});

describe('moves', () => {
  test('service-moves-domain: moving an element keeps its id, interfaces and relations; only its ancestors differ', () => {
    const before = loadAndCompileModel(fixture('moves-before'));
    const after = loadAndCompileModel(fixture('moves-after'));

    expect(before.errors).toEqual([]);
    expect(after.errors).toEqual([]);

    const beforeElement = before.model?.elements.find((e) => e.id === 'payments-api');
    const afterElement = after.model?.elements.find((e) => e.id === 'payments-api');
    expect(beforeElement?.ancestors).toEqual(['payments']);
    expect(afterElement?.ancestors).toEqual(['finance']);
    expect({ ...beforeElement, ancestors: undefined, parent: undefined }).toEqual({
      ...afterElement,
      ancestors: undefined,
      parent: undefined,
    });

    expect(after.model?.interfaces).toEqual(before.model?.interfaces);
    expect(after.model?.relations).toEqual(before.model?.relations);
  });
});

describe('relations', () => {
  test('refuses a refinement whose end is outside the refined relation, naming the relation and the end', () => {
    const fixtureRoot = fixture('refinement-outside-ends');
    const toLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === 'to: orders-api');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === toLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('checkout-charges-card');
    expect(error?.message).toContain('orders-api');
  });

  test('loads normally when a refinement stays inside the refined relation\'s ends', () => {
    const { model, errors } = loadAndCompileModel(fixture('refinement-valid'));

    expect(errors).toEqual([]);
    const refined = model?.relations.find((r) => r.id === 'checkout-charges-card');
    expect(refined).toMatchObject({ from: 'checkout-cart', to: 'payments-api', refines: 'checkout-uses-payments' });
  });

  test('refuses a cycle of refinements, naming the relations in it', () => {
    const { model, errors } = loadAndCompileModel(fixture('refinement-cycle'));

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    const error = errors[0]!;
    expect(error.message).toContain('"relation-a"');
    expect(error.message).toContain('"relation-b"');
  });

  test('a relation with an interface or transfers is compiled as an interaction', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-relation-full'));

    expect(errors).toEqual([]);
    const general = model?.relations.find((r) => r.id === 'checkout-uses-payments');
    const refined = model?.relations.find((r) => r.id === 'checkout-charges-card');
    expect(general?.interaction).toBe(false);
    expect(refined?.interaction).toBe(true);
  });
});

describe('references (relations, interfaces, categories)', () => {
  test('refuses a relation whose "from" does not exist', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-relation-from'));
    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('checkout-web'))).toBe(true);
  });

  test('refuses a relation whose "to" does not exist', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-relation-to'));
    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('payments-api'))).toBe(true);
  });

  test('refuses a relation whose "refines" does not exist', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-relation-refines'));
    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('checkout-uses-payments'))).toBe(true);
  });

  test('refuses a relation whose "interface" does not exist', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-relation-interface'));
    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('payments-charge'))).toBe(true);
  });

  test('refuses an interface whose provider does not exist', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-interface-provider'));
    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('payments-api'))).toBe(true);
  });

  test('loads normally when the interface provider exists', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-interface'));
    expect(errors).toEqual([]);
    expect(model?.interfaces).toEqual([{ id: 'payments-charge', provider: 'payments-api', contract: 'http::POST::/api/charges' }]);
  });

  test('loads normally when every reference in a full relation resolves', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-relation-full'));
    expect(errors).toEqual([]);
    expect(model?.relations.length).toBe(2);
  });
});

describe('transfers', () => {
  test('refuses a data transfer naming a category that does not exist', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-category-in-transfer'));
    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('payment-card'))).toBe(true);
  });

  test('two-directions: a forward transfer and a reverse transfer are kept separate', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-relation-full'));

    expect(errors).toEqual([]);
    const relation = model?.relations.find((r) => r.id === 'checkout-charges-card');
    expect(relation?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: ['payment-card', 'personal'] },
      { direction: 'reverse', confidentiality: 'internal', categories: [] },
    ]);
  });
});

describe('contracts', () => {
  test('normalizes the HTTP method to upper case and a path parameter to {}', () => {
    const { model, errors } = loadAndCompileModel(fixture('contract-path-parameters'));

    expect(errors).toEqual([]);
    const iface = model?.interfaces.find((i) => i.id === 'orders-get');
    expect(iface?.contract).toBe('http::GET::/api/orders/{}');
  });

  test('refuses a contract id that does not parse, naming it', () => {
    const { model, errors } = loadAndCompileModel(fixture('invalid-contract'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('soap::orders'))).toBe(true);
  });
});

describe('evidence', () => {
  test('the compiled model keeps evidence as given, for elements, interfaces and relations', () => {
    const { model, errors } = loadAndCompileModel(fixture('evidence-kept'));

    expect(errors).toEqual([]);
    const element = model?.elements.find((e) => e.id === 'checkout-cart');
    expect(element?.evidence).toEqual([{ file: 'services/checkout/src/cart/index.ts', line: 1 }]);
    const iface = model?.interfaces.find((i) => i.id === 'checkout-list');
    expect(iface?.evidence).toEqual([{ file: 'services/checkout/src/cart/api.ts' }]);
    const relation = model?.relations.find((r) => r.id === 'checkout-web-uses-cart');
    expect(relation?.evidence).toEqual([{ file: 'services/checkout/README.md', line: 5 }]);
  });
});

describe('compiled-model shape', () => {
  test('holds every element, interface, relation and category of the reference example', () => {
    const { model, errors } = loadAndCompileModel(fixture('shape-example'));

    expect(errors).toEqual([]);
    expect(model?.schemaVersion).toBe(1);
    expect(model?.elements.map((e) => e.id).sort()).toEqual(
      ['checkout-cart', 'checkout-web', 'payments', 'payments-api', 'shop'].sort(),
    );
    expect(model?.interfaces).toEqual([
      { id: 'payments-charge', provider: 'payments-api', contract: 'http::POST::/api/charges' },
    ]);
    expect(model?.categories).toEqual([
      { id: 'payment-card' },
      { id: 'personal' },
    ]);

    const refined = model?.relations.find((r) => r.id === 'checkout-charges-card');
    expect(refined).toMatchObject({
      from: 'checkout-cart',
      to: 'payments-api',
      refines: 'checkout-uses-payments',
      interface: 'payments-charge',
      interaction: true,
      binding: { env: 'PAYMENTS_URL' },
    });
    expect(refined?.transfers).toEqual([
      { direction: 'forward', confidentiality: 'confidential', categories: ['payment-card', 'personal'] },
      { direction: 'reverse', confidentiality: 'internal', categories: [] },
    ]);
  });

  test('a model split across files compiles to the same output as one file (categories, interfaces and relations too)', () => {
    const oneFile = loadAndCompileModel(fixture('shape-example'));
    const threeFiles = loadAndCompileModel(fixture('shape-example-split'));

    expect(oneFile.errors).toEqual([]);
    expect(threeFiles.errors).toEqual([]);
    expect(JSON.stringify(threeFiles.model)).toBe(JSON.stringify(oneFile.model));
  });

  test('compiling the same model twice gives byte-identical output', () => {
    const first = loadAndCompileModel(fixture('shape-example'));
    const second = loadAndCompileModel(fixture('shape-example'));

    expect(first.errors).toEqual([]);
    expect(JSON.stringify(first.model)).toBe(JSON.stringify(second.model));
  });
});

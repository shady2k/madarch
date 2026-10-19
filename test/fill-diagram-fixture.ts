/**
 * The diagram models' fixture (madarch-tzte.23.2): one product's graph, made with
 * the schema's own constructors, that the pure suite and the fact store's suite
 * both draw diagrams from. It asserts nothing: each test names the facts it
 * expects to see, and the two suites judge the same graph through two readers —
 * the in-memory one below (`readsOf`) and the landed store
 * (`factStoreDiagramReads`).
 *
 * The graph is one product of two repositories. `acme-shop` holds 0026's own
 * case — two modules with one import between them — beside what the other views
 * are made of: two packages with a dependency, two tables with their columns and
 * a column whose table no fact holds, one state machine with a transition into a
 * state no unit holds, and two symbols an agent proposed an interaction between.
 * `acme-web` holds three top-level modules and two clusters below one of them (a
 * view past its budget, and the depth a module view may ask for) and one import
 * into the shop, which is the relation a context view rolls up to the two
 * repositories.
 */
import type { DiagramGraphReads } from '../src/fill/diagrams.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactEdgeKind, type FactProvenance } from '../src/fill/facts.js';
import { endsOf } from '../src/fill/graph-reads.js';

const SHOP = 'acme-shop';
const WEB = 'acme-web';
const COMMIT = 'a'.repeat(40);
const CART = 'src/cart.ts';
const PAY = 'src/pay.ts';
const ORPHAN = 'src/orphan.ts';
const GONE = 'src/gone.ts';
const MARKETING = 'src/marketing.ts';
const WEB_APP_FILE = 'src/app.ts';
const WEB_API_FILE = 'src/api.ts';
const WEB_SHARED_FILE = 'src/shared.ts';
const WEB_ROUTES_FILE = 'src/routes.ts';
const WEB_HANDLERS_FILE = 'src/handlers.ts';

/** One provenance: a fact read out of a file of a repository at the pinned commit, at its line. */
export function provenance(repository: string, file: string, line = 1): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: repository, commit: COMMIT },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/** One provenance for a fact no line of a file carries the identity of: a repository, a package, an agent's state. */
function at(repository: string, file: string): FactProvenance {
  return provenance(repository, file);
}

/** One fact the schema builds: the constructors refuse anything the schema does not read, so every fixture fact is one. */
function node(kind: Parameters<typeof makeNodeFact>[0]['kind'], value: Record<string, unknown>, place: FactProvenance, layer: 'extracted' | 'inferred' = 'extracted'): Fact {
  return makeNodeFact({ kind, value, provenance: place, layer } as unknown as Parameters<typeof makeNodeFact>[0]) as Fact;
}

/** One edge the schema builds, from the same constructors a stage writes through. */
function edge(kind: FactEdgeKind, value: Record<string, unknown>, place: FactProvenance, layer: 'extracted' | 'inferred' = 'extracted'): Fact {
  return makeEdgeFact({ kind, value, provenance: place, layer } as unknown as Parameters<typeof makeEdgeFact>[0]) as Fact;
}


/** The graph this product holds, each fact named so a test names the same one the fixture wrote. */
export function diagramFixture() {
  const shop = node('repository', { repository: SHOP, form: 'code' }, at(SHOP, 'README.md'));
  // A repository's place is optional (the schema names it so): acme-web's fact cites none, which is the case an
  // element's "where it has one" code place exists for.
  const web = node('repository', { repository: WEB, form: 'code' }, { source: { system: 'tree-sitter', version: '1.0.0' }, repository: { id: WEB, commit: COMMIT } });
  const cart = node('file', { repository: SHOP, path: repositoryPath(CART), roles: ['source'], language: 'typescript' }, provenance(SHOP, CART, 10));
  const pay = node('file', { repository: SHOP, path: repositoryPath(PAY), roles: ['source'], language: 'typescript' }, provenance(SHOP, PAY, 20));
  const orphan = node('file', { repository: SHOP, path: repositoryPath(ORPHAN), roles: ['source'], language: 'typescript' }, provenance(SHOP, ORPHAN, 30));
  // The file an import names that no unit holds any more: the end a diagram must draw as unresolved.
  const gone = node('file', { repository: SHOP, path: repositoryPath(GONE), roles: ['source'], language: 'typescript' }, provenance(SHOP, GONE, 40));
  const marketing = node('file', { repository: WEB, path: repositoryPath(MARKETING), roles: ['source'], language: 'typescript' }, provenance(WEB, MARKETING, 5));
  const webAppFile = node('file', { repository: WEB, path: repositoryPath(WEB_APP_FILE), roles: ['source'], language: 'typescript' }, provenance(WEB, WEB_APP_FILE, 6));
  const webApiFile = node('file', { repository: WEB, path: repositoryPath(WEB_API_FILE), roles: ['source'], language: 'typescript' }, provenance(WEB, WEB_API_FILE, 7));
  const webSharedFile = node('file', { repository: WEB, path: repositoryPath(WEB_SHARED_FILE), roles: ['source'], language: 'typescript' }, provenance(WEB, WEB_SHARED_FILE, 8));
  const webRoutesFile = node('file', { repository: WEB, path: repositoryPath(WEB_ROUTES_FILE), roles: ['source'], language: 'typescript' }, provenance(WEB, WEB_ROUTES_FILE, 9));
  const webHandlersFile = node('file', { repository: WEB, path: repositoryPath(WEB_HANDLERS_FILE), roles: ['source'], language: 'typescript' }, provenance(WEB, WEB_HANDLERS_FILE, 10));
  // The modules stage 5 clusters: two top-level modules of the shop (the fixture 0026's own case names), three of the web.
  const checkout = node('module', { repository: SHOP, name: 'checkout', seed: 'package', members: 2, importance: 0.5 }, at(SHOP, CART));
  const payment = node('module', { repository: SHOP, name: 'payment', seed: 'package', members: 1, importance: 0.3 }, at(SHOP, PAY));
  const webApp = node('module', { repository: WEB, name: 'web-app', seed: 'package', members: 1 }, at(WEB, WEB_APP_FILE));
  const webApi = node('module', { repository: WEB, name: 'web-api', seed: 'package', members: 1 }, at(WEB, WEB_API_FILE));
  const webShared = node('module', { repository: WEB, name: 'web-shared', seed: 'package', members: 1 }, at(WEB, WEB_SHARED_FILE));
  // Two clusters below one top-level cluster (stage 5 nests them, `ModuleValue.parent`): the depth a module view may ask
  // for, and the level a collapsed view folds into when the level above is a module and not a repository.
  const webApiRoutes = node('module', { repository: WEB, name: 'web-api-routes', parent: webApi.id, seed: 'cluster', members: 1 }, at(WEB, WEB_ROUTES_FILE));
  const webApiHandlers = node('module', { repository: WEB, name: 'web-api-handlers', parent: webApi.id, seed: 'cluster', members: 1 }, at(WEB, WEB_HANDLERS_FILE));
  const contains = (from: Fact, to: Fact, place: FactProvenance): Fact => edge('contains', { from: from.id, to: to.id }, place);
  const containsEdges = [
    contains(shop, checkout, at(SHOP, CART)),
    contains(shop, payment, at(SHOP, PAY)),
    contains(checkout, cart, provenance(SHOP, CART)),
    contains(checkout, orphan, provenance(SHOP, ORPHAN)),
    contains(payment, pay, provenance(SHOP, PAY)),
    contains(web, webApp, at(WEB, WEB_APP_FILE)),
    contains(web, webApi, at(WEB, WEB_API_FILE)),
    contains(web, webShared, at(WEB, WEB_SHARED_FILE)),
    contains(webApp, webAppFile, provenance(WEB, WEB_APP_FILE)),
    contains(webApi, webApiFile, provenance(WEB, WEB_API_FILE)),
    contains(webShared, webSharedFile, provenance(WEB, WEB_SHARED_FILE)),
    contains(webApi, webApiRoutes, provenance(WEB, WEB_ROUTES_FILE)),
    contains(webApi, webApiHandlers, provenance(WEB, WEB_HANDLERS_FILE)),
    contains(webApi, webRoutesFile, provenance(WEB, WEB_ROUTES_FILE)),
    contains(webApi, webHandlersFile, provenance(WEB, WEB_HANDLERS_FILE)),
    contains(webApiRoutes, webRoutesFile, provenance(WEB, WEB_ROUTES_FILE)),
    contains(webApiHandlers, webHandlersFile, provenance(WEB, WEB_HANDLERS_FILE)),
    contains(web, marketing, provenance(WEB, MARKETING)),
  ];
  // The one import inside the shop: checkout's cart imports payment's pay — 0026's two modules with one dependency.
  const cartImportsPay = edge('import', { from: cart.id, to: pay.id, specifier: '../pay.js' }, provenance(SHOP, CART, 3));
  const orphanImportsGone = edge('import', { from: orphan.id, to: gone.id, specifier: './gone.js' }, provenance(SHOP, ORPHAN, 2));
  // A relation the web carries to the shop: an import across the two repositories, which a context view rolls up to them.
  const marketingImportsCart = edge('import', { from: marketing.id, to: cart.id, specifier: '../../shop/src/cart.js' }, provenance(WEB, MARKETING, 1));
  const packages = [
    node('package', { repository: SHOP, name: '@acme/checkout', form: 'package', ecosystem: 'npm', manifest: repositoryPath('package.json') }, provenance(SHOP, 'package.json', 5)),
    node('package', { repository: SHOP, name: '@acme/payments', form: 'package', ecosystem: 'npm', manifest: repositoryPath('package.json') }, provenance(SHOP, 'package.json', 9)),
  ] as const;
  const [checkoutPackage, paymentsPackage] = packages;
  const packageDependency = edge('dependency', { from: checkoutPackage.id, to: paymentsPackage.id, basis: 'manifest' }, provenance(SHOP, 'package.json', 6));
  const tables = [
    node('table', { repository: SHOP, name: 'public.orders', engine: 'postgres' }, provenance(SHOP, 'migrations/001.sql', 3)),
    node('table', { repository: SHOP, name: 'public.payments', engine: 'postgres' }, provenance(SHOP, 'migrations/002.sql', 3)),
  ] as const;
  const [ordersTable, paymentsTable] = tables;
  const columns = [
    node('column', { repository: SHOP, table: 'public.orders', name: 'id', dataType: 'bigint' }, provenance(SHOP, 'migrations/001.sql', 4)),
    node('column', { repository: SHOP, table: 'public.orders', name: 'total', dataType: 'numeric' }, provenance(SHOP, 'migrations/001.sql', 5)),
    node('column', { repository: SHOP, table: 'public.payments', name: 'id', dataType: 'bigint' }, provenance(SHOP, 'migrations/002.sql', 4)),
    // A column whose table the graph does not hold: the ER view's unresolved table.
    node('column', { repository: SHOP, table: 'public.audit', name: 'id', dataType: 'bigint' }, provenance(SHOP, 'migrations/003.sql', 4)),
  ] as const;
  // Agent facts (0005: inferred, and so drawn dashed): the states of one machine and what moves between them.
  const states = [
    node('state', { repository: SHOP, machine: 'OrderStatus', name: 'new', initial: true }, at(SHOP, CART), 'inferred'),
    node('state', { repository: SHOP, machine: 'OrderStatus', name: 'paid' }, at(SHOP, CART), 'inferred'),
    node('state', { repository: SHOP, machine: 'OrderStatus', name: 'shipped' }, at(SHOP, CART), 'inferred'),
  ] as const;
  const [newState, paidState, shippedState] = states;
  // A state the transitions name and no unit holds: the state view's unresolved end.
  const refundedState = node('state', { repository: SHOP, machine: 'OrderStatus', name: 'refunded' }, at(SHOP, CART), 'inferred');
  const transitions = [
    edge('transition', { from: newState.id, to: paidState.id, event: 'pay' }, provenance(SHOP, CART, 12), 'inferred'),
    edge('transition', { from: paidState.id, to: shippedState.id, event: 'ship' }, provenance(SHOP, CART, 14), 'inferred'),
    edge('transition', { from: paidState.id, to: refundedState.id, event: 'refund' }, provenance(SHOP, CART, 16), 'inferred'),
  ] as const;
  const [payTransition, shipTransition, refundTransition] = transitions;
  // Two ways into the code a sequence walks, and the interactions between them.
  const placeSymbol = node('symbol', { repository: SHOP, file: repositoryPath(CART), qualifiedName: 'CheckoutController.place', symbolKind: 'method' }, provenance(SHOP, CART, 40));
  const chargeSymbol = node('symbol', { repository: SHOP, file: repositoryPath(PAY), qualifiedName: 'PaymentGateway.charge', symbolKind: 'method' }, provenance(SHOP, PAY, 12));
  const placeCalls = edge('interaction', { caller: placeSymbol.id, callee: chargeSymbol.id, form: 'http', via: 'POST /payments' }, provenance(SHOP, CART, 44), 'inferred');
  const settled = edge('interaction', { caller: chargeSymbol.id, callee: placeSymbol.id, form: 'event', via: 'payment-settled' }, provenance(SHOP, PAY, 20), 'inferred');
  // The modules hold their symbols as well as their files: a component view rolls an interaction up through them.
  const containsSymbols = [
    contains(checkout, placeSymbol, provenance(SHOP, CART, 40)),
    contains(payment, chargeSymbol, provenance(SHOP, PAY, 12)),
  ];
  return {
    shop, web, cart, pay, orphan, gone, marketing, webAppFile, webApiFile, webSharedFile, webRoutesFile, webHandlersFile,
    checkout, payment, webApp, webApi, webShared, webApiRoutes, webApiHandlers,
    cartImportsPay, orphanImportsGone, marketingImportsCart, packageDependency,
    checkoutPackage, paymentsPackage, ordersTable, paymentsTable, columns,
    newState, paidState, shippedState, refundedState, payTransition, shipTransition, refundTransition,
    placeSymbol, chargeSymbol, placeCalls, settled,
    facts: [
      shop, web, cart, pay, orphan, marketing, webAppFile, webApiFile, webSharedFile, webRoutesFile, webHandlersFile,
      checkout, payment, webApp, webApi, webShared, webApiRoutes, webApiHandlers,
      ...containsEdges, ...containsSymbols,
      cartImportsPay, orphanImportsGone, marketingImportsCart, packageDependency,
      checkoutPackage, paymentsPackage, ordersTable, paymentsTable, ...columns,
      ...states, payTransition, shipTransition, refundTransition,
      placeSymbol, chargeSymbol, placeCalls, settled,
    ],
  };
}


/** The graph as a diagram reads it, over the facts a test made: the same five questions the store answers, in memory. */
export function readsOf(facts: readonly Fact[]): DiagramGraphReads {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const valueOf = (fact: Fact): Record<string, unknown> => {
    const value = fact.value;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as unknown as Record<string, unknown> : {};
  };
  const byIdOrder = (held: readonly Fact[]): readonly Fact[] => [...held].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const endsOfFact = (fact: Fact): { from?: string; to?: string } => endsOf(fact.kind as FactEdgeKind, fact.value);
  const inRepository = (id: string | undefined, repositories: ReadonlySet<string>): boolean => {
    if (id === undefined) return false;
    const fact = byId.get(id);
    return fact !== undefined && repositories.has(String(valueOf(fact)['repository']));
  };
  return {
    facts: async (ids) => {
      const found = new Map<string, Fact>();
      for (const id of ids) {
        const fact = byId.get(id);
        if (fact !== undefined) found.set(id, fact);
      }
      return found;
    },
    kind: async (kind) => byIdOrder(facts.filter((fact) => fact.kind === kind)),
    factsWith: async (kind, field, value) => byIdOrder(facts.filter((fact) => fact.kind === kind && valueOf(fact)[field] === value)),
    edges: async (ids, kinds) => {
      const wanted = new Set(ids);
      return byIdOrder(facts.filter((fact) => {
        if ((kinds as readonly string[]).includes(fact.kind) === false) return false;
        const ends = endsOfFact(fact);
        return (ends.from !== undefined && wanted.has(ends.from)) || (ends.to !== undefined && wanted.has(ends.to));
      }));
    },
    edgesIn: async (repositories, kinds) => {
      const names = new Set(repositories);
      // The store left-joins both ends and answers an edge one of whose ends stands in the scope; an end no unit holds
      // is answered by the other end's side, which is what makes an unresolved end drawable.
      return byIdOrder(facts.filter((fact) => {
        if ((kinds as readonly string[]).includes(fact.kind) === false) return false;
        const ends = endsOfFact(fact);
        return inRepository(ends.from, names) || inRepository(ends.to, names);
      }));
    },
    ancestors: async (ids) => {
      const chains = new Map<string, { id: string; kind: string }[]>();
      for (const id of ids) {
        const chain: { id: string; kind: string }[] = [];
        const seen = new Set<string>([id]);
        let level = [id];
        for (let step = 0; step < 32 && level.length > 0; step += 1) {
          const parents: string[] = [];
          for (const current of level) {
            for (const fact of facts) {
              if (fact.kind !== 'contains') continue;
              if (String(valueOf(fact)['to']) !== current) continue;
              parents.push(String(valueOf(fact)['from']));
            }
          }
          const fresh = [...new Set(parents)].filter((each) => seen.has(each) === false).sort();
          for (const parent of fresh) {
            seen.add(parent);
            chain.push({ id: parent, kind: byId.get(parent)?.kind ?? 'repository' });
          }
          level = fresh;
        }
        const own = byId.get(id);
        const repository = own === undefined ? undefined : valueOf(own)['repository'];
        if (typeof repository === 'string') {
          const fact = facts.find((each) => each.kind === 'repository' && valueOf(each)['repository'] === repository);
          if (fact !== undefined && fact.id !== id && seen.has(fact.id) === false) chain.push({ id: fact.id, kind: 'repository' });
        }
        chains.set(id, chain);
      }
      return chains as ReadonlyMap<string, readonly { readonly id: string; readonly kind: string }[]> as never;
    },
  };
}

/** The fixture's graph, made once: the schema's ids are content-addressed, so every test names the same facts. */
export const DIAGRAM_FIXTURE = diagramFixture();

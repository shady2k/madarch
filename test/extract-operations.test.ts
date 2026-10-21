/**
 * The operations extractor (src/extract/operations) against the training
 * repository's answer key. Every case carries the key item's id in its name
 * and takes its expected values from the key: the item's locations and
 * anchors, its statements' facts and the top-level plantedCounts. The
 * repository is generated once per run into a temporary folder
 * (examples/training-repository/generate.mjs) and read through a TreeReader,
 * as the extractor will read a commit's tree.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { extractOperations } from '../src/extract/operations/index.js';
import type { Extraction, ExtractedEdge, ExtractedNode, SourceSpan, TreeReader } from '../src/extract/records.js';
import { byCodePoint } from '../src/model/order.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = path.join(ROOT, 'examples/training-repository/generate.mjs');

interface KeyLocation { readonly path: string; readonly symbol?: string; readonly anchor?: string }
interface KeyCheck { readonly path: string; readonly notContains?: string }
interface KeyItem {
  readonly id: string;
  readonly evidenceClass: string;
  readonly location?: KeyLocation;
  readonly locations?: readonly KeyLocation[];
  readonly checks?: readonly KeyCheck[];
  readonly expectedWikiStatement: string;
}
interface PlantedServiceCounts { readonly direct: number; readonly dev: number; readonly packages: number; readonly devOnlyPackages: number }
const key = JSON.parse(readFileSync(path.join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as {
  items: KeyItem[];
  plantedCounts: { dependencies: Record<string, PlantedServiceCounts> };
};
const items = new Map(key.items.map((entry) => [entry.id, entry]));

function item(id: string): KeyItem {
  const found = items.get(id);
  if (found === undefined) throw new Error(`the answer key holds no item ${id}`);
  return found;
}

function locationsOf(entry: KeyItem): readonly KeyLocation[] {
  return entry.locations ?? (entry.location === undefined ? [] : [entry.location]);
}

/** The decoded text of one tree, cached. */
function textOfOf(tree: TreeReader): (path: string) => string {
  const decoder = new TextDecoder();
  const texts = new Map<string, string>();
  return (p: string): string => {
    const held = texts.get(p);
    if (held !== undefined) return held;
    const read = decoder.decode(tree.read(p));
    texts.set(p, read);
    return read;
  };
}

/** A TreeReader over a generated folder: paths in code point order, bytes on demand. */
function readTree(folder: string): TreeReader {
  const paths: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort(byCodePoint)) {
      if (entry === '.git') continue;
      const absolute = path.join(dir, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      if (statSync(absolute).isDirectory()) walk(absolute, relative);
      else paths.push(relative);
    }
  };
  walk(folder, '');
  paths.sort(byCodePoint);
  const bytes = new Map<string, Uint8Array>();
  return {
    paths,
    read(p: string): Uint8Array {
      const held = bytes.get(p);
      if (held !== undefined) return held;
      const read = new Uint8Array(readFileSync(path.join(folder, p)));
      bytes.set(p, read);
      return read;
    },
  };
}

let tree: TreeReader;
let extraction: Extraction;
let nodes: Map<string, ExtractedNode>;
let spanText: (span: SourceSpan) => string;
let textOf: (path: string) => string;
let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'madarch-extract-operations-'));
  const repo = path.join(workspace, 'repo');
  execFileSync('node', [GENERATOR, repo], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  tree = readTree(repo);
  spanText = (span: SourceSpan) => new TextDecoder().decode(tree.read(span.path).subarray(span.byteStart, span.byteEnd));
  textOf = textOfOf(tree);
  extraction = extractOperations(tree);
  nodes = new Map(extraction.nodes.map((entry) => [entry.key, entry]));
}, 120_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function node(key: string): ExtractedNode {
  const found = nodes.get(key);
  if (found === undefined) {
    const near = [...nodes.keys()].filter((k) => k.includes(key.split(':').pop() ?? '\u0000')).slice(0, 10);
    throw new Error(`the extraction holds no record ${key}; near misses: ${near.join(', ')}`);
  }
  return found;
}

function maybeNode(key: string): ExtractedNode | undefined {
  return nodes.get(key);
}

function nodesOfKind(kind: string): ExtractedNode[] {
  return extraction.nodes.filter((entry) => entry.kind === kind);
}

function edgesOf(type: string): ExtractedEdge[] {
  return extraction.edges.filter((entry) => entry.type === type);
}

function edgesFrom(type: string, from: string): ExtractedEdge[] {
  return edgesOf(type).filter((entry) => entry.from === from);
}

/** Every location of the item is covered: some record's span at the path holds the anchor. */
function assertAnchored(id: string): void {
  for (const loc of locationsOf(item(id))) {
    const needle = loc.anchor ?? loc.symbol;
    if (needle === undefined) throw new Error(`${id}: a location names neither an anchor nor a symbol`);
    const covered = [...extraction.nodes, ...extraction.edges].some((record) =>
      record.span !== undefined && record.span.path === loc.path && spanText(record.span).includes(needle),
    );
    expect(covered, `${id}: no record's span at ${loc.path} covers ${JSON.stringify(needle)}`).toBe(true);
  }
}

describe('extract operations', () => {
  test('the extraction is deterministic over one tree', () => {
    expect(extractOperations(tree)).toEqual(extraction);
  });

  test('every edge ends at nodes the extraction holds, and keys carry no run', () => {
    const held = new Set(extraction.nodes.map((entry) => entry.key));
    for (const edge of extraction.edges) {
      expect(held.has(edge.from), `${edge.type} leaves ${edge.from}`).toBe(true);
      expect(held.has(edge.to), `${edge.type} reaches ${edge.to}`).toBe(true);
    }
    for (const entry of extraction.nodes) {
      expect(entry.kind.startsWith('code.')).toBe(true);
      expect(entry.key.startsWith(`${entry.kind}:`)).toBe(true);
      expect(entry.key.includes(' '), entry.key).toBe(false);
    }
    for (const edge of extraction.edges) expect(edge.type.startsWith('code.')).toBe(true);
  });

  test('records sit in code point order and the fixture leaves no gap', () => {
    const nodeKeys = extraction.nodes.map((entry) => entry.key);
    expect(nodeKeys).toEqual([...nodeKeys].sort(byCodePoint));
    const edgeKeys = extraction.edges.map((entry) => [entry.type, entry.from, entry.to, entry.discriminator].join('\u0000'));
    expect(edgeKeys).toEqual([...edgeKeys].sort(byCodePoint));
    expect(extraction.gaps, JSON.stringify(extraction.gaps)).toEqual([]);
    expect(extraction.producer).toBe('code.extract.operations');
  });

  // ---- stack.passport -----------------------------------------------------

  test('stack.passport', () => {
    assertAnchored('stack.passport');
    const expected = {
      orders: { language: 'go', infrastructure: ['Kafka', 'Postgres'], testFramework: 'go test' },
      promotions: { language: 'go', infrastructure: ['Postgres'], testFramework: null },
      payments: { language: 'typescript', infrastructure: ['Kafka', 'Postgres'], testFramework: 'jest' },
      checkout: { language: 'typescript', infrastructure: [], testFramework: 'jest' },
    };
    for (const [service, wanted] of Object.entries(expected)) {
      const passport = node(`code.service:${service}`);
      expect(passport.properties.language).toBe(wanted.language);
      expect(passport.properties.infrastructure).toEqual(wanted.infrastructure);
      expect(passport.properties.testFramework).toBe(wanted.testFramework);
    }
    expect(node('code.service:orders').properties.frameworks).toEqual(expect.arrayContaining([
      'net/http', 'database/sql', 'github.com/lib/pq', 'github.com/segmentio/kafka-go', 'github.com/golang-jwt/jwt/v5',
    ]));
    expect(node('code.service:promotions').properties.frameworks).toEqual(expect.arrayContaining(['net/http', 'github.com/lib/pq']));
    expect(node('code.service:payments').properties.frameworks).toEqual(expect.arrayContaining([
      'express', '@prisma/client', 'kafkajs', 'jsonwebtoken', '@grpc/grpc-js', 'pino',
    ]));
    expect(node('code.service:checkout').properties.frameworks).toEqual(expect.arrayContaining(['express', '@grpc/grpc-js', 'pino']));
    // each service is declared by its own manifest (the key's mustLink)
    for (const manifest of ['services/orders/go.mod', 'services/promotions/go.mod', 'services/payments/package.json', 'services/checkout/package.json']) {
      const service = manifest.split('/')[1];
      expect(edgesFrom('code.manifest-of', `code.manifest:${manifest}`).map((e) => e.to)).toEqual([`code.service:${service}`]);
    }
  });

  // ---- newcomer -----------------------------------------------------------

  test('newcomer.prerequisites', () => {
    assertAnchored('newcomer.prerequisites');
    const prerequisites = node('code.newcomer-prerequisites:README.md');
    expect(prerequisites.properties.tools).toEqual(['Docker Compose', 'Go 1.22', 'Node 20', 'psql']);
  });

  test('newcomer.folder-command', () => {
    assertAnchored('newcomer.folder-command');
    const up = node('code.make-target:Makefile#up');
    expect(up.properties.recipe).toEqual(['docker compose up --build -d']);
    const step = [...nodesOfKind('code.newcomer-command')].find((entry) => entry.properties.command === 'make up');
    expect(step, 'no newcomer command reads make up').toBeDefined();
    expect(step!.properties.folder).toBe('.');
    expect(edgesFrom('code.backed-by', step!.key).map((entry) => entry.to)).toEqual(['code.make-target:Makefile#up']);
    const copy = [...nodesOfKind('code.newcomer-command')].find((entry) => entry.properties.command === 'cp .env.example .env');
    expect(copy, 'no newcomer command copies .env.example').toBeDefined();
  });

  test('newcomer.seed', () => {
    assertAnchored('newcomer.seed');
    const seed = node('code.make-target:Makefile#seed');
    const files = edgesFrom('code.references', seed.key).map((entry) => entry.to).sort(byCodePoint);
    expect(files).toEqual(['code.file:scripts/seed-orders.sql', 'code.file:scripts/seed-promotions.sql']);
    const step = [...nodesOfKind('code.newcomer-command')].find((entry) => entry.properties.command === 'make seed');
    expect(step).toBeDefined();
  });

  test('newcomer.request', () => {
    assertAnchored('newcomer.request');
    const step = [...nodesOfKind('code.newcomer-command')].find((entry) => String(entry.properties.command).startsWith('curl'));
    expect(step, 'no newcomer command places the first request').toBeDefined();
    expect(String(step!.properties.command)).toContain('POST http://localhost:8080/orders');
    expect(String(step!.properties.command)).toContain('items');
    const token = node('code.make-target:Makefile#token');
    expect(edgesFrom('code.references', token.key).map((entry) => entry.to)).toEqual(['code.file:scripts/token.mjs']);
    expect(edgesFrom('code.backed-by', step!.key).map((entry) => entry.to)).toEqual(['code.make-target:Makefile#token']);
  });

  test('newcomer.tests', () => {
    assertAnchored('newcomer.tests');
    const test = node('code.make-target:Makefile#test');
    expect(test.properties.recipe).toEqual([
      'cd services/orders && go test ./...',
      'cd services/promotions && go vet ./...',
      'cd services/payments && npm test',
      'cd services/checkout && npm test',
    ]);
    const install = node('code.make-target:Makefile#install');
    expect(String(install.properties.recipe)).toContain('npx prisma generate');
    const commands = nodesOfKind('code.newcomer-command').map((entry) => entry.properties.command);
    expect(commands).toEqual(expect.arrayContaining(['make install', 'make test']));
  });

  test('newcomer.failure', () => {
    assertAnchored('newcomer.failure');
    const failure = node('code.newcomer-failure:README.md#port-is-already-allocated');
    expect(failure.properties.symptom).toBe('port is already allocated');
    expect(failure.properties.port).toBe(5432);
    expect(edgesFrom('code.references', failure.key).map((entry) => entry.to)).toEqual(['code.file:docker-compose.yml']);
  });

  // ---- dependencies -------------------------------------------------------

  test('dependencies.old-pin', () => {
    assertAnchored('dependencies.old-pin');
    const lodash = node('code.dependency:services/payments/package.json#lodash');
    expect(lodash.properties.version).toBe('4.17.15');
    expect(lodash.properties.scope).toBe('direct');
    const uses = edgesFrom('code.uses-dependency', 'code.file:services/payments/src/api/legacy-report.ts');
    expect(uses.map((entry) => entry.to)).toContain('code.dependency:services/payments/package.json#lodash');
    const lodashUse = uses.find((entry) => entry.to === 'code.dependency:services/payments/package.json#lodash');
    expect(lodashUse!.span!.path).toBe('services/payments/src/api/legacy-report.ts');
    expect(spanText(lodashUse!.span!)).toContain("from 'lodash'");
  });

  test('dependencies.go', () => {
    assertAnchored('dependencies.go');
    const orders = 'code.dependency:services/orders/go.mod';
    const wanted: Record<string, { version: string; scope: string }> = {
      'github.com/golang-jwt/jwt/v5': { version: 'v5.2.1', scope: 'direct' },
      'github.com/lib/pq': { version: 'v1.10.9', scope: 'direct' },
      'github.com/segmentio/kafka-go': { version: 'v0.4.47', scope: 'direct' },
      'github.com/klauspost/compress': { version: 'v1.15.9', scope: 'indirect' },
      'github.com/pierrec/lz4/v4': { version: 'v4.1.15', scope: 'indirect' },
    };
    for (const [name, wanted_] of Object.entries(wanted)) {
      const dependency = node(`${orders}#${name}`);
      expect(dependency.properties.version).toBe(wanted_.version);
      expect(dependency.properties.scope).toBe(wanted_.scope);
    }
    const promotions = node('code.dependency:services/promotions/go.mod#github.com/lib/pq');
    expect(promotions.properties.version).toBe('v1.10.9');
    expect(promotions.properties.scope).toBe('direct');
    for (const service of ['orders', 'promotions']) {
      const sum = node(`code.lockfile:services/${service}/go.sum`);
      expect(sum.properties.format).toBe('go-sum');
      expect(edgesFrom('code.resolves', `code.manifest:services/${service}/go.mod`).map((entry) => entry.to)).toEqual([`code.lockfile:services/${service}/go.sum`]);
    }
    expect(Number(node('code.lockfile:services/orders/go.sum').properties.modules)).toBeGreaterThanOrEqual(5);
  });

  test('dependencies.direct-transitive-dev', () => {
    assertAnchored('dependencies.direct-transitive-dev');
    for (const service of ['payments', 'checkout']) {
      const planted = key.plantedCounts.dependencies[service]!;
      const prefix = `code.dependency:services/${service}/package.json#`;
      const declared = nodesOfKind('code.dependency').filter((entry) => entry.key.startsWith(prefix));
      const direct = declared.filter((entry) => entry.properties.scope === 'direct');
      const dev = declared.filter((entry) => entry.properties.scope === 'dev');
      expect(direct.length, `${service} direct`).toBe(planted.direct);
      expect(dev.length, `${service} dev`).toBe(planted.dev);
      const lock = node(`code.lockfile:services/${service}/package-lock.json`);
      expect(lock.properties.packages).toBe(planted.packages);
      expect(lock.properties.devOnlyPackages).toBe(planted.devOnlyPackages);
      expect(lock.properties.lockfileVersion).toBe(3);
      expect(edgesFrom('code.resolves', `code.manifest:services/${service}/package.json`).map((entry) => entry.to))
        .toEqual([`code.lockfile:services/${service}/package-lock.json`]);
    }
  });

  test('dependencies.versions', () => {
    assertAnchored('dependencies.versions');
    const payments = 'code.dependency:services/payments/package.json#';
    for (const [name, version] of [['express', '4.19.2'], ['@grpc/grpc-js', '1.10.8'], ['kafkajs', '2.2.4'], ['@prisma/client', '5.14.0'], ['pino', '9.1.0']] as const) {
      expect(node(`${payments}${name}`).properties.version).toBe(version);
    }
    expect(node(`${payments}jest`).properties.version).toBe('29.7.0');
    expect(node(`${payments}jest`).properties.scope).toBe('dev');
    expect(node(`${payments}typescript`).properties.version).toBe('5.4.5');
    expect(node('code.dependency:services/checkout/package.json#express').properties.version).toBe('4.19.2');
  });

  // ---- deploy -------------------------------------------------------------

  test('deploy.orders', () => {
    assertAnchored('deploy.orders');
    const deployment = node('code.k8s-deployment:deploy/k8s/orders.yaml#orders');
    expect(deployment.properties.replicas).toBe(2);
    expect(deployment.properties.image).toBe('registry.example.test/training/orders:1.4.0');
    expect(deployment.properties.containerPorts).toEqual([8080]);
    expect(deployment.properties.probePath).toBe('/healthz');
    const service = node('code.k8s-service:deploy/k8s/orders.yaml#orders');
    expect(service.properties.ports).toEqual([{ name: 'http', port: 80, targetPort: 8080 }]);
    expect(edgesFrom('code.targets', service.key).map((entry) => entry.to)).toEqual(['code.port:orders/8080']);
  });

  test('deploy.compose', () => {
    assertAnchored('deploy.compose');
    const ports: Record<string, string[]> = {
      postgres: ['5432:5432'],
      kafka: ['9092:9092', '9094:9094'],
      orders: ['8080:8080'],
      payments: ['50051:50051', '8081:8081'],
      promotions: ['8082:8082'],
      checkout: ['8083:8083'],
    };
    for (const [name, wanted] of Object.entries(ports)) {
      const service = node(`code.compose-service:docker-compose.yml#${name}`);
      expect([...service.properties.ports as string[]].sort(byCodePoint)).toEqual(wanted);
    }
  });

  test('deploy.image-process-port', () => {
    assertAnchored('deploy.image-process-port');
    const deployment = 'code.k8s-deployment:deploy/k8s/orders.yaml#orders';
    const image = 'code.image:registry.example.test/training/orders:1.4.0';
    const dockerfile = 'code.dockerfile:services/orders/Dockerfile';
    const processNode = 'code.process:services/orders/cmd/orders';
    expect(edgesFrom('code.runs', deployment).map((entry) => entry.to)).toEqual([image]);
    expect(edgesFrom('code.built-by', image).map((entry) => entry.to)).toEqual([dockerfile]);
    expect(edgesFrom('code.starts', dockerfile).map((entry) => entry.to)).toEqual([processNode]);
    expect(edgesFrom('code.listens-on', processNode).map((entry) => entry.to)).toEqual(['code.port:orders/8080']);
    expect(node(image).properties.tag).toBe('1.4.0');
    expect(node(processNode).properties.binary).toBe('/app/orders');
  });

  test('deploy.dockerfiles', () => {
    assertAnchored('deploy.dockerfiles');
    const orders = node('code.dockerfile:services/orders/Dockerfile');
    expect(orders.properties.baseImages).toEqual(['alpine:3.20', 'golang:1.22.5-alpine']);
    expect(orders.properties.exposes).toEqual([8080]);
    expect(orders.properties.command).toBe('["/app/orders"]');
    const payments = node('code.dockerfile:services/payments/Dockerfile');
    expect(payments.properties.exposes).toEqual([8081, 50051]);
    expect(String(payments.properties.command)).toContain('prisma migrate deploy');
    expect(node('code.dockerfile:services/checkout/Dockerfile').properties.exposes).toEqual([8083]);
    expect(node('code.dockerfile:services/promotions/Dockerfile').properties.exposes).toEqual([8082]);
    // each compose service builds its own image from its own context
    for (const [service, dockerfile] of [
      ['orders', 'services/orders/Dockerfile'],
      ['payments', 'services/payments/Dockerfile'],
      ['promotions', 'services/promotions/Dockerfile'],
      ['checkout', 'services/checkout/Dockerfile'],
    ] as const) {
      const builds = edgesFrom('code.builds', `code.compose-service:docker-compose.yml#${service}`);
      expect(builds.map((entry) => entry.to)).toEqual([`code.dockerfile:${dockerfile}`]);
    }
    expect(node('code.compose-service:docker-compose.yml#payments').properties.build).toEqual({ context: '.', dockerfile: 'services/payments/Dockerfile' });
    expect(node('code.compose-service:docker-compose.yml#orders').properties.build).toBe('./services/orders');
  });

  // ---- build --------------------------------------------------------------

  test('build.ci', () => {
    assertAnchored('build.ci');
    const workflow = node('code.ci-workflow:.github/workflows/ci.yml');
    expect(workflow.properties.name).toBe('ci');
    const steps: Record<string, string[]> = {
      orders: ['go vet ./...', 'go test ./...'],
      promotions: ['go vet ./...'],
      payments: ['npm ci', 'npx prisma generate', 'npx tsc --noEmit', 'npm test'],
      checkout: ['npm ci', 'npx tsc --noEmit', 'npm test'],
    };
    for (const [job, wanted] of Object.entries(steps)) {
      const record = node(`code.ci-job:.github/workflows/ci.yml#${job}`);
      expect(record.properties.steps).toEqual(wanted);
      expect(record.properties.workingDirectory).toBe(`services/${job}`);
      expect(edgesFrom('code.contains-job', 'code.ci-workflow:.github/workflows/ci.yml').map((entry) => entry.to))
        .toContain(`code.ci-job:.github/workflows/ci.yml#${job}`);
    }
  });

  test('build.makefile', () => {
    assertAnchored('build.makefile');
    for (const target of ['run-orders', 'test', 'install', 'up', 'down', 'seed', 'token']) {
      expect(maybeNode(`code.make-target:Makefile#${target}`), target).toBeDefined();
    }
    const runOrders = node('code.make-target:Makefile#run-orders');
    expect(runOrders.properties.recipe).toEqual(['cd services/orders && go run ./cmd/orders']);
    expect(runOrders.properties.phony).toBe(true);
    expect(node('code.make-target:Makefile#down').properties.recipe).toEqual(['docker compose down']);
  });

  // ---- config ---------------------------------------------------------------

  test('config.database-url', () => {
    assertAnchored('config.database-url');
    for (const service of ['orders', 'payments', 'promotions']) {
      const variable = node(`code.env-var:${service}/DATABASE_URL`);
      expect(variable.properties.required).toBe(true);
      expect(variable.properties.default).toBeNull();
    }
    const reads = edgesOf('code.reads-env').filter((entry) => entry.to.endsWith('/DATABASE_URL'));
    const byFile = new Map(reads.map((entry) => [entry.from, entry.properties.symbol]));
    expect(byFile.get('code.file:services/orders/internal/config/config.go')).toBe('Load');
    expect(byFile.get('code.file:services/payments/src/config.ts')).toBe('loadConfig');
    expect(byFile.get('code.file:services/promotions/cmd/promotions/main.go')).toBe('main');
    const envExample = node('code.env-definition:.env.example#DATABASE_URL');
    expect(envExample.properties.value).toBe('postgres://training:training@localhost:5432/orders?sslmode=disable');
    for (const service of ['orders', 'payments', 'promotions']) {
      const defined = node(`code.env-definition:docker-compose.yml#${service}/DATABASE_URL`);
      expect(String(defined.properties.value)).toContain(`postgres:5432/${service}`);
      expect(edgesFrom('code.defines', defined.key).map((entry) => entry.to)).toEqual([`code.env-var:${service}/DATABASE_URL`]);
    }
  });

  test('config.kafka-brokers', () => {
    assertAnchored('config.kafka-brokers');
    for (const service of ['orders', 'payments']) {
      expect(node(`code.env-var:${service}/KAFKA_BROKERS`).properties.required).toBe(true);
      expect(node(`code.env-var:${service}/KAFKA_BROKERS`).properties.default).toBeNull();
    }
    expect(node('code.env-definition:.env.example#KAFKA_BROKERS').properties.value).toBe('localhost:9094');
    for (const service of ['orders', 'payments']) {
      expect(node(`code.env-definition:docker-compose.yml#${service}/KAFKA_BROKERS`).properties.value).toBe('kafka:9092');
    }
  });

  test('config.payment-provider', () => {
    assertAnchored('config.payment-provider');
    const provider = node('code.env-var:payments/PAYMENT_PROVIDER');
    expect(provider.properties.required).toBe(false);
    expect(provider.properties.default).toBe('cardnet');
    expect(node('code.env-definition:.env.example#PAYMENT_PROVIDER').properties.value).toBe('deferred');
    expect(node('code.env-definition:docker-compose.yml#payments/PAYMENT_PROVIDER').properties.value).toBe('${PAYMENT_PROVIDER:-deferred}');
  });

  test('config.jwt-secret', () => {
    assertAnchored('config.jwt-secret');
    for (const service of ['orders', 'payments']) {
      const secret = node(`code.env-var:${service}/JWT_SECRET`);
      expect(secret.properties.required).toBe(true);
      expect(secret.properties.default).toBeNull();
    }
    expect(node('code.env-definition:.env.example#JWT_SECRET').properties.value).toBe('local-development-secret');
    expect(node('code.env-definition:docker-compose.yml#orders/JWT_SECRET').properties.value).toBe('${JWT_SECRET:-local-development-secret}');
  });

  test('config.payment-timeout-ms', () => {
    assertAnchored('config.payment-timeout-ms');
    const timeout = node('code.env-var:payments/PAYMENT_TIMEOUT_MS');
    expect(timeout.properties.required).toBe(false);
    expect(timeout.properties.default).toBe('3000');
    const read = edgesOf('code.reads-env').find((entry) => entry.to === 'code.env-var:payments/PAYMENT_TIMEOUT_MS');
    expect(read).toBeDefined();
    expect(read!.properties.symbol).toBe('loadConfig');
    // the key's checks: neither local file defines it
    for (const check of item('config.payment-timeout-ms').checks ?? []) {
      expect(textOf(check.path).includes('PAYMENT_TIMEOUT_MS'), check.path).toBe(false);
      expect(nodes.get(`code.env-definition:${check.path}#PAYMENT_TIMEOUT_MS`)).toBeUndefined();
    }
  });

  test('config.service-urls', () => {
    assertAnchored('config.service-urls');
    const checkout = 'code.env-var:checkout/';
    expect(node(`${checkout}ORDERS_URL`).properties).toEqual({ required: false, default: 'http://localhost:8080' });
    expect(node(`${checkout}PROMOTIONS_URL`).properties).toEqual({ required: false, default: 'http://localhost:8082' });
    expect(node(`${checkout}PAYMENTS_ADDR`).properties).toEqual({ required: false, default: 'localhost:50051' });
    expect(node(`${checkout}PAYMENTS_DEADLINE_MS`).properties).toEqual({ required: false, default: '8000' });
    for (const name of ['ORDERS_URL', 'PROMOTIONS_URL', 'PAYMENTS_ADDR']) {
      expect(maybeNode(`code.env-definition:docker-compose.yml#checkout/${name}`)).toBeDefined();
    }
    expect(maybeNode('code.env-definition:docker-compose.yml#checkout/PAYMENTS_DEADLINE_MS')).toBeUndefined();
  });

  // ---- observability --------------------------------------------------------

  test('obs.logging', () => {
    assertAnchored('obs.logging');
    const loggers: Record<string, string> = {
      'services/orders/internal/logging/logger.go': 'orders',
      'services/promotions/internal/logging/logger.go': 'promotions',
      'services/payments/src/logging/logger.ts': 'payments',
      'services/checkout/src/logging/logger.ts': 'checkout',
    };
    for (const [file, service] of Object.entries(loggers)) {
      const go = file.endsWith('.go');
      const logger = node(`code.logger:${file}#${go ? 'New' : 'logger'}`);
      expect(logger.properties.service).toBe(service);
      expect(logger.properties.library).toBe(go ? 'slog' : 'pino');
      expect(logger.properties.json).toBe(true);
    }
  });

  test('obs.healthz', () => {
    assertAnchored('obs.healthz');
    const endpoints: Record<string, string> = {
      'services/orders/internal/api/router.go': 'Health',
      'services/payments/src/app.ts': 'createApp',
      'services/promotions/internal/api/handler.go': 'Routes',
      'services/checkout/src/app.ts': 'createApp',
    };
    for (const [file, symbol] of Object.entries(endpoints)) {
      const endpoint = node(`code.health-endpoint:${file}#${symbol}`);
      expect(endpoint.properties.path).toBe('/healthz');
      expect(endpoint.properties.method).toBe('GET');
    }
  });

  test('obs.metrics', () => {
    assertAnchored('obs.metrics');
    const metrics = node('code.metrics-endpoint:services/orders/internal/api/metrics.go#Metrics');
    expect(metrics.properties.path).toBe('/metrics');
    expect(metrics.properties.format).toBe('prometheus-text');
    expect(metrics.properties.counters).toEqual([
      'orders_created_total', 'orders_http_requests_total', 'orders_purged_total', 'orders_transitions_total',
    ]);
    expect(nodesOfKind('code.metrics-endpoint')).toHaveLength(1);
  });
});

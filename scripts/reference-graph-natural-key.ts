/**
 * The one function that names a graph record the way the reference graph names
 * it (`examples/training-repository/reference-graph/`), and the test beside it
 * (`test/reference-graph-natural-key.test.ts`).
 *
 * The rule, in one sentence: a natural id keeps every part of the thing's own
 * name and drops only the locator the producer prefixes so that two records of
 * one file stay apart — the declaring file, the container a probe runs in, the
 * operation counter of a repeated route. Nothing is case-folded, nothing is
 * matched by similarity, and a part of a name is never dropped.
 *
 * Where the producer's key is a digest (a commit, a task key, an environment
 * variable, a dependency) the record carries its name in `record`/`properties`,
 * and that name is used; a digest is not a name.
 *
 * An unknown kind or a record that does not carry the parts its kind needs is
 * refused by name, never guessed.
 */

/** One record as the graph's reader presents it: its kind, its key, its label and its properties. */
export interface RecordName {
  readonly kind: string;
  readonly key: string;
  readonly label?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** The kind's own record fields, under the metadata every static stage's records carry. */
function recordOf(record: RecordName): Record<string, unknown> {
  const held = record.properties?.['record'];
  return held !== null && typeof held === 'object' && !Array.isArray(held) ? (held as Record<string, unknown>) : (record.properties ?? {});
}

function text(value: unknown, what: string, record: RecordName): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what} is missing from the ${record.kind} record ${JSON.stringify(record.key)}: the natural id cannot name a record that does not say what it is (scripts/reference-graph-natural-key.ts)`);
  }
  return value;
}

/** The service a path of `services/<service>/...` stands in. */
export function serviceOfFile(file: string): string {
  const match = /^services\/([^/]+)\//u.exec(file);
  if (match === null) throw new Error(`${JSON.stringify(file)} is not under services/<service>/, so no service names it (scripts/reference-graph-natural-key.ts)`);
  return match[1]!;
}

/** A key's body after `<kind>:`. */
function bodyOf(key: string, _kind: string): string {
  // A column's key is built on its table's key (`code.table:<database>/<schema>.<table>/<column>`),
  // so the body is what stands after any `code.<kind>:` prefix, not only this record's own.
  return key.replace(/^code\.[a-z-]+:/u, '');
}

/** The part of a key before its `#`, which is the file a record stands in; and the part after it. */
function splitAt(key: string, kind: string): { locator: string; name: string } {
  const body = bodyOf(key, kind);
  const hash = body.indexOf('#');
  return hash < 0 ? { locator: body, name: '' } : { locator: body.slice(0, hash), name: body.slice(hash + 1) };
}

/**
 * The kinds this function names: the kinds the reference graph uses, and no
 * other. A record of any other kind is one the reference leaves out by design
 * (an extraction intermediate), and the scorer counts it there, not as a record
 * it failed to name.
 */
export const NAMED_KINDS: ReadonlySet<string> = new Set([
  'code.file', 'code.symbol', 'code.field', 'code.module', 'code.package', 'code.service', 'code.repository',
  'code.contract', 'code.channel', 'code.database', 'code.manifest', 'code.lockfile', 'code.dockerfile',
  'code.image', 'code.ci-workflow', 'code.repository-landmark', 'code.route', 'code.table', 'code.column',
  'code.index', 'code.migration', 'code.operation', 'code.message', 'code.input', 'code.sql-build',
  'code.sql-sink', 'code.entry-point', 'code.test-case', 'code.debt', 'code.cycle', 'code.state',
  'code.state-machine', 'code.dependency', 'code.env-var', 'code.env-definition', 'code.commit', 'code.task',
  'code.port', 'code.probe', 'code.healthcheck', 'code.health-endpoint', 'code.metrics-endpoint', 'code.metric',
  'code.logger', 'code.compose-service', 'code.k8s-deployment', 'code.k8s-service', 'code.make-target',
  'code.ci-job', 'code.broker', 'code.newcomer-prerequisites', 'code.newcomer-command', 'code.newcomer-failure',
  'code.document', 'code.document-section',
]);

/** The kind and the natural name of one graph record. */
export function naturalKeyOf(record: RecordName): string {
  const { kind, key } = record;
  const inner = recordOf(record);
  const named = (prefix: string, name: string): string => `${prefix}:${name}`;
  switch (kind) {
    // Keys that already spell the name the reference uses.
    case 'code.file':
    case 'code.symbol':
    case 'code.field':
    case 'code.module':
    case 'code.service':
    case 'code.contract':
    case 'code.channel':
    case 'code.database':
    case 'code.manifest':
    case 'code.lockfile':
    case 'code.dockerfile':
    case 'code.image':
    case 'code.ci-workflow':
    case 'code.repository-landmark':
      return key;

    // The route a service serves: `code.route:<file>#<METHOD>:<path>`.
    case 'code.route': {
      const { locator, name } = splitAt(key, kind);
      const colon = name.indexOf(':');
      if (colon < 0) throw new Error(`the route ${JSON.stringify(key)} does not say METHOD:path`);
      const method = name.slice(0, colon);
      const routePath = name.slice(colon + 1);
      return named('code.route', `${serviceOfFile(locator)}:${method} ${routePath}`);
    }

    // The package a manifest declares: the folder the manifest sits in.
    case 'code.package': {
      const manifest = text(record.properties?.['manifest'] ?? inner['manifest'], 'the manifest of a package', record);
      const folder = manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/')) : '.';
      return named('code.package', folder);
    }

    // The repository a record was read from, named as the history names it.
    case 'code.repository':
      return named('code.repository', text(record.properties?.['repository'], 'the name of a repository', record));

    // A table, a column, an index: `code.table:<database>/<schema>.<table>`, and the reference
    // keeps the schema only where it is not the default `public`.
    case 'code.table': {
      const body = bodyOf(key, kind);
      const slash = body.indexOf('/');
      if (slash < 0) throw new Error(`the table ${JSON.stringify(key)} does not say <database>/<schema>.<table>`);
      const database = body.slice(0, slash);
      const qualified = body.slice(slash + 1);
      const dot = qualified.indexOf('.');
      const schema = dot < 0 ? 'public' : qualified.slice(0, dot);
      const table = dot < 0 ? qualified : qualified.slice(dot + 1);
      return named('code.table', schema === 'public' ? `${database}.${table}` : `${database}.${schema}.${table}`);
    }
    case 'code.column': {
      const body = bodyOf(key, kind);
      const slash = body.indexOf('/');
      const last = body.lastIndexOf('/');
      if (slash < 0 || last === slash) throw new Error(`the column ${JSON.stringify(key)} does not say <database>/<schema>.<table>/<column>`);
      const database = body.slice(0, slash);
      const qualified = body.slice(slash + 1, last);
      const column = body.slice(last + 1);
      const dot = qualified.indexOf('.');
      const schema = dot < 0 ? 'public' : qualified.slice(0, dot);
      const table = dot < 0 ? qualified : qualified.slice(dot + 1);
      return named('code.column', schema === 'public' ? `${database}.${table}.${column}` : `${database}.${schema}.${table}.${column}`);
    }
    case 'code.index': {
      const body = bodyOf(key, kind);
      const slash = body.indexOf('/');
      const last = body.lastIndexOf('/');
      if (slash < 0 || last === slash) throw new Error(`the index ${JSON.stringify(key)} does not say <database>/<schema>.<table>/<index>`);
      const database = body.slice(0, slash);
      const qualified = body.slice(slash + 1, last);
      const index = body.slice(last + 1);
      const dot = qualified.indexOf('.');
      const schema = dot < 0 ? 'public' : qualified.slice(0, dot);
      return named('code.index', schema === 'public' ? `${database}.${index}` : `${database}.${schema}.${index}`);
    }

    // A migration the repository keeps, named by its file.
    case 'code.migration': {
      const path = record.properties?.['path'] ?? inner['path'] ?? record.properties?.['file'];
      if (typeof path === 'string' && path.length > 0) return named('code.migration', path);
      return named('code.migration', splitAt(key, kind).name);
    }

    // An operation a contract declares: its own `operationId` or RPC name.
    case 'code.operation': {
      const { locator } = splitAt(key, kind);
      const name = typeof inner['operationId'] === 'string' ? (inner['operationId'] as string) : typeof inner['rpc'] === 'string' ? (inner['rpc'] as string) : undefined;
      if (name === undefined) throw new Error(`the operation ${JSON.stringify(key)} carries no operationId and no rpc name`);
      return named('code.operation', `${locator}#${name}`);
    }

    // A message a contract declares: its contract and its name.
    case 'code.message': {
      const { locator, name } = splitAt(key, kind);
      return named('code.message', locator === '' ? name : `${locator}#${name}`);
    }

    // An input a file reads: the source and the name, as the key spells them.
    case 'code.input': return key;

    case 'code.sql-build':
    case 'code.sql-sink':
    case 'code.entry-point':
    case 'code.test-case':
    case 'code.debt':
    case 'code.cycle':
      return key;

    // A state of a state machine, by the status it names.
    case 'code.state':
      return named('code.state', text(record.properties?.['label'] ?? inner['label'] ?? record.label, 'the label of a state', record));

    // A state machine, by the file and the table it is written in.
    case 'code.state-machine': {
      const body = bodyOf(key, kind).replace(/^[^:]+:/u, '');
      return named('code.state-machine', body);
    }

    // A dependency a manifest declares: the manifest and the name.
    case 'code.dependency': {
      const file = text(record.properties?.['file'] ?? inner['file'], 'the manifest of a dependency', record);
      const name = text(inner['name'] ?? record.label, 'the name of a dependency', record);
      return named('code.dependency', `${file}#${name}`);
    }

    // An environment variable: the name, wherever it is declared.
    case 'code.env-var':
      return named('code.env-var', text(inner['name'] ?? record.label, 'the name of an environment variable', record));

    // A declaration of one: the file and the name, and the service a compose file scopes it to.
    case 'code.env-definition': {
      const { locator, name } = splitAt(key, kind);
      const file = typeof record.properties?.['file'] === 'string' ? (record.properties['file'] as string) : locator;
      const scope = typeof inner['scope'] === 'string' && inner['scope'] !== '' ? `${inner['scope']}/` : '';
      const variable = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
      return named('code.env-definition', `${file}#${scope}${variable}`);
    }

    // A commit, by its hash; a task, by its key.
    case 'code.commit': {
      const sha = text(inner['commit'] ?? record.properties?.['commit'], 'the hash of a commit', record);
      return named('code.commit', sha);
    }
    case 'code.task':
      return named('code.task', text(inner['key'] ?? record.label, 'the key of a task', record));

    // A port a service listens on: `code.port:<service>/<port>`.
    case 'code.port': {
      const parts = splitAt(key, kind);
      const name = parts.name === '' ? parts.locator : parts.name;
      const slash = name.lastIndexOf('/');
      if (slash < 0) throw new Error(`the port ${JSON.stringify(key)} does not say <service>/<port>`);
      return named('code.port', `${name.slice(0, slash)}:${name.slice(slash + 1)}`);
    }

    // A probe of a workload: the workload and the kind of probe.
    case 'code.probe': {
      const { name } = splitAt(key, kind);
      const parts = name.split('/');
      if (parts.length < 2) throw new Error(`the probe ${JSON.stringify(key)} does not say <workload>/<container>/<probe>`);
      return named('code.probe', `${parts[0]}.${parts[parts.length - 1]}`);
    }

    case 'code.healthcheck': {
      const { name } = splitAt(key, kind);
      return named('code.healthcheck', name);
    }

    // A health or metrics endpoint: the service that serves it and its path.
    case 'code.health-endpoint':
    case 'code.metrics-endpoint': {
      const { locator } = splitAt(key, kind);
      const service = serviceOfFile(locator);
      const endpointPath = typeof inner['path'] === 'string' ? (inner['path'] as string) : kind === 'code.health-endpoint' ? '/healthz' : '/metrics';
      return named(kind, `${service}:${endpointPath}`);
    }

    // A metric: its name.
    case 'code.metric':
      return named('code.metric', text(inner['name'] ?? record.label, 'the name of a metric', record));

    // A logger: the service whose module declares it.
    case 'code.logger': {
      const { locator } = splitAt(key, kind);
      return named('code.logger', serviceOfFile(locator));
    }

    // A compose service and a Kubernetes object: their own names.
    case 'code.compose-service':
    case 'code.k8s-deployment':
    case 'code.k8s-service':
      return named(kind, splitAt(key, kind).name);

    // A build target of a Makefile: its name.
    case 'code.make-target':
      return named('code.make-target', splitAt(key, kind).name);

    // A CI job: the workflow's file and the job.
    case 'code.ci-job':
      return named('code.ci-job', bodyOf(key, kind));

    // A broker: its own name (`<file>#<name>` or `address/<address>`).
    case 'code.broker': {
      const { name } = splitAt(key, kind);
      return named('code.broker', name.startsWith('address/') ? name.slice('address/'.length) : name);
    }

    // A newcomer's walk through a README.
    case 'code.newcomer-prerequisites':
      return key;
    case 'code.newcomer-command': {
      const { locator, name } = splitAt(key, kind);
      const command = typeof inner['command'] === 'string' ? (inner['command'] as string) : name;
      return named('code.newcomer-command', `${locator}#${command}`);
    }
    case 'code.newcomer-failure':
      return key;

    // A document and its sections: the file and the heading.
    case 'code.document': {
      const path = typeof record.properties?.['path'] === 'string' ? (record.properties['path'] as string) : inner['path'];
      return named('code.document', text(path, 'the path of a document', record));
    }
    case 'code.document-section': {
      const document = text(inner['document'] ?? record.properties?.['file'], 'the document of a section', record);
      const heading = text(inner['heading'] ?? record.label, 'the heading of a section', record);
      return named('code.document-section', `${document}#${heading}`);
    }

    default:
      throw new Error(`no natural name is known for the kind ${JSON.stringify(kind)} (record ${JSON.stringify(key)}): the mapping names every kind the reference uses (scripts/reference-graph-natural-key.ts)`);
  }
}

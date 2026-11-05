/**
 * The records one file of the operations reading declares, as the extract
 * driver reads them (decision 0028's `Extraction`; decision 0033, items 5 and
 * 14; madarch-8bdc.2.4).
 *
 * **Why this module exists.** The extract driver's operations area reads a whole
 * tree once, accumulates every record into one object and gives each record the
 * span it was read at. A static stage may hold neither the tree nor that object
 * (decision 0033, item 5), so this module is the per-file half: one file's bytes
 * in, the records whose span stands in that file out, with the driver's own
 * keys, labels, properties and spans. The driver is not deleted until
 * madarch-8bdc.2.5, so the two implementations stand side by side and
 * `test/fill-operations-training.test.ts` is what holds them to one answer on
 * the generated training repository.
 *
 * **What a record is.** A node is a key (`code.service:orders`), the extractors'
 * kind (`code.service`), the label a reader sees and the properties the driver
 * writes — the driver's own vocabulary, verbatim. An edge is its relation type,
 * both ends by the keys their nodes carry, the discriminator that tells two
 * parallel edges apart, its properties and its span. A span is the file the
 * record cites, the byte offsets and the 1-based lines — the driver's own
 * `SourceSpan`.
 *
 * **A file's text.** `FileText` decodes one file's bytes and answers the spans
 * the driver's `TreeText` answers for the same bytes: the byte offsets are
 * computed over the same decoded text, so a span made here is the span the
 * driver's bytes hold, and the comparison needs no tolerance.
 */
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { byCodePoint } from '../../model/order.js';
import { readDockerfile, readGoMod, readJson } from './manifest-format.js';

/** Where in a file a record was read: half-open byte offsets, 1-based lines (the driver's `SourceSpan`). */
export interface RecordSpan {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One node record, as the driver accumulates it. */
export interface NodeRecord {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly span?: RecordSpan;
}

/** One edge record, as the driver accumulates it. */
export interface EdgeRecord {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly discriminator: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly span?: RecordSpan;
}

/** What could not be read: the path and why. Never a silence (decision 0005). */
export interface RecordGap {
  readonly path: string;
  readonly reason: string;
}

/** One file's records. */
export interface FileRecords {
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  readonly gaps: readonly RecordGap[];
}

/** The encoder the byte offsets are counted with: the driver's own. */
const encoder = new TextEncoder();

/** One file's text: its bytes, its decoded characters, its lines and the spans over them. */
export class FileText {
  /** The file's text, decoded once; a malformed sequence reads as the replacement character, as the driver's reader reads it. */
  readonly text: string;
  /** The file's lines, split once, without their trailing line feed. */
  readonly lines: readonly string[];

  constructor(readonly path: string, readonly bytes: Uint8Array) {
    this.text = new TextDecoder().decode(bytes);
    this.lines = this.text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  /** A span over one whole file. */
  spanOfFile(): RecordSpan {
    return { path: this.path, byteStart: 0, byteEnd: this.bytes.length, lineStart: 1, lineEnd: Math.max(this.lines.length, 1) };
  }

  /** A span over one 1-based line. */
  spanOfLine(line: number): RecordSpan {
    const text = this.lines[line - 1] ?? '';
    const start = lineStart(this.lines, line);
    return this.spanOfChars(start, start + text.length, line, line);
  }

  /** A span from one 1-based line through another, both whole. */
  spanOfLines(first: number, last: number): RecordSpan {
    const held: string[] = [];
    for (let line = first; line <= last && line <= this.lines.length; line += 1) held.push(this.lines[line - 1] ?? '');
    const start = lineStart(this.lines, first);
    return this.spanOfChars(start, start + held.join('\n').length, first, Math.min(last, Math.max(this.lines.length, 1)));
  }

  /** A span from one character offset to another, over the decoded text: the driver's own byte arithmetic. */
  spanOfChars(startChar: number, endChar: number, lineStart_: number, lineEnd_: number): RecordSpan {
    const byteStart = startChar >= this.text.length ? this.bytes.length : encoder.encode(this.text.slice(0, startChar)).length;
    const byteEnd = endChar >= this.text.length ? this.bytes.length : encoder.encode(this.text.slice(0, endChar)).length;
    return { path: this.path, byteStart, byteEnd, lineStart: lineStart_, lineEnd: Math.max(lineEnd_, lineStart_) };
  }
}

/** The character offset a 1-based line starts at. */
function lineStart(lines: readonly string[], line: number): number {
  let at = 0;
  for (let index = 0; index < line - 1 && index < lines.length; index += 1) at += (lines[index]?.length ?? 0) + 1;
  return at;
}

/**
 * The accumulator one unit's readers write into: node and edge records keyed by
 * their logical identity, deduplicated on arrival, and the gaps for what could
 * not be read. The driver's `Records` keeps the first declaration of a key, and
 * so does this one, so a reader that meets the same node twice records it once.
 */
export class RecordSet {
  readonly nodes: NodeRecord[] = [];
  readonly edges: EdgeRecord[] = [];
  readonly gaps: RecordGap[] = [];
  private readonly held = new Set<string>();

  /** Adds one node unless its key is held already; the first declaration stands. */
  add(node: NodeRecord): void {
    if (this.held.has(node.key)) return;
    this.held.add(node.key);
    this.nodes.push(node);
  }

  /** Whether this set already holds a node under this key. */
  has(key: string): boolean {
    return this.held.has(key);
  }

  /** The node this set holds under a key, where one stands. */
  nodeOf(key: string): NodeRecord | undefined {
    return this.nodes.find((node) => node.key === key);
  }

  /** Adds one edge keyed by its type, ends and discriminator; the first declaration stands. */
  edge(type: string, from: string, to: string, properties: Readonly<Record<string, unknown>> = {}, span?: RecordSpan, discriminator = ''): void {
    const key = `${type}\u0000${from}\u0000${to}\u0000${discriminator}`;
    if (this.held.has(key)) return;
    this.held.add(key);
    this.edges.push({ type, from, to, discriminator, properties, ...(span === undefined ? {} : { span }) });
  }

  /** Names what could not be read: the path, why. Never a silence. */
  gap(path: string, reason: string): void {
    const key = `${path}\u0000${reason}`;
    if (this.held.has(key)) return;
    this.held.add(key);
    this.gaps.push({ path, reason });
  }

  /** The key of the port node of one service, made on first use, with the place the port was read at. */
  port(service: string, port: number, span?: RecordSpan): string {
    const key = `code.port:${service}/${String(port)}`;
    this.add({ key, kind: 'code.port', label: `${service}/${String(port)}`, properties: { port, service }, ...(span === undefined ? {} : { span }) });
    return key;
  }

  /** The driver's key for one repository file: the record a file is held under (stage 0 publishes the node itself). */
  static fileKey(path: string): string {
    return `code.file:${path}`;
  }
}

/** The answer one file's reader gives: the records it made, in code point order of their keys. */
export function recordsOf(set: RecordSet): FileRecords {
  return {
    nodes: [...set.nodes].sort((left, right) => byCodePoint(left.key, right.key)),
    edges: [...set.edges].sort((left, right) => byCodePoint(left.type, right.type) || byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.discriminator, right.discriminator)),
    gaps: [...set.gaps].sort((left, right) => byCodePoint(left.path, right.path) || byCodePoint(left.reason, right.reason)),
  };
}


// ---- dependencies: what each manifest declares, and what each lock file resolves ----

/** An npm version requirement that pins a release exactly (`4.17.15`, `1.2.3-rc.1`). */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

/** One dependency a manifest declares, with the line it stands on: what a code file's imports are matched against. */
export interface DeclaredDependency {
  /** The name the manifest wrote (`express`, `github.com/segmentio/kafka-go`). */
  readonly name: string;
  /** The scope the manifest declares it in (`direct`, `dev`, `indirect` for a Go indirect requirement). */
  readonly scope: string;
  /** The 1-based line the declaration stands on. */
  readonly line: number;
}

/** What one manifest's reading answered: its records, and the dependencies a code file may import. */
export interface ManifestReading {
  readonly records: FileRecords;
  readonly declared: readonly DeclaredDependency[];
}

/**
 * One `package.json`: its service unit, the dependencies it declares with the
 * version each pins, and — where the folder holds a `package-lock.json` — the
 * `resolves` edge from the manifest to the lock file's own node.
 */
export function npmManifestReading(file: FileText, lockPath: string | undefined): ManifestReading {
  const set = new RecordSet();
  const read = readJson(file.text);
  if (!read.ok) {
    set.gap(file.path, `line ${String(read.gap.line)}: ${read.gap.detail}`);
    return { records: recordsOf(set), declared: [] };
  }
  for (const note of read.gaps) set.gap(file.path, `line ${String(note.line)}: ${note.detail}`);
  const manifest = read.value.value as { name?: unknown; private?: unknown; version?: unknown; scripts?: unknown; dependencies?: unknown; devDependencies?: unknown };
  const properties: Record<string, unknown> = { ecosystem: 'npm' };
  if (typeof manifest.name === 'string') properties['name'] = manifest.name;
  if (typeof manifest.private === 'boolean') properties['private'] = manifest.private;
  if (typeof manifest.version === 'string') properties['version'] = manifest.version;
  if (manifest.scripts !== undefined && manifest.scripts !== null && typeof manifest.scripts === 'object') {
    properties['scripts'] = Object.fromEntries(
      Object.entries(manifest.scripts as Record<string, unknown>).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]),
    );
  }
  const manifestKey = `code.manifest:${file.path}`;
  set.add({ key: manifestKey, kind: 'code.manifest', label: file.path, properties, span: file.spanOfFile() });
  const declared: DeclaredDependency[] = [];
  const scopes: readonly (readonly [string, unknown, string])[] = [
    ['direct', manifest.dependencies, 'dependencies'],
    ['dev', manifest.devDependencies, 'devDependencies'],
  ];
  for (const [scope, block, blockName] of scopes) {
    if (block === undefined || block === null || typeof block !== 'object') continue;
    for (const [dependency, version] of Object.entries(block as Record<string, unknown>)) {
      if (typeof version !== 'string') continue;
      const line = read.value.lineAt([blockName, dependency]);
      const span = file.spanOfLine(line);
      const key = `code.dependency:${file.path}#${dependency}`;
      set.add({
        key,
        kind: 'code.dependency',
        label: dependency,
        properties: { name: dependency, version, scope, exact: EXACT_VERSION.test(version) },
        span,
      });
      set.edge('code.declares-dependency', manifestKey, key, { scope }, span);
      declared.push({ name: dependency, scope, line });
    }
  }
  if (lockPath !== undefined) set.edge('code.resolves', manifestKey, `code.lockfile:${lockPath}`, {}, undefined);
  return { records: recordsOf(set), declared };
}

/**
 * One `go.mod`: the module, the go version its `go` directive names, and each
 * requirement with the version the line pins and whether the line marks it
 * indirect. The file's own lines are the reading, as the driver reads them.
 */
export function goModReading(file: FileText, sumPath: string | undefined): ManifestReading {
  const set = new RecordSet();
  const read = readGoMod(file.text);
  if (!read.ok) {
    set.gap(file.path, `line ${String(read.gap.line)}: ${read.gap.detail}`);
    return { records: recordsOf(set), declared: [] };
  }
  const lines = file.lines;
  const goVersion = lines.map((line) => /^go\s+(\S+)/.exec(line)?.[1]).find((value) => value !== undefined) ?? null;
  const manifestKey = `code.manifest:${file.path}`;
  set.add({
    key: manifestKey,
    kind: 'code.manifest',
    label: file.path,
    properties: { ecosystem: 'go', module: read.value.module, goVersion },
    span: file.spanOfFile(),
  });
  const declared: DeclaredDependency[] = [];
  for (const require of read.value.requires) {
    const raw = lines[require.line - 1]?.trim() ?? '';
    const indirect = raw.includes('// indirect');
    const tokens = raw.split(/\s+/u).filter((token) => token !== '//');
    const version = tokens.find((token) => /^v\d/.test(token)) ?? null;
    const scope = indirect ? 'indirect' : 'direct';
    const key = `code.dependency:${file.path}#${require.path}`;
    const span = file.spanOfLine(require.line);
    set.add({ key, kind: 'code.dependency', label: require.path, properties: { name: require.path, version, scope }, span });
    set.edge('code.declares-dependency', manifestKey, key, { scope }, span);
    if (!indirect) declared.push({ name: require.path, scope, line: require.line });
  }
  if (sumPath !== undefined) set.edge('code.resolves', manifestKey, `code.lockfile:${sumPath}`, {}, undefined);
  return { records: recordsOf(set), declared };
}

/** One `package-lock.json`: its format version, its packages and how many of them only a developer needs. */
export function npmLockRecords(file: FileText): FileRecords {
  const set = new RecordSet();
  const read = readJson(file.text);
  if (!read.ok) {
    set.gap(file.path, `line ${String(read.gap.line)}: ${read.gap.detail}`);
    return recordsOf(set);
  }
  for (const note of read.gaps) set.gap(file.path, `line ${String(note.line)}: ${note.detail}`);
  const lock = read.value.value as { lockfileVersion?: unknown; packages?: unknown };
  const packages = lock.packages;
  let total = 0;
  let devOnly = 0;
  if (packages !== undefined && packages !== null && typeof packages === 'object') {
    for (const [name, entry] of Object.entries(packages as Record<string, unknown>)) {
      if (name === '') continue;
      total += 1;
      if (entry !== null && typeof entry === 'object' && (entry as { dev?: unknown }).dev === true) devOnly += 1;
    }
  }
  set.add({
    key: `code.lockfile:${file.path}`,
    kind: 'code.lockfile',
    label: file.path,
    properties: { format: 'npm', lockfileVersion: typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : null, packages: total, devOnlyPackages: devOnly },
    span: file.spanOfFile(),
  });
  return recordsOf(set);
}

/** One `go.sum`: the distinct module-version pairs it carries sums for. */
export function goSumRecords(file: FileText): FileRecords {
  const set = new RecordSet();
  const pairs = new Set<string>();
  for (const line of file.lines) {
    const declared = /^(\S+)\s+(\S+)\s+/.exec(line);
    if (declared !== null) pairs.add(`${declared[1] ?? ''} ${declared[2] ?? ''}`);
  }
  set.add({
    key: `code.lockfile:${file.path}`,
    kind: 'code.lockfile',
    label: file.path,
    properties: { format: 'go-sum', modules: pairs.size },
    span: file.spanOfFile(),
  });
  return recordsOf(set);
}

/**
 * The dependencies one code file uses: each import the file's own facts hold,
 * by the specifier its declaration wrote, matched against the dependency names
 * the manifest of its unit declares. The edge stands at the import's own line,
 * and the dependency's node is the manifest's — never a second declaration.
 *
 * The driver finds the same edges with a pattern over the file's characters;
 * the facts are the file's own declarations, so a mention in a comment or a
 * string is no use of a dependency, and this reading is the one the comparison
 * shows to answer the same edges on the training repository.
 */
export function usesDependencyRecords(file: FileText, manifestPath: string, declared: readonly DeclaredDependency[], imports: readonly { readonly specifier: string; readonly line: number }[], set: RecordSet): void {
  const firstLine = new Map<string, number>();
  for (const holding of imports) {
    const held = firstLine.get(holding.specifier);
    if (held === undefined || holding.line < held) firstLine.set(holding.specifier, holding.line);
  }
  const seen = new Set<string>();
  for (const dependency of declared) {
    if (seen.has(dependency.name)) continue;
    const line = firstLine.get(dependency.name);
    if (line === undefined) continue;
    seen.add(dependency.name);
    set.edge('code.uses-dependency', RecordSet.fileKey(file.path), `code.dependency:${manifestPath}#${dependency.name}`, {}, file.spanOfLine(line));
  }
}


// ---- build: the targets a Makefile offers and the jobs a workflow runs ----

/**
 * One Makefile: the targets it declares with their recipe lines, `.PHONY`'s own
 * list, and the edge to every file a recipe names that the tree holds. A file a
 * recipe names is a path-scoped question the caller answers (`exists`), never a
 * listing of the tree.
 */
export async function makefileRecords(file: FileText, exists: (path: string) => Promise<boolean>): Promise<FileRecords> {
  const set = new RecordSet();
  const phony = new Set<string>();
  const lines = file.lines;
  for (const line of lines) {
    const declared = /^\.PHONY:\s*(.+)$/.exec(line);
    if (declared !== null) for (const name of (declared[1] ?? '').trim().split(/\s+/u)) phony.add(name);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const declared = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?!=)(?:\s+(.*))?$/.exec(line);
    if (declared === null) continue;
    const name = declared[1] ?? '';
    const prerequisites = (declared[2] ?? '').trim();
    const recipe: string[] = [];
    let last = index;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = lines[scan] ?? '';
      if (!candidate.startsWith('\t')) break;
      recipe.push(candidate.slice(1).replace(/^[@-]+/, '').trim());
      last = scan;
    }
    const key = `code.make-target:${file.path}#${name}`;
    const span = file.spanOfLines(index + 1, last + 1);
    const properties: Record<string, unknown> = { phony: phony.has(name), recipe };
    if (prerequisites !== '') properties['prerequisites'] = prerequisites.split(/\s+/u).sort(byCodePoint);
    set.add({ key, kind: 'code.make-target', label: name, properties, span });
    for (const recipeLine of recipe) {
      for (const token of recipeLine.split(/\s+/u)) {
        const candidate = token.replace(/^[^A-Za-z0-9_.]+|[^A-Za-z0-9_.]+$/g, '');
        if (!candidate.includes('/') || candidate.includes('*') || candidate.includes('$')) continue;
        if (!(await exists(candidate))) continue;
        set.edge('code.references', key, RecordSet.fileKey(candidate), {}, span);
      }
    }
    index = last;
  }
  return recordsOf(set);
}


/** One CI workflow: its name, its triggers and one `code.ci-job` per job with the steps and actions it runs. */
export function workflowRecords(file: FileText): FileRecords {
  const set = new RecordSet();
  const lineCounter = new LineCounter();
  const document = parseDocument(file.text, { lineCounter, keepSourceTokens: true });
  for (const error of document.errors) set.gap(file.path, `line ${String(lineCounter.linePos(error.pos[0]).line)}: ${error.message}`);
  if (document.errors.length > 0) return recordsOf(set);
  if (!isMap(document.contents)) {
    set.gap(file.path, 'the file is no mapping: a workflow maps its jobs and triggers');
    return recordsOf(set);
  }
  const name = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value;
  const on = document.contents.items.find((pair) => isScalar(pair.key) && (pair.key.value === 'on' || pair.key.value === true))?.value;
  const triggers: string[] = [];
  if (isSeq(on)) {
    for (const item of on.items) {
      const text = isScalar(item) && item.value !== null ? String(item.value) : null;
      if (text !== null) triggers.push(text);
    }
  } else if (isMap(on)) {
    for (const pair of on.items) if (isScalar(pair.key) && typeof pair.key.value === 'string') triggers.push(pair.key.value);
  }
  const named = isScalar(name) && name.value !== null ? String(name.value) : null;
  const workflowKey = `code.ci-workflow:${file.path}`;
  set.add({
    key: workflowKey,
    kind: 'code.ci-workflow',
    label: named ?? file.path,
    properties: { name: named, on: triggers.sort(byCodePoint) },
    span: file.spanOfFile(),
  });
  const jobs = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'jobs')?.value;
  if (!isMap(jobs)) {
    set.gap(file.path, 'the file declares no jobs mapping');
    return recordsOf(set);
  }
  for (const pair of jobs.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const job = pair.key.value;
    const key = `code.ci-job:${file.path}#${job}`;
    const steps: string[] = [];
    const uses: string[] = [];
    let workingDirectory: string | null = null;
    if (isMap(pair.value)) {
      const defaults = pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'defaults')?.value;
      const defaultRun = isMap(defaults) ? defaults.items.find((item) => isScalar(item.key) && item.key.value === 'run')?.value : undefined;
      const defaultDirectory = isMap(defaultRun) ? defaultRun.items.find((item) => isScalar(item.key) && item.key.value === 'working-directory')?.value : undefined;
      if (isScalar(defaultDirectory) && defaultDirectory.value !== null) workingDirectory = String(defaultDirectory.value);
      const stepList = pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'steps')?.value;
      if (isSeq(stepList)) {
        for (const step of stepList.items) {
          if (!isMap(step)) continue;
          const run = step.items.find((item) => isScalar(item.key) && item.key.value === 'run')?.value;
          if (isScalar(run) && run.value !== null) steps.push(String(run.value));
          const action = step.items.find((item) => isScalar(item.key) && item.key.value === 'uses')?.value;
          if (isScalar(action) && action.value !== null) uses.push(String(action.value));
          const runWith = step.items.find((item) => isScalar(item.key) && item.key.value === 'with')?.value;
          const directory = isMap(runWith) ? runWith.items.find((item) => isScalar(item.key) && item.key.value === 'working-directory')?.value : undefined;
          if (workingDirectory === null && isScalar(directory) && directory.value !== null) workingDirectory = String(directory.value);
        }
      }
    }
    const span = file.spanOfLines(
      lineCounter.linePos(pair.key.range?.[0] ?? 0).line,
      lineCounter.linePos(Math.max(pair.key.range?.[0] ?? 0, (isMap(pair.value) ? pair.value.range?.[1] : pair.key.range?.[1]) ?? 0) - 1).line,
    );
    set.add({ key, kind: 'code.ci-job', label: job, properties: { workingDirectory, steps, uses: [...uses].sort(byCodePoint) }, span });
    set.edge('code.contains-job', workflowKey, key, {}, span);
  }
  return recordsOf(set);
}

// ---- deploy: what a Dockerfile builds, and the process its command starts ----

/** One image built by one Dockerfile: the parts the chain follows. */
export interface DockerfileRead {
  readonly path: string;
  readonly service: string;
  readonly key: string;
  readonly baseImages: readonly string[];
  readonly exposes: readonly number[];
  readonly command: string | null;
  readonly goBinary: string | null;
  readonly goPackage: string | null;
}

/** What one Dockerfile says, in the driver's own words: a file the reader refuses is a gap and no reading. */
export function dockerfileRead(file: FileText, service: string): { readonly read?: DockerfileRead; readonly gap?: RecordGap } {
  const read = readDockerfile(file.text);
  if (!read.ok) return { gap: { path: file.path, reason: `line ${String(read.gap.line)}: ${read.gap.detail}` } };
  const baseImages = read.value.instructions
    .filter((instruction) => instruction.name === 'FROM')
    .map((instruction) => instruction.argument.replace(/\s+AS\s+\S+\s*$/i, '').trim())
    .sort(byCodePoint);
  const exposes = read.value.instructions
    .filter((instruction) => instruction.name === 'EXPOSE')
    .flatMap((instruction) => instruction.argument.split(/\s+/u))
    .map((port) => Number.parseInt(port, 10))
    .filter((port) => Number.isFinite(port))
    .sort((left, right) => left - right);
  const command = read.value.instructions.find((instruction) => instruction.name === 'CMD')?.argument ?? null;
  const goBuild = read.value.instructions
    .map((instruction) => /go\s+build\s+.*?-o\s+(\S+)\s+(\S+)/.exec(instruction.argument))
    .find((match): match is RegExpExecArray => match !== null);
  return {
    read: {
      path: file.path,
      service,
      key: `code.dockerfile:${file.path}`,
      baseImages,
      exposes,
      command,
      goBinary: goBuild === undefined ? null : (goBuild[1]?.split('/').pop() ?? null),
      goPackage: goBuild === undefined ? null : (goBuild[2] ?? null),
    },
  };
}

/**
 * One Dockerfile's records: the node, the ports it exposes and the `exposes`
 * edge to each. The port nodes stand at the whole file, as the driver declares
 * them first, and a port another file of the same reading declared before this
 * one is the node that file published (`published` answers which ports this
 * unit must publish at all).
 */
export function dockerfileRecords(file: FileText, reading: DockerfileRead, published: (port: number) => boolean): FileRecords {
  const set = new RecordSet();
  const span = file.spanOfFile();
  set.add({
    key: reading.key,
    kind: 'code.dockerfile',
    label: reading.path,
    properties: { baseImages: reading.baseImages, exposes: reading.exposes, command: reading.command },
    span,
  });
  for (const port of reading.exposes) {
    const key = `code.port:${reading.service}/${String(port)}`;
    if (published(port)) {
      set.edge('code.exposes', reading.key, key, {}, span);
      continue;
    }
    set.add({ key, kind: 'code.port', label: `${reading.service}/${String(port)}`, properties: { port, service: reading.service }, span });
    set.edge('code.exposes', reading.key, key, {}, span);
  }
  return recordsOf(set);
}

/** The JSON exec form of a CMD/ENTRYPOINT, or the split of its shell form. */
function parseExecForm(argument: string): string[] {
  const trimmed = argument.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      return [];
    }
  }
  return trimmed.split(/\s+/u);
}

/** The process a Dockerfile's command starts, as far as the build names its source. */
export interface StartedProcess {
  readonly key: string;
  readonly binary: string | null;
  readonly source: string | null;
  /** The file whose bytes the process node stands at: the code file the build names. */
  readonly mainFile: string | null;
}

/** The process half of `deploy.ts`'s reading: which file a Dockerfile's command starts, and under which key. */
export async function startedProcessOf(reading: DockerfileRead, exists: (path: string) => Promise<boolean>): Promise<StartedProcess | undefined> {
  if (reading.command === null) return undefined;
  const args = parseExecForm(reading.command);
  const first = args.find((arg) => arg !== 'sh' && arg !== '-c' && arg !== 'node') ?? args[0];
  if (first === undefined) return undefined;
  const script = args.find((arg) => /dist\/[A-Za-z0-9_.-]+\.js$/.test(arg)) ?? null;
  const binary = first.includes('/') && !first.includes(' ') ? first : null;
  let source: string | null = null;
  if (reading.goBinary !== null && reading.goPackage !== null && first.split('/').pop() === reading.goBinary) {
    const dir = reading.goPackage.replace(/^\.\//, '');
    source = `${reading.path.slice(0, reading.path.lastIndexOf('/'))}/${dir}`;
  }
  const nodeScript = script ?? /(?:^|[\s&;])node\s+(dist\/[A-Za-z0-9_.-]+\.js)/.exec(reading.command)?.[1] ?? null;
  if (source === null && nodeScript !== null) {
    const candidate = `${reading.path.slice(0, reading.path.lastIndexOf('/'))}/${nodeScript.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')}`;
    if (await exists(candidate)) source = candidate;
  }
  if (source === null && binary === null) return undefined;
  const mainFile = source !== null && !source.endsWith('.ts') ? `${source}/main.go` : source;
  return { key: `code.process:${source ?? reading.service}`, binary, source, mainFile };
}

/** One process, as the code file that starts it reads it: the command, and the port the file listens on. */
export interface ProcessReading {
  /** The code file the process's node stands at. */
  readonly file: FileText;
  /** The Dockerfile whose command starts it, and whose bytes the `starts` edge cites. */
  readonly dockerfile: FileText;
  readonly reading: DockerfileRead;
  readonly started: StartedProcess;
  readonly listen: { readonly port: number; readonly addr: string; readonly line: number } | undefined;
  /** Whether the port node this process listens on is this unit's to publish. */
  readonly publishPort: boolean;
}

/**
 * One code file that a Dockerfile's command starts: the `code.process` node at
 * the file's own bytes, the `starts` edge from the Dockerfile, and — where the
 * file declares a listen address — the `listens-on` edge to the port's node.
 *
 * The `starts` edge's span stands in the Dockerfile and the `listens-on`
 * edge's in this file, exactly as the driver gives them; both are published by
 * this unit because the process node is the record whose span is this file's,
 * and an edge's ends must exist when its publication runs (decision 0033's
 * per-file units; `src/fill/stages/static-graph.ts` publishes one unit's draft
 * through one transaction).
 */
export function processRecords(input: ProcessReading): FileRecords {
  const set = new RecordSet();
  const { file, dockerfile, reading, started, listen } = input;
  const commandWords = parseExecForm(reading.command ?? '').join(' ');
  set.add({
    key: started.key,
    kind: 'code.process',
    label: commandWords === '' ? started.key.slice(started.key.indexOf(':') + 1) : commandWords,
    properties: { binary: started.binary, command: reading.command },
    span: file.spanOfFile(),
  });
  set.edge('code.starts', reading.key, started.key, { command: reading.command }, dockerfile.spanOfFile());
  if (listen === undefined) return recordsOf(set);
  const span = file.spanOfLine(listen.line);
  const portKey = `code.port:${reading.service}/${String(listen.port)}`;
  if (input.publishPort) set.add({ key: portKey, kind: 'code.port', label: `${reading.service}/${String(listen.port)}`, properties: { port: listen.port, service: reading.service }, span });
  set.edge('code.listens-on', started.key, portKey, { addr: listen.addr }, span);
  return recordsOf(set);
}


// ---- compose: the services one compose file declares ----

/** One variable of one service's environment, as the file binds it. */
interface ComposeVariableRead {
  readonly name: string;
  readonly value: string | null;
  readonly span: RecordSpan;
}

/** One service of a compose file, as the driver's reader resolves it. */
interface ComposeServiceRead {
  readonly name: string;
  readonly line: number;
  readonly image: string | null;
  readonly build: string | { readonly context: string; readonly dockerfile: string } | null;
  readonly ports: readonly string[];
  readonly portMappings: readonly { readonly host: string; readonly container: string }[];
  readonly environment: readonly ComposeVariableRead[];
  readonly envFiles: readonly string[];
  readonly dependsOn: readonly string[];
  readonly healthcheck: {
    readonly test: string | readonly string[] | null;
    readonly interval: string | null;
    readonly timeout: string | null;
    readonly retries: number | null;
    readonly startPeriod: string | null;
    readonly startInterval: string | null;
    readonly disable: boolean | null;
    readonly span: RecordSpan;
  } | null;
}

/** One scalar's text, or null where it states none. */
function scalarTextOf(node: unknown): string | null {
  return isScalar(node) && node.value !== null ? String(node.value) : null;
}

/**
 * The services one compose file declares, resolved through the document's own
 * aliases and merge keys — the driver's reader, one file at a time: a YAML it
 * refuses is a gap naming its line, and a document that is no service mapping
 * is named as what it is.
 */
function composeServicesOf(file: FileText, set: RecordSet, state: { absent?: 'not-mapping' | 'no-services' }): readonly ComposeServiceRead[] {
  const path = file.path;
  const lineCounter = new LineCounter();
  const document = parseDocument(file.text, { lineCounter, keepSourceTokens: true, merge: true });
  for (const error of document.errors) set.gap(path, `line ${String(lineCounter.linePos(error.pos?.[0] ?? 0).line)}: ${error.message}`);
  if (document.errors.length > 0) return [];
  const refuse = (node: unknown): never => {
    const offset = node !== null && typeof node === 'object' && 'range' in node && Array.isArray((node as { range?: unknown[] }).range) && typeof (node as { range: unknown[] }).range[0] === 'number' ? Number((node as { range: number[] }).range[0]) : 0;
    set.gap(path, `line ${String(lineCounter.linePos(offset).line)}: the Compose document contains an unresolved alias, invalid merge or excessive alias expansion`);
    throw new Error('Compose resolution refused');
  };
  type ResolvedPair = { readonly key: unknown; readonly value: unknown; readonly sourceValue: unknown };
  const mappings = new Map<unknown, readonly ResolvedPair[]>();
  const sequences = new Map<unknown, readonly unknown[]>();
  const resolved = new Map<unknown, unknown>();
  const active = new Set<unknown>();
  const resolveNode = (source: unknown): unknown => {
    if (resolved.has(source)) return resolved.get(source);
    if (active.has(source)) return refuse(source);
    active.add(source);
    let result = source;
    if (isAliasNode(source)) {
      let target: unknown;
      try {
        target = (source as { resolve(document: unknown): unknown }).resolve(document);
      } catch {
        return refuse(source);
      }
      if (target === undefined) return refuse(source);
      result = resolveNode(target);
    } else if (isMap(source)) {
      const merged = new Map<unknown, ResolvedPair>();
      const explicit = new Map<unknown, ResolvedPair>();
      for (const pair of source.items) {
        const key = resolveNode(pair.key);
        const value = resolveNode(pair.value);
        const merge = isScalar(key) && typeof key.value === 'symbol' && key.value.description === '<<';
        if (merge) {
          for (const item of isSeq(value) ? sequences.get(value)! : [value]) {
            if (!isMap(item)) return refuse(pair.value);
            for (const entry of mappings.get(item)!) {
              const identity = isScalar(entry.key) ? entry.key.value : entry.key;
              if (!merged.has(identity)) merged.set(identity, entry);
            }
          }
        } else explicit.set(isScalar(key) ? key.value : key, { key, value, sourceValue: pair.value });
      }
      for (const [key, entry] of explicit) merged.set(key, entry);
      mappings.set(source, [...merged.values()]);
    } else if (isSeq(source)) sequences.set(source, source.items.map(resolveNode));
    active.delete(source);
    resolved.set(source, result);
    return result;
  };
  let contents: unknown;
  try {
    document.toJS({ maxAliasCount: 100 });
    contents = resolveNode(document.contents);
  } catch {
    if (set.gaps.length === 0) set.gap(path, 'line 1: the Compose document contains an unresolved alias, invalid merge or excessive alias expansion');
    return [];
  }
  const pairs = (node: unknown): readonly ResolvedPair[] => isMap(node) ? mappings.get(node)! : [];
  const items = (node: unknown): readonly unknown[] => isSeq(node) ? sequences.get(node)! : [];
  const field = (node: unknown, name: string): unknown => pairs(node).find((entry) => isScalar(entry.key) && entry.key.value === name)?.value;
  if (!isMap(contents)) {
    state.absent = 'not-mapping';
    return [];
  }
  const services = field(contents, 'services');
  if (services === undefined) {
    state.absent = 'no-services';
    return [];
  }
  if (!isMap(services)) {
    const key = pairs(contents).find((entry) => isScalar(entry.key) && entry.key.value === 'services')?.key;
    const line = lineCounter.linePos(isScalar(key) ? key.range?.[0] ?? 0 : 0).line;
    set.gap(path, `line ${String(line)}: the file declares no services mapping`);
    return [];
  }
  const read: ComposeServiceRead[] = [];
  for (const pair of pairs(services)) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const name = pair.key.value;
    const serviceTarget = isAliasNode(pair.sourceValue) && pair.value !== null && typeof pair.value === 'object' && 'range' in pair.value && Array.isArray((pair.value as { range?: unknown[] }).range) ? (pair.value as { range: number[] }).range[0] : pair.key.range?.[0];
    const serviceLine = lineCounter.linePos(typeof serviceTarget === 'number' ? serviceTarget : 0).line;
    const image = scalarTextOf(field(pair.value, 'image'));
    let build: ComposeServiceRead['build'] = null;
    const buildNode = field(pair.value, 'build');
    if (isScalar(buildNode) && buildNode.value !== null) build = String(buildNode.value);
    else if (isMap(buildNode)) {
      const context = scalarTextOf(field(buildNode, 'context'));
      const dockerfile = scalarTextOf(field(buildNode, 'dockerfile'));
      if (context !== null) build = { context, dockerfile: dockerfile ?? 'Dockerfile' };
    }
    const ports: string[] = [];
    const portMappings: { host: string; container: string }[] = [];
    const portsNode = field(pair.value, 'ports');
    if (isSeq(portsNode)) {
      for (const item of items(portsNode)) {
        const text = scalarTextOf(item);
        if (text === null) continue;
        ports.push(text);
        const parts = text.split(':');
        const container = parts[parts.length - 1]?.split('/')[0];
        const host = parts[parts.length - 2];
        if (container !== undefined && host !== undefined && /^\d+$/.test(container)) portMappings.push({ host, container });
      }
    }
    const environment: ComposeVariableRead[] = [];
    const envNode = field(pair.value, 'environment');
    if (isMap(envNode)) {
      for (const variable of pairs(envNode)) {
        if (!isScalar(variable.key) || typeof variable.key.value !== 'string') continue;
        const line = lineCounter.linePos(variable.key.range?.[0] ?? 0).line;
        environment.push({ name: variable.key.value, value: scalarTextOf(variable.value), span: file.spanOfLine(line) });
      }
    } else if (isSeq(envNode)) {
      for (const item of items(envNode)) {
        const text = scalarTextOf(item);
        if (text === null) continue;
        const at = text.indexOf('=');
        const variableName = at < 0 ? text : text.slice(0, at);
        const line = lineCounter.linePos((item as { range?: number[] }).range?.[0] ?? 0).line;
        environment.push({ name: variableName, value: at < 0 ? null : text.slice(at + 1), span: file.spanOfLine(line) });
      }
    }
    const envFiles: string[] = [];
    const filesNode = field(pair.value, 'env_file');
    for (const entry of isSeq(filesNode) ? items(filesNode) : filesNode === undefined ? [] : [filesNode]) {
      const named = isMap(entry) ? field(entry, 'path') : entry;
      if (!isScalar(named) || typeof named.value !== 'string') {
        set.gap(path, `line ${String(serviceLine)}: the environment file declaration is unsupported`);
        return [];
      }
      envFiles.push(named.value);
    }
    const dependsOn: string[] = [];
    const dependsNode = field(pair.value, 'depends_on');
    if (isSeq(dependsNode)) {
      for (const item of items(dependsNode)) {
        const text = scalarTextOf(item);
        if (text !== null) dependsOn.push(text);
      }
    } else if (isMap(dependsNode)) {
      for (const item of pairs(dependsNode)) if (isScalar(item.key) && typeof item.key.value === 'string') dependsOn.push(item.key.value);
    }
    const healthPair = isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'healthcheck') : undefined;
    const health = healthPair?.value;
    let healthcheck: ComposeServiceRead['healthcheck'] = null;
    if (isMap(health)) {
      const value = (name: string): unknown => health.items.find((item) => isScalar(item.key) && item.key.value === name)?.value;
      const test = value('test');
      const retries = Number(scalarTextOf(value('retries')) ?? Number.NaN);
      const disabled = scalarTextOf(value('disable'));
      const start = isScalar(healthPair?.key) ? (healthPair?.key.range?.[0] ?? 0) : (health.range?.[0] ?? 0);
      healthcheck = {
        test: isSeq(test) ? test.items.map(scalarTextOf).filter((item): item is string => item !== null) : scalarTextOf(test),
        interval: scalarTextOf(value('interval')),
        timeout: scalarTextOf(value('timeout')),
        retries: Number.isFinite(retries) ? retries : null,
        startPeriod: scalarTextOf(value('start_period')),
        startInterval: scalarTextOf(value('start_interval')),
        disable: disabled === null ? null : disabled === 'true',
        span: file.spanOfLines(lineCounter.linePos(start).line, lineCounter.linePos(Math.max(start, (health.range?.[1] ?? start + 1) - 1)).line),
      };
    }
    environment.sort((left, right) => byCodePoint(left.name, right.name));
    dependsOn.sort(byCodePoint);
    ports.sort(byCodePoint);
    read.push({ name, line: serviceLine, image, build, ports, portMappings, environment, envFiles, dependsOn, healthcheck });
  }
  read.sort((left, right) => byCodePoint(left.name, right.name));
  return read;
}

/** Whether a YAML node is an alias the document resolves (`isAlias` of the yaml package). */
function isAliasNode(node: unknown): boolean {
  return isAlias(node);
}

/**
 * One compose file's records: the service nodes, their health checks, the ports
 * they publish, their `depends_on` edges and the Dockerfiles their builds name.
 * A port another file of this reading declared first is that file's node: this
 * unit names it and publishes no second one (`published` answers which).
 */
export async function composeRecords(file: FileText, published: (service: string, port: number) => Promise<boolean>, exists: (path: string) => Promise<boolean>): Promise<FileRecords> {
  const set = new RecordSet();
  const path = file.path;
  const state: { absent?: 'not-mapping' | 'no-services' } = {};
  const services = composeServicesOf(file, set, state);
  if (state.absent !== undefined) set.gap(path, state.absent === 'not-mapping' ? 'the file is no mapping: a compose file maps service names to their declarations' : 'the file declares no services mapping');
  const root = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  for (const service of services) {
    const key = `code.compose-service:${path}#${service.name}`;
    const span = file.spanOfLine(service.line);
    const buildValue = service.build === null || service.build === ''
      ? null
      : typeof service.build === 'string'
        ? service.build
        : { context: service.build.context, dockerfile: service.build.dockerfile };
    set.add({
      key,
      kind: 'code.compose-service',
      label: service.name,
      properties: {
        image: service.image,
        build: buildValue,
        ports: service.ports,
        environment: service.environment.map((variable) => variable.name),
        dependsOn: service.dependsOn,
      },
      span,
    });
    if (service.healthcheck !== null) {
      const { span: healthSpan, ...healthProperties } = service.healthcheck;
      const healthKey = `code.healthcheck:${path}#${service.name}`;
      set.add({ key: healthKey, kind: 'code.healthcheck', label: `${service.name} healthcheck`, properties: { ...healthProperties, service: service.name }, span: healthSpan });
      set.edge('code.configured-by', key, healthKey, { role: 'healthcheck' }, healthSpan);
    }
    for (const mapping of service.portMappings) {
      const port = Number.parseInt(mapping.container, 10);
      const portKey = `code.port:${service.name}/${String(port)}`;
      if (!(await published(service.name, port))) {
        set.add({ key: portKey, kind: 'code.port', label: `${service.name}/${String(port)}`, properties: { port, service: service.name }, span });
      }
      set.edge('code.publishes', key, portKey, { host: mapping.host, container: mapping.container }, span);
    }
    for (const target of service.dependsOn) set.edge('code.depends-on', key, `code.compose-service:${path}#${target}`, {}, undefined);
    const dockerfile = await composeBuildOf(path, service.build, exists);
    if (dockerfile !== null) set.edge('code.builds', key, `code.dockerfile:${dockerfile}`, {}, span);
    else if (service.build !== null) set.gap(path, `the build of the service ${JSON.stringify(service.name)} names no Dockerfile this tree holds`);
  }
  return recordsOf(set);
}

/** The Dockerfile a compose build declaration names, resolved against the build context and the pinned tree. */
async function composeBuildOf(composePath: string, build: ComposeServiceRead['build'], exists: (path: string) => Promise<boolean>): Promise<string | null> {
  const root = composePath.includes('/') ? composePath.slice(0, composePath.lastIndexOf('/') + 1) : '';
  const candidate = typeof build === 'string'
    ? `${root}${build.replace(/\/$/, '')}/Dockerfile`
    : build === null
      ? null
      : `${root}${build.context.replace(/\/$/, '')}/${build.dockerfile}`;
  if (candidate === null) return null;
  const normalized = candidate.replace(/^\.\//, '');
  return (await exists(normalized)) ? normalized : null;
}

/**
 * The deploy area: what each Dockerfile builds and starts, what each compose
 * service publishes and builds, what each k8s deployment runs and exposes, and
 * the chain between them — deployment, image, process, port — followed as far
 * as the files name each other (the image meets its Dockerfile by name only).
 */
import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { PropertyValue, SourceSpan } from '../records.js';
import { readDockerfile } from '../../fill/stages/manifest-format.js';
import type { Records } from './accumulate.js';
import type { ComposeService } from './compose.js';
import { readComposeFile } from './compose.js';
import { byCodePoint } from '../../model/order.js';
import { serviceOf, TreeText } from './source.js';

/** One image built by one Dockerfile: the parts the chain follows. */
interface DockerfileReading {
  readonly path: string;
  readonly service: string;
  readonly key: string;
  readonly baseImages: string[];
  readonly exposes: number[];
  readonly command: string | null;
  readonly goBinary: string | null;
  readonly goPackage: string | null;
}

/** The Dockerfiles of the tree, read with the shared Dockerfile reader. */
function dockerfiles(t: TreeText, records: Records): DockerfileReading[] {
  const readings: DockerfileReading[] = [];
  for (const path of t.pathsNamed(/^Dockerfile(\.[A-Za-z0-9_-]+)?$/)) {
    const service = serviceOf(path) ?? (path.slice(0, path.lastIndexOf('/')) || '.');
    const read = readDockerfile(t.text(path));
    if (!read.ok) {
      records.gap(path, `line ${read.gap.line}: ${read.gap.detail}`);
      continue;
    }
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
    readings.push({
      path,
      service,
      key: `code.dockerfile:${path}`,
      baseImages,
      exposes,
      command,
      goBinary: goBuild === undefined ? null : (goBuild[1]?.split('/').pop() ?? null),
      goPackage: goBuild === undefined ? null : (goBuild[2] ?? null),
    });
  }
  return readings;
}

function addDockerfileNodes(t: TreeText, records: Records, readings: readonly DockerfileReading[]): void {
  for (const reading of readings) {
    records.add({
      key: reading.key,
      kind: 'code.dockerfile',
      label: reading.path,
      properties: {
        baseImages: reading.baseImages,
        exposes: reading.exposes,
        command: reading.command,
      } satisfies { [key: string]: PropertyValue },
      span: t.spanOfFile(reading.path),
    });
    for (const port of reading.exposes) {
      records.edge('code.exposes', reading.key, records.port(reading.service, port, t.spanOfFile(reading.path)), {}, t.spanOfFile(reading.path));
    }
  }
}

/** The process a Dockerfile's CMD starts, as far as the build names its source. */
function processOf(t: TreeText, reading: DockerfileReading): { key: string; binary: string | null; source: string | null } | undefined {
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
    if (t.has(candidate)) source = candidate;
  }
  if (source === null && binary === null) return undefined;
  return { key: `code.process:${source ?? reading.service}`, binary, source };
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

/** The Go constant or literal a source file's listen address comes from. */
function listenPort(t: TreeText, path: string): { port: number; addr: string; line: number } | undefined {
  const lines = t.lines(path);
  for (const [index, line] of lines.entries()) {
    const constant = /(?:const\s+)?listenAddr\s*=\s*"([^"]+)"/.exec(line) ?? /listenAddr\s*=\s*"([^"]+)"/.exec(line);
    if (constant !== null) {
      const port = Number.parseInt((constant[1] ?? '').replace(/^[:\[]/, ''), 10);
      if (Number.isFinite(port)) return { port, addr: constant[1] ?? '', line: index + 1 };
    }
    const tsConst = /\.listen\(\s*([A-Z][A-Z0-9_]*)\b/.exec(line);
    if (tsConst !== null) {
      const name = tsConst[1] ?? '';
      const declared = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`).exec(t.text(path));
      const port = declared === null ? Number.NaN : Number.parseInt(declared[1] ?? '', 10);
      if (Number.isFinite(port)) return { port, addr: String(port), line: declared === null ? index + 1 : index + 1 };
    }
    const literal = /\.listen\(\s*(\d+)\b/.exec(line);
    if (literal !== null) {
      const port = Number.parseInt(literal[1] ?? '', 10);
      if (Number.isFinite(port)) return { port, addr: literal[1] ?? '', line: index + 1 };
    }
  }
  return undefined;
}

// ---- k8s --------------------------------------------------------------------

interface K8sWorkload {
  readonly kind: string;
  readonly name: string;
  image: string | null;
  replicas: number | null;
  readonly containerPorts: number[];
  readonly probes: { readonly container: string; readonly probeType: string; readonly properties: { readonly [key: string]: PropertyValue }; readonly span: SourceSpan }[];
  readonly envFrom: string[];
  readonly servicePorts: { name: string | null; port: number; targetPort: number | null }[];
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** The workloads and services of the deploy/k8s files, one YAML document each. */
function k8sWorkloads(t: TreeText, records: Records, path: string): K8sWorkload[] {
  const text = t.text(path);
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, { lineCounter, keepSourceTokens: true });
  const workloads: K8sWorkload[] = [];
  for (const document of documents) {
    for (const error of document.errors) {
      records.gap(path, `line ${lineCounter.linePos(error.pos?.[0] ?? 0).line}: ${error.message}`);
    }
    if (!isMap(document.contents)) continue;
    const kind = scalarText0(document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'kind')?.value);
    const metadata = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'metadata')?.value;
    const name = isMap(metadata) ? scalarText0(metadata.items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value) : null;
    if (kind === null || name === null) continue;
    const range = document.range ?? [0, 0, text.length - 1];
    const firstLine = lineCounter.linePos(range[0] ?? 0).line;
    const lastLine = lineCounter.linePos(Math.min((range[2] ?? text.length - 1), text.length - 1)).line;
    const workload: K8sWorkload = {
      kind,
      name,
      image: null,
      replicas: null,
      containerPorts: [],
      probes: [],
      envFrom: [],
      servicePorts: [],
      lineStart: firstLine,
      lineEnd: lastLine,
    };
    if (kind === 'Deployment') {
      const spec = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'spec')?.value;
      if (isMap(spec)) {
        const replicas = scalarText0(spec.items.find((pair) => isScalar(pair.key) && pair.key.value === 'replicas')?.value);
        workload.replicas = replicas === null ? null : Number.parseInt(replicas, 10);
        const template = spec.items.find((pair) => isScalar(pair.key) && pair.key.value === 'template')?.value;
        const podSpec = isMap(template) ? template.items.find((pair) => isScalar(pair.key) && pair.key.value === 'spec')?.value : undefined;
        const containers = isMap(podSpec) ? podSpec.items.find((pair) => isScalar(pair.key) && pair.key.value === 'containers')?.value : undefined;
        if (isSeq(containers)) {
          for (const container of containers.items) {
            if (!isMap(container)) continue;
            const image = scalarText0(container.items.find((pair) => isScalar(pair.key) && pair.key.value === 'image')?.value);
            if (image !== null) workload.image = image;
            const ports = container.items.find((pair) => isScalar(pair.key) && pair.key.value === 'ports')?.value;
            if (isSeq(ports)) {
              for (const port of ports.items) {
                if (!isMap(port)) continue;
                const containerPort = scalarText0(port.items.find((pair) => isScalar(pair.key) && pair.key.value === 'containerPort')?.value);
                const number = containerPort === null ? Number.NaN : Number.parseInt(containerPort, 10);
                if (Number.isFinite(number)) workload.containerPorts.push(number);
              }
            }
            const envFrom = container.items.find((pair) => isScalar(pair.key) && pair.key.value === 'envFrom')?.value;
            if (isSeq(envFrom)) {
              for (const source of envFrom.items) {
                if (!isMap(source)) continue;
                for (const reference of source.items) {
                  if (!isScalar(reference.key) || typeof reference.key.value !== 'string') continue;
                  const inner = isMap(reference.value)
                    ? scalarText0((reference.value as { readonly items: readonly { key: unknown; value: unknown }[] }).items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value)
                    : null;
                  if (inner !== null) workload.envFrom.push(`${reference.key.value}:${inner}`);
                }
              }
            }
            const containerName = scalarText0(container.items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value) ?? String(containers.items.indexOf(container));
            for (const probeName of ['readinessProbe', 'livenessProbe', 'startupProbe']) {
              const pair = container.items.find((item) => isScalar(item.key) && item.key.value === probeName);
              const probe = pair?.value;
              if (!isMap(probe)) continue;
              const value = (key: string): unknown => probe.items.find((item) => isScalar(item.key) && item.key.value === key)?.value;
              const httpGet = value('httpGet');
              const tcp = value('tcpSocket');
              const exec = value('exec');
              const field = (node: unknown, key: string): unknown => isMap(node) ? node.items.find((item) => isScalar(item.key) && item.key.value === key)?.value : undefined;
              const portText = scalarText0(field(httpGet, 'port') ?? field(tcp, 'port'));
              const port = portText !== null && /^\d+$/.test(portText) ? Number(portText) : portText;
              const command = field(exec, 'command');
              const properties: { [key: string]: PropertyValue } = {
                service: name, container: containerName, probeType: probeName,
                transport: isMap(httpGet) ? 'http' : isMap(tcp) ? 'tcp' : isMap(exec) ? 'exec' : null,
                path: scalarText0(field(httpGet, 'path')), port,
                scheme: scalarText0(field(httpGet, 'scheme')),
                command: isSeq(command) ? command.items.map(scalarText0) : null,
              };
              for (const setting of ['initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'successThreshold', 'failureThreshold', 'terminationGracePeriodSeconds']) {
                const raw = scalarText0(value(setting));
                properties[setting] = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
              }
              const start = isScalar(pair?.key) ? pair.key.range?.[0] ?? 0 : probe.range?.[0] ?? 0;
              workload.probes.push({
                container: containerName, probeType: probeName, properties,
                span: t.spanOfLines(path, lineCounter.linePos(start).line, lineCounter.linePos(Math.max(start, (probe.range?.[1] ?? start + 1) - 1)).line),
              });
            }
          }
        }
      }
    }
    if (kind === 'Service') {
      const spec = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'spec')?.value;
      const ports = isMap(spec) ? spec.items.find((pair) => isScalar(pair.key) && pair.key.value === 'ports')?.value : undefined;
      if (isSeq(ports)) {
        for (const port of ports.items) {
          if (!isMap(port)) continue;
          const portName = scalarText0(port.items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value);
          const portNumber = Number.parseInt(scalarText0(port.items.find((pair) => isScalar(pair.key) && pair.key.value === 'port')?.value) ?? '', 10);
          const targetPort = Number.parseInt(scalarText0(port.items.find((pair) => isScalar(pair.key) && pair.key.value === 'targetPort')?.value) ?? '', 10);
          workload.servicePorts.push({
            name: portName,
            port: Number.isFinite(portNumber) ? portNumber : 0,
            targetPort: Number.isFinite(targetPort) ? targetPort : null,
          });
        }
      }
    }
    workloads.push(workload);
  }
  return workloads;
}

function scalarText0(node: unknown): string | null {
  return isScalar(node) && node.value !== null ? String(node.value) : null;
}

// ---- the area ----------------------------------------------------------------

/** The deploy area, over the Dockerfiles, the compose files and the k8s files. */
export function extractDeploy(t: TreeText, records: Records): void {
  const readings = dockerfiles(t, records);
  addDockerfileNodes(t, records, readings);

  const composeFiles = t.pathsNamed(/^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/);
  const composeServices = new Map<string, { path: string; name: string }>();
  for (const path of composeFiles) {
    const services = readComposeFile(t, records, path);
    for (const service of services) {
      const key = `code.compose-service:${path}#${service.name}`;
      composeServices.set(`${path}#${service.name}`, { path, name: service.name });
      const build: PropertyValue =
        service.build === null || service.build === ''
          ? null
          : typeof service.build === 'string'
            ? service.build
            : { context: service.build.context, dockerfile: service.build.dockerfile };
      records.add({
        key,
        kind: 'code.compose-service',
        label: service.name,
        properties: {
          image: service.image,
          build,
          ports: service.ports,
          environment: service.environment.map((variable) => variable.name),
          dependsOn: service.dependsOn,
        } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLine(path, service.line),
      });
      if (service.healthcheck !== null) {
        const { span: healthSpan, ...healthProperties } = service.healthcheck;
        const healthKey = `code.healthcheck:${path}#${service.name}`;
        records.add({ key: healthKey, kind: 'code.healthcheck', label: `${service.name} healthcheck`, properties: { ...healthProperties, service: service.name }, span: healthSpan });
        records.edge('code.probes', healthKey, key, { role: 'service' }, healthSpan);
      }
      for (const mapping of service.portMappings) {
        records.edge(
          'code.publishes',
          key,
          records.port(service.name, Number.parseInt(mapping.container, 10), t.spanOfLine(path, service.line)),
          { host: mapping.host, container: mapping.container },
          t.spanOfLine(path, service.line),
        );
      }
      for (const target of service.dependsOn) {
        records.edge('code.depends-on', key, `code.compose-service:${path}#${target}`);
      }
      const dockerfile = resolveBuild(t, path, service.build);
      if (dockerfile !== null) {
        records.edge('code.builds', key, `code.dockerfile:${dockerfile}`, {}, t.spanOfLine(path, service.line));
      } else if (service.build !== null) {
        records.gap(path, `the build of the service ${JSON.stringify(service.name)} names no Dockerfile this tree holds`);
      }
    }
  }

  for (const path of t.pathsUnder('deploy', /\.ya?ml$/)) {
    for (const workload of k8sWorkloads(t, records, path)) {
      const span = t.spanOfLines(path, workload.lineStart, workload.lineEnd);
      if (workload.kind === 'Deployment') {
        const key = `code.k8s-deployment:${path}#${workload.name}`;
        records.add({
          key,
          kind: 'code.k8s-deployment',
          label: workload.name,
          properties: {
            replicas: workload.replicas,
            image: workload.image,
            containerPorts: [...workload.containerPorts].sort((left, right) => left - right),
            // Preserve the legacy aggregate only when all HTTP probes agree.
            probePath: [...new Set(workload.probes.map((probe) => probe.properties.path).filter((path) => typeof path === 'string'))].length === 1 ? workload.probes.find((probe) => typeof probe.properties.path === 'string')?.properties.path ?? null : null,
            probePaths: workload.probes.map((probe) => probe.properties.path ?? null),
            envFrom: workload.envFrom.sort(byCodePoint),
          } satisfies { [key: string]: PropertyValue },
          span,
        });
        for (const probe of workload.probes) {
          const probeKey = `code.probe:${path}#${workload.name}/${probe.container}/${probe.probeType}`;
          records.add({ key: probeKey, kind: 'code.probe', label: `${workload.name} ${probe.probeType}`, properties: probe.properties, span: probe.span });
          records.edge('code.probes', probeKey, key, { role: 'workload' }, probe.span);
          if (typeof probe.properties.port === 'number') records.edge('code.targets', probeKey, records.port(workload.name, probe.properties.port, probe.span), {}, probe.span);
        }
        if (workload.image !== null) {
          const imageKey = imageNode(records, workload.image, span);
          records.edge('code.runs', key, imageKey, {}, span);
          const imageService = imageServiceName(workload.image) ?? workload.name;
          for (const port of workload.containerPorts) {
            records.edge('code.exposes', key, records.port(imageService, port, span), {}, span);
          }
          const built = builtBy(t, readings, workload.image);
          if (built !== undefined) records.edge('code.built-by', imageKey, `code.dockerfile:${built}`, { matchedBy: 'name' }, span);
        }
      }
      if (workload.kind === 'Service') {
        const key = `code.k8s-service:${path}#${workload.name}`;
        records.add({
          key,
          kind: 'code.k8s-service',
          label: workload.name,
          properties: {
            ports: workload.servicePorts.map((port) => ({ name: port.name, port: port.port, targetPort: port.targetPort })),
          } satisfies { [key: string]: PropertyValue },
          span,
        });
        for (const port of workload.servicePorts) {
          if (port.targetPort === null) continue;
          records.edge('code.targets', key, records.port(workload.name, port.targetPort, span), { port: port.port }, span);
        }
      }
    }
  }

  // The processes: what each image's command starts, and the port it listens on.
  for (const reading of readings) {
    const started = processOf(t, reading);
    if (started === undefined) continue;
    const mainFile = started.source !== null && !started.source.endsWith('.ts') ? `${started.source}/main.go` : started.source;
    records.add({
      key: started.key,
      kind: 'code.process',
      label: started.key.slice(started.key.indexOf(':') + 1),
      properties: { binary: started.binary, command: reading.command } satisfies { [key: string]: PropertyValue },
      span: mainFile !== null && t.has(mainFile) ? t.spanOfFile(mainFile) : t.spanOfFile(reading.path),
    });
    records.edge('code.starts', reading.key, started.key, { command: reading.command }, t.spanOfFile(reading.path));
    if (mainFile === null || !t.has(mainFile)) continue;
    const listened = listenPort(t, mainFile);
    if (listened === undefined) continue;
    const portSpan = t.spanOfLine(mainFile, listened.line);
    records.edge('code.listens-on', started.key, records.port(reading.service, listened.port, portSpan), { addr: listened.addr }, portSpan);
  }
}

/** The Dockerfile a compose build declaration names, resolved against the build context. */
function resolveBuild(t: TreeText, composePath: string, build: ComposeServiceBuild): string | null {
  const root = composePath.includes('/') ? composePath.slice(0, composePath.lastIndexOf('/') + 1) : '';
  const candidate =
    typeof build === 'string'
      ? `${root}${build.replace(/\/$/, '')}/Dockerfile`
      : build === null
        ? null
        : `${root}${build.context.replace(/\/$/, '')}/${build.dockerfile}`;
  if (candidate === null) return null;
  const normalized = candidate.replace(/^\.\//, '');
  return t.has(normalized) ? normalized : null;
}
type ComposeServiceBuild = string | { readonly context: string; readonly dockerfile: string } | null;

/** The image node of one image reference, made on first use, with the place the deployment names it. */
function imageNode(records: Records, reference: string, span?: SourceSpan): string {
  const key = `code.image:${reference}`;
  const colon = reference.lastIndexOf(':');
  const slash = reference.lastIndexOf('/');
  const tag = colon > slash ? reference.slice(colon + 1) : null;
  const repository = tag === null ? reference : reference.slice(0, colon);
  records.add({
    key,
    kind: 'code.image',
    label: reference,
    properties: { repository, tag },
    ...(span === undefined ? {} : { span }),
  });
  return key;
}

/** The service an image reference names: the last path segment of its repository. */
function imageServiceName(reference: string): string | undefined {
  const colon = reference.lastIndexOf(':');
  const slash = reference.lastIndexOf('/');
  const repository = colon > slash ? reference.slice(0, colon) : reference;
  return repository.split('/').pop();
}

/** The Dockerfile an image was built by, matched by name only. */
function builtBy(t: TreeText, readings: readonly DockerfileReading[], reference: string): string | undefined {
  const service = imageServiceName(reference);
  if (service === undefined) return undefined;
  const match = readings.find((reading) => reading.service === service);
  if (match === undefined) return undefined;
  return t.has(match.path) ? match.path : undefined;
}

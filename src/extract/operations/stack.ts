/**
 * The stack passport: language, frameworks, infrastructure and tests of each
 * service, read from its manifest and its imports. The passport is one node
 * per service; its manifest is the edge that declares it.
 */
import type { PropertyValue } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type { Records } from './accumulate.js';
import type { EnvRead } from './env.js';
import { TreeText } from './source.js';

/** The Go imports a passport names: standard library packages the service runs on. */
const GO_STDLIB_FRAMEWORKS: readonly string[] = ['database/sql', 'net/http'];

/** The stack passport of every service that holds a manifest. */
export function extractStack(t: TreeText, records: Records, envReads: ReadonlyMap<string, readonly EnvRead[]>): void {
  const services = new Set<string>();
  for (const path of t.tree.paths) {
    const match = /^services\/([^/]+)\//.exec(path);
    if (match?.[1] !== undefined) services.add(match[1]);
  }
  for (const service of [...services].sort(byCodePoint)) {
    const prefix = `services/${service}/`;
    const goMod = `${prefix}go.mod`;
    const packageJson = `${prefix}package.json`;
    const manifestPath = t.has(goMod) ? goMod : t.has(packageJson) ? packageJson : null;
    if (manifestPath === null) continue;
    const go = manifestPath === goMod;
    const frameworks = new Set<string>();
    let testFramework: string | null = null;
    if (go) {
      const imports = new Set<string>();
      for (const path of t.tree.paths) {
        if (!path.startsWith(prefix) || !path.endsWith('.go')) continue;
        for (const match of t.text(path).matchAll(/"([a-z0-9_./-]+)"/g)) {
          const imported = match[1];
          if (imported !== undefined) imports.add(imported);
        }
      }
      for (const stdlib of GO_STDLIB_FRAMEWORKS) {
        if (imports.has(stdlib)) frameworks.add(stdlib);
      }
      // The frameworks a passport names: the standard library packages above
      // and the module's own direct requirements, never every dotted string.
      for (const line of t.lines(goMod)) {
        const required = /^\s*(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?\s*$/.exec(line) ?? /^require\s+(\S+)\s+(v\S+)/.exec(line);
        if (required === null) continue;
        if (required[3] !== undefined) continue;
        frameworks.add(required[1] ?? '');
      }
      frameworks.delete('');
      testFramework = t.tree.paths.some((path) => path.startsWith(prefix) && path.endsWith('_test.go')) ? 'go test' : null;
    } else {
      const declared = /^(\s*)"(dependencies|devDependencies)":\s*\{/gm;
      const text = t.text(packageJson);
      const manifest = JSON.parse(text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      for (const name of Object.keys(manifest.dependencies ?? {})) frameworks.add(name);
      if (manifest.devDependencies?.['jest'] !== undefined) testFramework = 'jest';
      void declared;
    }
    const infrastructure: string[] = [];
    if ([...envReads.keys()].some((variable) => variable.startsWith(`${service}/`) && variable.endsWith('/DATABASE_URL'))) infrastructure.push('Postgres');
    if ([...envReads.keys()].some((variable) => variable.startsWith(`${service}/`) && variable.endsWith('/KAFKA_BROKERS'))) infrastructure.push('Kafka');
    infrastructure.sort(byCodePoint);
    const manifestNode = `code.manifest:${manifestPath}`;
    records.add({
      key: `code.service:${service}`,
      kind: 'code.service',
      label: service,
      properties: {
        language: go ? 'go' : 'typescript',
        frameworks: [...frameworks].sort(byCodePoint),
        infrastructure,
        testFramework,
      } satisfies { [key: string]: PropertyValue },
      span: t.spanOfFile(manifestPath),
    });
    if (records.nodes.some((entry) => entry.key === manifestNode)) {
      records.edge('code.manifest-of', manifestNode, `code.service:${service}`, {}, t.spanOfFile(manifestPath));
    }
  }
}

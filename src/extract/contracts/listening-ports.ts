/**
 * The ports a code file's servers listen on, by the one rule the contracts
 * extractor and the fill's code-facts stage share (madarch-8bdc.2.4): a Go
 * `http.Server`'s `Addr`, the constant it names where it names one, and the
 * port the address carries; a TypeScript app's `listen` port, and the port a
 * top-level listen starts with. The rule stands here once, so the per-file
 * port fact the fill publishes and the driver's `portsByService` map cannot
 * disagree about what a file listens on.
 *
 * The readers (`readGoFile`, `readTsFile`) own what a file states; this module
 * only picks the ports out of their answer, in code point order.
 */
import {byCodePoint} from '../../model/order.js';
import type {GoFileFacts} from './go-code.js';
import type {TsFileFacts} from './ts-code.js';

/** The port a listen address carries: `:8080`, `localhost:8080`, `[::1]:8080`. */
const ADDRESS_PORT = /:(\d+)\b/u;

/** A value that is a port as written: decimal digits and nothing else. */
const DECIMAL_DIGITS = /^\d+$/u;

/** The ports a Go file's `http.Server` values listen on, each Addr read through the file's constants. */
export function goListeningPorts(go: GoFileFacts): readonly string[] {
  const ports = new Set<string>();
  for (const addr of go.serverAddrs.values()) {
    const literal = go.consts.get(addr) ?? addr;
    const port = ADDRESS_PORT.exec(literal)?.[1];
    if (port !== undefined) ports.add(port);
  }
  return [...ports].sort(byCodePoint);
}

/** The ports a TypeScript file's app listens on, and the ports its top-level listens start with. */
export function tsListeningPorts(ts: TsFileFacts): readonly string[] {
  const ports = new Set<string>(ts.listenerPorts);
  for (const start of ts.started) {
    if (start.kind === 'http-server' && start.port !== undefined && DECIMAL_DIGITS.test(start.port)) ports.add(start.port);
  }
  return [...ports].sort(byCodePoint);
}

/** One code file's facts, as either reader answers them: the path and the grammar's own facts. */
export type CodeFilePortFacts = {readonly path: string; readonly go: GoFileFacts} | {readonly path: string; readonly ts: TsFileFacts};

/**
 * The ports of every code file, by the service its path belongs to: the map the
 * contracts extractor links an operation's servers through. A file outside every
 * declared unit belongs to no service and contributes no port, and a service
 * whose files listen on nothing keeps an empty set, exactly as the extractor
 * built the map before this rule stood here.
 */
export function portsByServiceOf(files: readonly CodeFilePortFacts[], serviceOf: (path: string) => string | undefined): Map<string, Set<string>> {
  const byService = new Map<string, Set<string>>();
  for (const file of files) {
    const service = serviceOf(file.path);
    if (service === undefined) continue;
    const ports = byService.get(service) ?? new Set<string>();
    for (const port of 'go' in file ? goListeningPorts(file.go) : tsListeningPorts(file.ts)) ports.add(port);
    byService.set(service, ports);
  }
  return byService;
}

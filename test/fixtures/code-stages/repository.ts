/**
 * The repository the code stages' acceptance tests generate (madarch-8bdc.2.4):
 * one code repository of a handful of files the test writes itself, and no
 * outside checkout. `services/orders/internal/domain/order.go` writes a Go
 * transition table of constant states, `services/orders/src/state.ts` writes a
 * TypeScript table, and a document and a data file hold no table at all.
 *
 * The expected machines are `expectedMachinesOf`'s own answer — the generator,
 * not the code under test, says which states and which moves the stage must
 * publish — and `writeProduct` wires the repository into a product the fill can
 * run on, as `madarch repo add` does: by a link under `repos/`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFirstFillWorkflow } from '../../fill-workflow-fixture.js';

/** One state of a machine the stage must publish: its name, its label and the line it stands on. */
export interface ExpectedState {
  readonly name: string;
  readonly label: string;
  readonly line: number;
}

/** One move the stage must publish, from the state it leaves to the state it enters. */
export interface ExpectedTransition {
  readonly from: string;
  readonly to: string;
  readonly event: string | null;
  readonly line: number;
}

/** One machine the stage must publish: the file it stands in, its name and what it holds. */
export interface ExpectedMachine {
  readonly file: string;
  readonly name: string;
  readonly type: string | null;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly states: readonly ExpectedState[];
  readonly transitions: readonly ExpectedTransition[];
}

/** The Go file of the fixture: a table of constant states, so a state's label is the string its constant holds. */
export const GO_FILE = 'services/orders/internal/domain/order.go';

/** The TypeScript file of the fixture: two names a reader sees, and one table of adjacency lists. */
export const TS_FILE = 'services/orders/src/state.ts';

/** The TypeScript file whose code facts the acceptance reads: a value from the environment, and a call. */
export const CONFIG_FILE = 'services/orders/src/config.ts';

/** The logger module: the library model's own declaration, `pino(...)`. */
export const LOGGER_FILE = 'services/orders/src/logging/logger.ts';

/** The file that uses the logger: the import chain a library effect is proved through. */
export const APP_FILE = 'services/orders/src/app.ts';

/** The Go file's bytes, as the fixture writes them. */
export function goText(): string {
  return [
    'package domain',
    '',
    '// Status is the state an order stands in.',
    'type Status string',
    '',
    'const (',
    '\tPending   Status = "pending"',
    '\tConfirmed Status = "confirmed"',
    '\tShipped   Status = "shipped"',
    ')',
    '',
    '// Event is what moves an order.',
    'type Event string',
    '',
    'const (',
    '\tCaptured Event = "captured"',
    '\tHanded   Event = "handed"',
    ')',
    '',
    '// transitions says which event moves an order where.',
    'var transitions = map[Status]map[Event]Status{',
    '\tPending: {Captured: Confirmed},',
    '\tConfirmed: {Handed: Shipped},',
    '}',
    '',
  ].join('\n');
}

/** The TypeScript file's bytes: an adjacency table of the states an order may enter. */
export function tsText(): string {
  return [
    'export type OrderState = "new" | "paid" | "sent";',
    '',
    '// The moves a payment accepts, as the checkout screen offers them.',
    'export const transitions: Record<OrderState, OrderState[]> = {',
    '  new: ["paid"],',
    '  paid: ["sent"],',
    '};',
    '',
  ].join('\n');
}

/** The configuration file's bytes: an environment read with a default, a call, and a string argument. */
export function configText(): string {
  return [
    'export const port = Number(process.env.PORT ?? "8080");',
    '',
    'export function label(): string {',
    '  return prefix("orders");',
    '}',
    '',
    'function prefix(name: string): string {',
    '  return `svc-${name}`;',
    '}',
    '',
  ].join('\n');
}

/** The logger module's bytes: pino's own default export, held by a named constant. */
export function loggerText(): string {
  return [
    'import pino from "pino";',
    '',
    'export const logger = pino({ level: "info" });',
    '',
  ].join('\n');
}

/** The using file's bytes: a named import of the logger, and one call of it. */
export function appText(): string {
  return [
    'import { logger } from "./logging/logger.js";',
    '',
    'export function record(order: string): void {',
    '  logger.info({ order }, "created");',
    '}',
    '',
  ].join('\n');
}

/**
 * Every machine the stage must publish for the fixture, in code point order of
 * the files: the Go table first (`services/orders/internal/...` sorts before
 * `services/orders/src/...`), each with the states and the moves the bytes say.
 */
export function expectedMachinesOf(): readonly ExpectedMachine[] {
  return [
    {
      file: GO_FILE,
      name: 'transitions',
      type: 'Status',
      lineStart: 21,
      lineEnd: 24,
      states: [
        { name: 'Pending', label: 'pending', line: 22 },
        { name: 'Confirmed', label: 'confirmed', line: 22 },
        { name: 'Shipped', label: 'shipped', line: 23 },
      ],
      transitions: [
        { from: 'Pending', to: 'Confirmed', event: 'captured', line: 22 },
        { from: 'Confirmed', to: 'Shipped', event: 'handed', line: 23 },
      ],
    },
    {
      file: TS_FILE,
      name: 'transitions',
      type: null,
      lineStart: 4,
      lineEnd: 7,
      states: [
        { name: 'new', label: 'new', line: 5 },
        { name: 'paid', label: 'paid', line: 5 },
        { name: 'sent', label: 'sent', line: 6 },
      ],
      transitions: [
        { from: 'new', to: 'paid', event: null, line: 5 },
        { from: 'paid', to: 'sent', event: null, line: 6 },
      ],
    },
  ];
}

/** One git call in the generated repository, with the fixed identity and date every commit of it carries. */
function git(folder: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: folder,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Code Fixture',
      GIT_AUTHOR_EMAIL: 'code@example.invalid',
      GIT_COMMITTER_NAME: 'Code Fixture',
      GIT_COMMITTER_EMAIL: 'code@example.invalid',
      GIT_AUTHOR_DATE: '2024-03-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-03-01T00:00:00Z',
    },
  }).trim();
}

/** Writes the fixture repository into `folder` and commits it, answering the commit it stands on. */
export function writeRepository(folder: string, extraFiles: Readonly<Record<string, string>> = {}): string {
  mkdirSync(folder, { recursive: true });
  git(folder, ['init', '-q', '-b', 'main']);
  git(folder, ['config', 'user.name', 'Code Fixture']);
  git(folder, ['config', 'user.email', 'code@example.invalid']);
  const files: readonly { readonly path: string; readonly text: string }[] = [
    { path: GO_FILE, text: goText() },
    { path: TS_FILE, text: tsText() },
    { path: CONFIG_FILE, text: configText() },
    { path: LOGGER_FILE, text: loggerText() },
    { path: APP_FILE, text: appText() },
    { path: 'README.md', text: '# Orders\n\nA shop that sells things.\n' },
    { path: 'data/orders.csv', text: 'id,total\n1,10\n' },
  ];
  for (const file of [...files, ...Object.entries(extraFiles).map(([path, text]) => ({ path, text }))]) {
    mkdirSync(join(folder, file.path, '..'), { recursive: true });
    writeFileSync(join(folder, file.path), file.text);
  }
  git(folder, ['add', '-A']);
  git(folder, ['commit', '-qm', 'the repository of the code stages']);
  return git(folder, ['rev-parse', 'HEAD']);
}

/** The product the fill runs on: one code repository connected under `repos/`, and the product repository itself. */
export function writeProduct(root: string, extraFiles: Readonly<Record<string, string>> = {}): { readonly product: string; readonly repository: string; readonly repositoryName: string } {
  const product = join(root, 'product');
  const repository = join(root, 'shop');
  const repositoryName = 'shop';
  writeRepository(repository, extraFiles);
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', repositoryName), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 5b0f1c3e-2d44-4a91-9f60-0c7a1e8b2d55',
    'name: shop-product',
    'repos:',
    `  - name: ${repositoryName}`,
    '    url: file:///shop',
    '',
  ].join('\n'));
  writeFirstFillWorkflow(product);
  git(product, ['init', '-q', '-b', 'main']);
  git(product, ['config', 'user.name', 'Code Fixture']);
  git(product, ['config', 'user.email', 'code@example.invalid']);
  git(product, ['add', '-A']);
  git(product, ['commit', '-qm', 'the product of the shop']);
  return { product, repository, repositoryName };
}

/**
 * Builds the two skill fixture repositories (madarch-utk.2.2) the agent
 * skill is proven on: one whose architecture document went stale when
 * the code replaced its config module with a settings folder, one whose
 * notify package no document mentions. Runnable as
 * `bun test/skill-fixtures/build.ts <folder>` and importable by tests.
 * The commits carry one fixed author and fixed moments, so the same run
 * gives the same commit hashes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gitEnv } from '../git-env.js';

/** The two repository paths the builder wrote. */
export interface SkillFixtures {
  /** The repository whose architecture document names the removed config module. */
  staleDocument: string;
  /** The repository whose notify package no document mentions. */
  undocumentedPackage: string;
}

/** The committer the fixture commits carry, passed with -c so the machine's own git config cannot leak in. */
const GIT_IDENTITY = [
  '-c', 'user.name=Skill Fixtures',
  '-c', 'user.email=fixtures@example.com',
  '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main',
];

/** The moment of the first commit, 2026-09-01T10:00:00+0000; every later commit is one hour later. */
const FIRST_COMMIT_INSTANT = 1_788_256_800;

/** The hour between two fixture commits, in seconds. */
const COMMIT_STEP = 3_600;

/** One tiny git repository built commit by commit, each at its own fixed moment. */
class FixtureRepo {
  readonly path: string;
  private commits = 0;

  constructor(path: string) {
    this.path = path;
    mkdirSync(path, { recursive: true });
    this.run(['init', '--quiet']);
  }

  write(file: string, content: string): void {
    mkdirSync(dirname(join(this.path, file)), { recursive: true });
    writeFileSync(join(this.path, file), content);
  }

  /** Stages everything and commits at the repository's next fixed moment; returns the new HEAD. */
  commit(message: string): string {
    this.run(['add', '-A']);
    this.run(['commit', '--quiet', '-m', message]);
    const head = this.run(['rev-parse', 'HEAD']);
    this.commits += 1;
    return head.stdout.trim();
  }

  private run(args: string[]): { stdout: string } {
    const instant = FIRST_COMMIT_INSTANT + this.commits * COMMIT_STEP;
    const run = spawnSync('git', [...GIT_IDENTITY, ...args], {
      cwd: this.path,
      encoding: 'utf8',
      env: gitEnv({
        GIT_AUTHOR_NAME: 'Skill Fixtures',
        GIT_AUTHOR_EMAIL: 'fixtures@example.com',
        GIT_COMMITTER_NAME: 'Skill Fixtures',
        GIT_COMMITTER_EMAIL: 'fixtures@example.com',
        GIT_AUTHOR_DATE: `${instant} +0000`,
        GIT_COMMITTER_DATE: `${instant} +0000`,
      }),
    });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${this.path}: ${run.stderr}`);
    return { stdout: run.stdout ?? '' };
  }
}

/**
 * Builds both fixture repositories under `folder`, which must be missing
 * or empty: the builder never overwrites, it refuses instead.
 */
export function buildSkillFixtures(folder: string): SkillFixtures {
  const root = resolve(folder);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`refusing to build the skill fixtures into ${root}: the folder is not empty`);
  }
  mkdirSync(root, { recursive: true });
  return {
    staleDocument: buildStaleDocument(join(root, 'stale-document')),
    undocumentedPackage: buildUndocumentedPackage(join(root, 'undocumented-package')),
  };
}

/**
 * The shelf service: its first commit writes docs/architecture.md naming
 * the config module; a later commit replaces src/config/ with a
 * src/settings/ folder and leaves the document behind.
 */
function buildStaleDocument(path: string): string {
  const repo = new FixtureRepo(path);
  repo.write('README.md', SHELF_README);
  repo.write('package.json', SHELF_PACKAGE_JSON);
  repo.write('tsconfig.json', TSCONFIG_JSON);
  repo.write('.gitignore', GITIGNORE);
  repo.write('docs/architecture.md', SHELF_ARCHITECTURE);
  repo.write('src/core.ts', SHELF_CORE_WITH_CONFIG);
  repo.write('src/router.ts', SHELF_ROUTER);
  repo.write('src/store.ts', SHELF_STORE);
  repo.write('src/handlers/books.ts', SHELF_BOOKS_HANDLER);
  repo.write('src/config/index.ts', SETTINGS_INDEX);
  repo.write('src/config/loader.ts', SETTINGS_LOADER);
  repo.commit('Add the shelf service');

  repo.write('docs/decisions/0001-replace-the-config-module-with-a-settings-folder.md', SHELF_DECISION);
  repo.commit('Decide to replace the config module with a settings folder');

  rmSync(join(repo.path, 'src/config'), { recursive: true, force: true });
  repo.write('src/settings/index.ts', SETTINGS_INDEX);
  repo.write('src/settings/loader.ts', SETTINGS_LOADER);
  repo.write('src/core.ts', SHELF_CORE_WITH_SETTINGS);
  repo.commit('Replace the config module with a settings folder');
  return repo.path;
}

/**
 * The ledger service: its documents describe every module except
 * src/notify/, which a later commit adds and the core imports.
 */
function buildUndocumentedPackage(path: string): string {
  const repo = new FixtureRepo(path);
  repo.write('README.md', LEDGER_README_START);
  repo.write('package.json', LEDGER_PACKAGE_JSON);
  repo.write('tsconfig.json', TSCONFIG_JSON);
  repo.write('.gitignore', GITIGNORE);
  repo.write('docs/architecture.md', LEDGER_ARCHITECTURE);
  repo.write('src/core.ts', LEDGER_CORE_FIRST);
  repo.write('src/router.ts', LEDGER_ROUTER);
  repo.write('src/store.ts', LEDGER_STORE);
  repo.write('src/handlers/entries.ts', LEDGER_ENTRIES_HANDLER);
  repo.commit('Add the ledger service');

  repo.write('docs/decisions/0001-keep-the-journal-in-memory.md', LEDGER_DECISION);
  repo.commit('Decide to keep the journal in memory');

  repo.write('src/notify/index.ts', NOTIFY_INDEX);
  repo.write('src/notify/templates.ts', NOTIFY_TEMPLATES);
  repo.write('src/core.ts', LEDGER_CORE_WITH_NOTIFY);
  repo.write('README.md', LEDGER_README_AT_HEAD);
  repo.commit('Record entries over POST and tell the webhook');
  return repo.path;
}

/** Runs the builder from the command line: `bun test/skill-fixtures/build.ts <folder>`. */
function main(argv: readonly string[]): void {
  if (argv.length !== 1) {
    console.error('usage: bun test/skill-fixtures/build.ts <folder>');
    process.exitCode = 1;
    return;
  }
  try {
    const fixtures = buildSkillFixtures(argv[0]!);
    console.log(fixtures.staleDocument);
    console.log(fixtures.undocumentedPackage);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

// --- The shelf service -------------------------------------------------

const SHELF_README = `# Shelf

A tiny HTTP service that keeps a register of books and answers one
endpoint with it. How the parts fit together is written down in
\`docs/architecture.md\`; the decisions it grew from are under
\`docs/decisions/\`.

Run it with \`bun src/core.ts\`.
`;

const SHELF_PACKAGE_JSON = `{
  "name": "shelf",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun src/core.ts"
  }
}
`;

const SHELF_ARCHITECTURE = `# Architecture

Shelf is a small HTTP service that keeps a register of books. It has
five parts.

## Core

\`src/core.ts\` wires the parts together: it builds the store, reads the
settings and hands the router its handler. Starting the service means
running this module.

## Router

\`src/router.ts\` holds the HTTP router. It registers the service's one
endpoint, \`GET /books\`, and hands every request to the handler the core
gave it.

## Store

\`src/store.ts\` is the book store. It is the only module that touches
storage; every other part goes through it.

## Handlers

\`src/handlers/books.ts\` answers \`GET /books\`: it asks the store for the
books and shapes the reply.

## Config

The config module (\`src/config/\`) holds the service's settings.
\`src/config/index.ts\` gathers them once; \`src/config/loader.ts\` reads
them from the environment and fills in the defaults.
`;

const SHELF_DECISION = `# 0001 — Replace the config module with a settings folder

Status: accepted

## Context

The config module no longer only gathers the service's settings: it has
taken on validating them and filling in their defaults, and the name no
longer says what it is.

## Decision

\`src/config/\` becomes a folder \`src/settings/\`. The settings themselves
move to \`src/settings/index.ts\`, the loader to \`src/settings/loader.ts\`.
The core changes its import in the same commit; nothing else changes.

## Consequences

The import paths change for the core. The shape of the settings stays
the same.
`;

const SHELF_ROUTER = `type Handler = (request: Request) => Response;

/** The HTTP router: it registers the service's endpoints and dispatches to them. */
export class Router {
  private readonly routes: Record<string, Handler> = {};

  get(path: string, handler: Handler): void {
    this.routes[\`GET \${path}\`] = handler;
  }

  handle(request: Request): Response {
    const handler = this.routes[\`\${request.method} \${new URL(request.url).pathname}\`];
    if (handler === undefined) return new Response('not found\\n', { status: 404 });
    return handler(request);
  }

  /** Starts listening; every request the service receives is dispatched through handle. */
  listen(port: number): void {
    Bun.serve({ port, fetch: (request) => this.handle(request) });
  }
}
`;

const SHELF_STORE = `export interface Book {
  title: string;
  author: string;
}

/** The book store: the only module that touches storage. */
export class BookStore {
  private readonly books: Book[] = [
    { title: 'A Pattern of Islands', author: 'Arthur Grimble' },
  ];

  /** Every book the register holds. */
  all(): readonly Book[] {
    return this.books;
  }
}
`;

const SHELF_BOOKS_HANDLER = `import type { BookStore } from '../store.js';

/** Answers GET /books with every book the register holds. */
export function booksHandler(store: BookStore): (request: Request) => Response {
  return () => Response.json({ books: store.all() });
}
`;

const SETTINGS_LOADER = `export interface Settings {
  /** The port the service listens on. */
  port: number;
}

/** Reads the settings from the environment, filling in the defaults. */
export function load(env: Record<string, string | undefined>): Settings {
  return { port: Number(env['SHELF_PORT'] ?? '3000') };
}
`;

const SETTINGS_INDEX = `import { load } from './loader.js';

export type { Settings } from './loader.js';

/** The service's settings, read once when the module loads. */
export const settings = load(process.env);
`;

const SHELF_CORE_WITH_CONFIG = `import { booksHandler } from './handlers/books.js';
import { settings } from './config/index.js';
import { BookStore } from './store.js';
import { Router } from './router.js';

const store = new BookStore();
const router = new Router();

router.get('/books', booksHandler(store));

/** Starts the service on the configured port. */
export function start(): void {
  router.listen(settings.port);
}

start();
`;

const SHELF_CORE_WITH_SETTINGS = SHELF_CORE_WITH_CONFIG.replace("'./config/index.js'", "'./settings/index.js'");

// --- The ledger service ------------------------------------------------

const LEDGER_README_START = `# Ledger

A tiny HTTP service that keeps a journal of entries and answers with
the entries it holds. How the parts fit together is written down in
\`docs/architecture.md\`; the decisions it grew from are under
\`docs/decisions/\`.

Run it with \`bun src/core.ts\`.
`;

const LEDGER_README_AT_HEAD = `# Ledger

A tiny HTTP service that keeps a journal of entries and answers with
the entries it holds. New entries are recorded over \`POST /entries\`.
How the parts fit together is written down in \`docs/architecture.md\`;
the decisions it grew from are under \`docs/decisions/\`.

Run it with \`bun src/core.ts\`.
`;

const LEDGER_PACKAGE_JSON = `{
  "name": "ledger",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun src/core.ts"
  }
}
`;

const LEDGER_ARCHITECTURE = `# Architecture

Ledger is a small HTTP service that keeps a journal of entries. It has
four parts.

## Core

\`src/core.ts\` wires the parts together: it builds the store, hands the
router its handlers and starts the service. Recording an entry goes
through this module.

## Router

\`src/router.ts\` holds the HTTP router. It registers the service's
endpoints and hands every request to the handler the core gave it.

## Store

\`src/store.ts\` is the entry store. It is the only module that touches
storage; every other part goes through it.

## Handlers

\`src/handlers/entries.ts\` answers \`GET /entries\`: it asks the store for
the entries and shapes the reply.
`;

const LEDGER_DECISION = `# 0001 — Keep the journal in memory

Status: accepted

## Context

The journal only ever holds the entries of one run, and losing it when
the service stops costs nothing.

## Decision

The store keeps the journal in memory. There is no file, no database
and no configuration for storage.

## Consequences

Restarting the service starts from an empty journal.
`;

const LEDGER_ROUTER = `type Handler = (request: Request) => Response | Promise<Response>;

/** The HTTP router: it registers the service's endpoints and dispatches to them. */
export class Router {
  private readonly routes: Record<string, Handler> = {};

  get(path: string, handler: Handler): void {
    this.routes[\`GET \${path}\`] = handler;
  }

  post(path: string, handler: Handler): void {
    this.routes[\`POST \${path}\`] = handler;
  }

  handle(request: Request): Response | Promise<Response> {
    const handler = this.routes[\`\${request.method} \${new URL(request.url).pathname}\`];
    if (handler === undefined) return new Response('not found\\n', { status: 404 });
    return handler(request);
  }

  /** Starts listening; every request the service receives is dispatched through handle. */
  listen(port: number): void {
    Bun.serve({ port, fetch: (request) => this.handle(request) });
  }
}
`;

const LEDGER_STORE = `export interface Entry {
  what: string;
  amount: number;
}

/** The entry store: the only module that touches storage. */
export class EntryStore {
  private readonly entries: Entry[] = [];

  /** Every entry the journal holds. */
  all(): readonly Entry[] {
    return this.entries;
  }

  /** Records one entry in the journal. */
  add(entry: Entry): void {
    this.entries.push(entry);
  }
}
`;

const LEDGER_ENTRIES_HANDLER = `import type { EntryStore } from '../store.js';

/** Answers GET /entries with every entry the journal holds. */
export function entriesHandler(store: EntryStore): (request: Request) => Response {
  return () => Response.json({ entries: store.all() });
}
`;

const LEDGER_CORE_FIRST = `import { entriesHandler } from './handlers/entries.js';
import { EntryStore } from './store.js';
import { Router } from './router.js';

const store = new EntryStore();
const router = new Router();

router.get('/entries', entriesHandler(store));

/** Starts the service on the configured port. */
export function start(): void {
  router.listen(3000);
}

start();
`;

const LEDGER_CORE_WITH_NOTIFY = `import { entriesHandler } from './handlers/entries.js';
import { send } from './notify/index.js';
import { type Entry, EntryStore } from './store.js';
import { Router } from './router.js';

const WEBHOOK = 'http://127.0.0.1:9999/entries';

const store = new EntryStore();
const router = new Router();

router.get('/entries', entriesHandler(store));
router.post('/entries', record);

/** Records one entry in the journal and tells the webhook about it. */
export async function record(request: Request): Promise<Response> {
  const entry = (await request.json()) as Entry;
  store.add(entry);
  send(WEBHOOK, 'entry', entry.what);
  return new Response(null, { status: 202 });
}

/** Starts the service on the configured port. */
export function start(): void {
  router.listen(3000);
}

start();
`;

const NOTIFY_INDEX = `import { render } from './templates.js';

export interface Recipient {
  url: string;
}

/** Posts one message to the recipient's webhook. Fire and forget. */
export function send(recipient: Recipient, event: string, detail: string): void {
  void fetch(recipient.url, { method: 'POST', body: render(event, detail) });
}
`;

const NOTIFY_TEMPLATES = `/** Renders an event as the plain text a webhook receives. */
export function render(event: string, detail: string): string {
  return \`\${event}: \${detail}\`;
}
`;

// --- Shared ------------------------------------------------------------

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src"]
}
`;

const GITIGNORE = `node_modules/
`;

if (import.meta.main) main(process.argv.slice(2));

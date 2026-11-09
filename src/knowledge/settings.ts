/**
 * The user's settings on this machine (decision 0031): kept in the madarch home
 * (`settings.json`), not in a product and not in the browser, so the role a
 * person chose follows them to every product and survives a changed port.
 * Today the file holds the role the reader reads as; the first open asks once
 * (`asked`), and a skip means "everything".
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { madarchHome, type DraftEnv } from '../product/home.js';
import { EVERY_ROLE } from './kinds.js';

const SETTINGS_FILE = 'settings.json';

/**
 * The roles a reader can choose for one product: the roles its manifest declares, in its order, with "everything"
 * last — it is every role at once. A product with no roles declared offers "everything" alone.
 */
export function choosableRoles(declared: Iterable<string>): string[] {
  return [...declared, EVERY_ROLE];
}

export interface Settings {
  /** The role chosen; "everything" until one is chosen. */
  role: string;
  /** Whether the reader was asked (and chose or skipped). */
  asked: boolean;
}

export const settingsPath = (env: DraftEnv): string => join(madarchHome(env), SETTINGS_FILE);

/** How many run traces the store keeps (`traceRuns` in settings.json, 20 unless a whole number 1–1000 names one). */
export function traceKeepOf(env: DraftEnv): number {
  try {
    const held = readRaw(settingsPath(env))['traceRuns'];
    return typeof held === 'number' && Number.isInteger(held) && held >= 1 && held <= 1000 ? held : 20;
  } catch {
    return 20;
  }
}

function readRaw(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return {};
    throw new Error(`${file}: the settings cannot be read: ${(error as Error).message}`);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('it is not a JSON object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${file}: the settings are not valid JSON (${(error as Error).message}); fix or remove the file and the wiki asks for the role again`);
  }
}

/** The settings as the file holds them; a missing file is a reader who was never asked. */
export function readSettings(env: DraftEnv, roles: readonly string[]): Settings {
  const raw = readRaw(settingsPath(env));
  const role = typeof raw['role'] === 'string' && roles.includes(raw['role']) ? raw['role'] : EVERY_ROLE;
  return { role, asked: raw['roleAsked'] === true };
}

/** Writes the role (and that the reader was asked), keeping every other key of the file. */
export function writeRole(env: DraftEnv, role: string, roles: readonly string[]): Settings {
  if (!roles.includes(role)) throw new Error(`"${role}" is not a role: the roles are ${roles.join(', ')}`);
  const file = settingsPath(env);
  const raw = readRaw(file);
  raw['role'] = role;
  raw['roleAsked'] = true;
  mkdirSync(dirname(file), { recursive: true });
  // A file of its own that did not exist (exclusive), so a link left at a guessable name is never written through.
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`${file}: the settings could not be written: ${(error as Error).message}`);
  }
  return { role, asked: true };
}

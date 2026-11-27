import { randomUUID } from 'node:crypto';
import { startupEnabled, startupIdentifiers } from '../obs/startup-context.js';
import { startupOperation, startupBegin, withStartupContext } from '../obs/log.js';
/** Owner-only schema service. API and fill processes request preparation over an authenticated loopback channel. */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { withSpanSync, withSpan } from '../obs/trace.js';
import { join } from 'node:path';
import { resolve } from 'node:path';
import type { GraphContract } from '../graph/contract.js';

export interface PreparationRequest {
  readonly startup?: { readonly operation: string; readonly collection?: string; readonly keyId?: string };
  readonly store: string;
  readonly database?: string;
  readonly contract?: GraphContract;
  readonly installedPlugins?: readonly { readonly id: string; readonly version: string }[];
  readonly histories?: boolean;
  readonly reset?: boolean;
  readonly rename?: { readonly from: string; readonly to: string };
}
const ADDRESS = 'MADARCH_STORE_OWNER_URL';
const TOKEN = 'MADARCH_STORE_OWNER_TOKEN';

/** Ask the owning process; a role without its owner refuses instead of creating schemas itself. */
export async function requestStorePreparation(store: string, contract?: GraphContract, installedPlugins?: PreparationRequest['installedPlugins']): Promise<void> {
  await withSpan('store.prepare', { 'file.path': store }, async () => await request({ store, ...(contract === undefined ? {} : { contract }), ...(installedPlugins === undefined ? {} : { installedPlugins }) }));
}
export async function requestStoreReset(store: string, contract: GraphContract): Promise<void> {
  await withSpan('store.prepare', { 'file.path': store }, async () => await request({ store, contract, reset: true }));
}
export async function requestHistoryPreparation(store: string, database?: string): Promise<void> {
  await withSpan('store.prepare', { 'file.path': store }, async () => await request({ store, ...(database === undefined ? { histories: true } : { database }) }));
}
export async function requestHistoryRename(store: string, from: string, to: string): Promise<void> {
  await withSpan('store.prepare', { 'file.path': store }, async () => await request({ store, rename: { from, to } }));
}
/** A separate CLI invocation borrows the live daemon's preparation service, never its ownership. */
export async function withDaemonStorePreparation<T>(home: string, work: () => Promise<T>): Promise<T> {
  const descriptor = JSON.parse(withSpanSync('fs.read', { 'file.path': join(home, '.madarch-store-owner.json') }, (span) => { const answer = readFileSync(join(home, '.madarch-store-owner.json'), 'utf8'); span.setAttribute('file.bytes', Buffer.byteLength(answer)); return answer; })) as { url: string; token: string };
  const previousUrl = process.env[ADDRESS];
  const previousToken = process.env[TOKEN];
  process.env[ADDRESS] = descriptor.url;
  process.env[TOKEN] = descriptor.token;
  try { return await work(); }
  finally {
    if (previousUrl === undefined) delete process.env[ADDRESS]; else process.env[ADDRESS] = previousUrl;
    if (previousToken === undefined) delete process.env[TOKEN]; else process.env[TOKEN] = previousToken;
  }
}
/**
 * Run a command's store work with a prepared store: a command beside a running daemon borrows the service that daemon
 * published in the products home, and a command run alone owns the preparation itself. One reading of the products home
 * decides between them, so a command never has to be told an address and a token by hand (madarch-64o5.193: the entity
 * command reached neither and refused every store it met while a wiki was running).
 */
export async function withStorePreparation<T>(home: string, work: () => Promise<T>): Promise<T> {
  return existsSync(join(home, '.madarch-store-owner.json'))
    ? await withDaemonStorePreparation(home, work)
    : await withStorePreparationOwner(work);
}
export function publishStoreOwner(home: string): () => void {
  const path = join(home, '.madarch-store-owner.json');
  withSpanSync('fs.write', { 'file.path': path, 'file.bytes': Buffer.byteLength(JSON.stringify({ url: process.env[ADDRESS], token: process.env[TOKEN] })) }, () => writeFileSync(path, JSON.stringify({ url: process.env[ADDRESS], token: process.env[TOKEN] }), { mode: 0o600 }));
  return () => { unlinkSync(path); };
}
async function request(body: PreparationRequest): Promise<void> {
  const url = process.env[ADDRESS];
  const token = process.env[TOKEN];
  if (url === undefined || token === undefined) throw new Error(`${resolve(body.store)}:1: the store needs its owning madarch process for schema preparation (src/product/store-preparation.ts)`);
  if (!startupEnabled()) { await sendRequest(body, url, token); return; }
  const operation = startupOperation() ?? randomUUID();
  await withStartupContext(operation, async () => {
    const terminal = startupBegin('schema.request', resolve(body.store, 'pgdata'));
    try {
      await sendRequest({ ...body, startup: { operation, ...startupIdentifiers() } }, url, token);
      terminal('ok');
    } catch (error) { terminal('error'); throw error; }
  });
}
async function sendRequest(body: PreparationRequest, url: string, token: string): Promise<void> {
  const response = await withSpan('net.fetch', { 'http.method': 'POST', 'http.url': url, 'http.bytes': Buffer.byteLength(JSON.stringify(body)) }, async (span) => {
    const answer = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    span.setAttribute('http.status', answer.status);
    return answer;
  });
  if (!response.ok) throw new Error(`${resolve(body.store)}:1: the store owner refused: ${await response.text()} (src/product/store-preparation.ts)`);
}

export async function withStorePreparationOwner<T>(work: () => Promise<T>): Promise<T> {
  const { withStorePreparationOwner: own } = await import('../adapters/store-preparation-owner.js');
  return await own(work);
}

/** Owner-only schema service. API and fill processes request preparation over an authenticated loopback channel. */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import type { GraphContract } from '../graph/contract.js';

export interface PreparationRequest {
  readonly store: string;
  readonly database?: string;
  readonly contract?: GraphContract;
  readonly histories?: boolean;
  readonly rename?: { readonly from: string; readonly to: string };
}
const ADDRESS = 'MADARCH_STORE_OWNER_URL';
const TOKEN = 'MADARCH_STORE_OWNER_TOKEN';

/** Ask the owning process; a role without its owner refuses instead of creating schemas itself. */
export async function requestStorePreparation(store: string, contract?: GraphContract): Promise<void> {
  await request({ store, ...(contract === undefined ? {} : { contract }) });
}
export async function requestHistoryPreparation(store: string, database?: string): Promise<void> {
  await request({ store, ...(database === undefined ? { histories: true } : { database }) });
}
export async function requestHistoryRename(store: string, from: string, to: string): Promise<void> {
  await request({ store, rename: { from, to } });
}
/** A separate CLI invocation borrows the live daemon's preparation service, never its ownership. */
export async function withDaemonStorePreparation<T>(home: string, work: () => Promise<T>): Promise<T> {
  const descriptor = JSON.parse(readFileSync(join(home, '.madarch-store-owner.json'), 'utf8')) as { url: string; token: string };
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
export function publishStoreOwner(home: string): () => void {
  const path = join(home, '.madarch-store-owner.json');
  writeFileSync(path, JSON.stringify({ url: process.env[ADDRESS], token: process.env[TOKEN] }), { mode: 0o600 });
  return () => { unlinkSync(path); };
}
async function request(body: PreparationRequest): Promise<void> {
  const url = process.env[ADDRESS];
  const token = process.env[TOKEN];
  if (url === undefined || token === undefined) throw new Error(`the store ${resolve(body.store)} needs its owning madarch process for schema preparation (src/product/store-preparation.ts)`);
  await sendRequest(body, url, token);
}
async function sendRequest(body: PreparationRequest, url: string, token: string): Promise<void> {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`the store owner refused ${resolve(body.store)}: ${await response.text()} (src/product/store-preparation.ts)`);
}

export async function withStorePreparationOwner<T>(work: () => Promise<T>): Promise<T> {
  const { withStorePreparationOwner: own } = await import('../adapters/store-preparation-owner.js');
  return await own(work);
}

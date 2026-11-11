import { appPath } from '../app-base.js';
import { readJson } from '../api.js';

export type AuthoredField = { name: string; type: 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json'; nullable?: boolean; reference?: string };
export type AuthoredEntity = { id: string; uid: string; values: Record<string, unknown> };
export type AuthoredView = { kind: string; fields: AuthoredField[]; entity?: AuthoredEntity; entities?: AuthoredEntity[] };
export class AuthoredError extends Error {
  constructor(message: string, public field?: string) { super(message); }
}
const address = (kind: string, uid?: string): string => `/api/authored?${new URLSearchParams({ kind, ...(uid === undefined ? {} : { uid }) })}`;
export const readAuthored = (kind: string, uid?: string, signal?: AbortSignal): Promise<AuthoredView> => readJson('read authored entities', address(kind, uid), signal);
export const readAuthoredSchema = (kind: string, signal?: AbortSignal): Promise<AuthoredView> => readJson('read authored fields', `/api/authored-schema?${new URLSearchParams({ kind })}`, signal);
export async function writeAuthored(kind: string, method: 'POST' | 'PATCH' | 'DELETE', uid?: string, values?: Record<string, unknown>): Promise<AuthoredView> {
  const response = await fetch(appPath(address(kind, uid)), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(method === 'DELETE' ? { confirm: true } : { values }) });
  const answer = await response.json();
  if (!response.ok) throw new AuthoredError(answer.message ?? answer.error?.message ?? String(response.status), answer.field ?? answer.error?.field);
  return answer;
}

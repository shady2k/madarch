/**
 * The product's kinds registry, as the wiki serves it (decision 0021 as the
 * owner refined it, 2026-10-12; the contract version is the registry's own
 * `contract` field, contract v1): the registry is read fresh with every
 * ask, the way the pages are. A registry of a version this madarch knows,
 * that reads whole, stands. Anything else — a contract version this
 * madarch does not know, a file that cannot be read or that refuses its
 * own reading — is named by the reading's own words and degrades the wiki
 * to plain pages: the pages render without their kinds, statuses and
 * links, never failing silently.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { parseContractText, type ContractError } from '../product/contract.js';

/** The registry file's place within the product, the way every refusal names it. */
export const REGISTRY_FILE = 'docs/kinds.yaml';

/** How the wiki serves the product's registry on this ask. */
export type RegistryContract =
  | { state: 'absent' }
  | { state: 'known'; version: number }
  | { state: 'unknown'; version?: number; message: string };

/** One serving of the registry: the state and the digest its bytes give the revision. */
export interface RegistryServing {
  contract: RegistryContract;
  /**
   * The revision's contribution for this ask: the registry file's bytes'
   * digest when the file can be read, the absence's digest when there is
   * no file, the refusal's own words when it cannot be read. An edit to
   * the registry is therefore a change the wiki's stream reports, the way
   * a page's edit is.
   */
  digest: string;
}

function digestOf(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The notice the wiki serves under the reading's refusals, every one named where it stands. */
function noticeOf(read: { ok: false; errors: ContractError[] }): string {
  const named = read.errors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('; ');
  return `${named} — the wiki serves these pages as plain documents`;
}

/**
 * Reads the product's registry fresh: how the wiki serves it, and the
 * digest its bytes give the revision. The gate never throws: a registry
 * that cannot be read is the unknown state naming why, never the ask's
 * failure — the pages stand whatever the registry holds.
 */
export function readRegistryServing(productFolder: string): RegistryServing {
  const file = joinPath(productFolder, ...REGISTRY_FILE.split('/'));
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { contract: { state: 'absent' }, digest: digestOf(`${REGISTRY_FILE}\u0000absent`) };
    }
    return {
      contract: { state: 'unknown', message: `${REGISTRY_FILE} could not be read: ${(error as Error).message} — the wiki serves these pages as plain documents` },
      digest: digestOf(`${REGISTRY_FILE}\u0000unreadable`),
    };
  }
  if (stat.isDirectory()) {
    return {
      contract: { state: 'unknown', message: `${REGISTRY_FILE} is a folder, not a registry file — the wiki serves these pages as plain documents` },
      digest: digestOf(`${REGISTRY_FILE}\u0000folder`),
    };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      contract: { state: 'unknown', message: `${REGISTRY_FILE} could not be read: ${(error as Error).message} — the wiki serves these pages as plain documents` },
      digest: digestOf(`${REGISTRY_FILE}\u0000unreadable`),
    };
  }
  const read = parseContractText(REGISTRY_FILE, text);
  if (read.ok) {
    return { contract: { state: 'known', version: read.contract }, digest: digestOf(text) };
  }
  const withVersion = read.errors.find((error) => error.version !== undefined);
  return {
    contract: {
      state: 'unknown',
      version: withVersion?.version,
      message: noticeOf(read),
    },
    digest: digestOf(text),
  };
}

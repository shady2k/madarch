/** One-time import of retired authored Markdown; normal fills never call this module. */
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { commitAuthoredImport } from '../adapters/authored-import.js';
import { withSpan } from '../obs/trace.js';
import { byCodePoint } from '../model/order.js';
import { authoredEntity } from '../graph/authored.js';
import { type Finding, type KindsManifest } from '../product/manifest/kinds.js';
import { authoredImportCandidates, readAuthoredImport, archiveAuthoredImport } from '../plugin/authored-import-source.js';

const MIGRATION = 'authored-markdown-v1';
/** The archive is not an entity source; it holds the original bytes after their import commits. */
export const AUTHORED_ARCHIVE = '.madarch/imported-authored';
export interface AuthoredImportResult { imported: string[]; archived: string[]; errors: Finding[]; }

/**
 * Imports each item atomically, keeping failures in place. A committed journal receipt survives an interrupted archive,
 * so retrying never creates a second keyless entity. Original bytes live in the journal, encoded without text loss.
 */
export async function importAuthored(productFolder: string, owner: Parameters<typeof commitAuthoredImport>[0], manifest: KindsManifest, prefix: string, person: string): Promise<AuthoredImportResult> {
  return await withSpan('authored.import', {}, async () => {
  const result: AuthoredImportResult = { imported: [], archived: [], errors: [] };
  const root = resolve(productFolder);
  const seen = new Set<string>();
  for (const decl of [...manifest.kinds.values()].sort((a, b) => byCodePoint(a.name, b.name))) {
    if (decl.origin !== 'person') continue;
    for (const file of authoredImportCandidates(root, decl, result.errors)) {
      if (seen.has(file)) { result.errors.push({ file, line: 1, message: 'more than one kind declares this import path' }); continue; }
      seen.add(file);
      try {
        const findings: Finding[] = [];
        const { bytes, entity } = readAuthoredImport(root, file, decl, findings);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (entity === null) { result.errors.push(...findings); continue; }
        const identity = { migration: MIGRATION, path: file, legacyId: entity.id };
        const words = JSON.stringify({ ...identity, sha256: digest, bytes: bytes.toString('base64') });
        const values: Record<string, unknown> = {};
        for (const field of decl.fields ?? []) {
          if (field.name === 'legacy_id') values[field.name] = entity.id;
          else if (field.name === 'body') values[field.name] = entity.body;
          else if (field.name === 'front') values[field.name] = entity.front;
          else if (field.name === 'title') values[field.name] = entity.title;
          else if (field.name in entity.front) values[field.name] = entity.front[field.name];
        }
        const imported = await commitAuthoredImport(owner, identity, words, async (tx, uid) => {
          await authoredEntity(tx, manifest, prefix, person, uid === undefined ? 'create' : 'edit', decl.name, { values, words, ...(uid === undefined ? {} : { uid, recordUnchanged: true }) });
        });
        if (imported) result.imported.push(file);
        archiveAuthoredImport(root, file, digest, bytes, AUTHORED_ARCHIVE);
        result.archived.push(file);
      } catch (error) {
        result.errors.push({ file, line: 1, message: `${join(root, file)}:1: ${String(error)}` });
      }
    }
  }
  result.imported.sort(byCodePoint);
  result.archived.sort(byCodePoint);
  result.errors = result.errors.map((error) => ({ ...error, file: resolve(root, error.file) }))
    .sort((a, b) => byCodePoint(a.file, b.file) || a.line - b.line || byCodePoint(a.message, b.message));
  return await withSpan('authored.import.result', { 'imported': result.imported.length, 'archived': result.archived.length, 'errors': result.errors.length }, async () => result);
  });
}

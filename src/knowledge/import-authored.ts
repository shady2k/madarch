/** One-time import of retired authored Markdown; normal fills never call this module. */
import { lstatSync, readFileSync, readdirSync, mkdirSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { commitAuthoredImport } from '../adapters/authored-import.js';
import { withSpan } from '../obs/trace.js';
import { byCodePoint } from '../model/order.js';
import { authoredEntity } from '../graph/authored.js';
import { insideFolder, type Finding, type KindDecl, type KindsManifest } from './kinds.js';
import { readMarkdownEntity } from './markdown.js';

const MIGRATION = 'authored-markdown-v1';
/** The archive is not an entity source; it holds the original bytes after their import commits. */
export const AUTHORED_ARCHIVE = '.madarch/imported-authored';
export interface AuthoredImportResult { imported: string[]; archived: string[]; errors: Finding[]; }

/** Every candidate or unreadable entry is reported, including links and unreadable directories. */
function candidates(root: string, decl: KindDecl, errors: Finding[]): string[] {
  const file = decl.importFile ?? (decl.source === 'markdown' ? decl.file : undefined);
  const folder = decl.importFolder ?? (decl.source === 'markdown' ? decl.folder : undefined);
  const found: string[] = [];
  function visit(path: string, singleton = false): void {
    if (!insideFolder(root, path)) { errors.push({ file: path, line: 1, message: 'the import path leaves the product repository' }); return; }
    try {
      // Refuse symlinked ancestors too: no import can read outside the product through a link.
      let part = root;
      for (const leg of path.split('/')) {
        part = join(part, leg);
        if (lstatSync(part).isSymbolicLink()) throw new Error('the import path contains a symbolic link');
      }
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory() && !singleton) {
        for (const entry of readdirSync(join(root, path)).sort(byCodePoint)) visit(`${path}/${entry}`);
      } else if (stat.isFile() && (singleton || path.endsWith('.md'))) found.push(path);
      else if (singleton) throw new Error('the import source is not a regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (path === file || path === folder)) return;
      errors.push({ file: path, line: 1, message: `cannot inspect import source: ${String(error)}` });
    }
  }
  if (file !== undefined) visit(file, true);
  if (folder !== undefined) visit(folder);
  return found;
}

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
    for (const file of candidates(root, decl, result.errors)) {
      if (seen.has(file)) { result.errors.push({ file, line: 1, message: 'more than one kind declares this import path' }); continue; }
      seen.add(file);
      try {
        const bytes = readFileSync(join(root, file));
        const digest = createHash('sha256').update(bytes).digest('hex');
        const findings: Finding[] = [];
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const entity = readMarkdownEntity(text, file, decl, findings);
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
        // Compare immediately before removal; an edited source is never discarded after importing its older bytes.
        if (!readFileSync(join(root, file)).equals(bytes)) throw new Error('the source changed during import; its committed original is retained in the journal, and the changed file was not moved');
        const archive = join(root, AUTHORED_ARCHIVE, digest, file);
        let archiveParent = root;
        for (const leg of `${AUTHORED_ARCHIVE}/${digest}/${file}`.split('/').slice(0, -1)) {
          archiveParent = join(archiveParent, leg);
          if (existsSync(archiveParent) && lstatSync(archiveParent).isSymbolicLink()) throw new Error(`archive ancestor ${archiveParent} is a symbolic link`);
        }
        mkdirSync(dirname(archive), { recursive: true });
        if (existsSync(archive)) {
          if (!lstatSync(archive).isFile() || !readFileSync(archive).equals(bytes)) throw new Error(`the archive path ${archive} already holds different content`);
        } else linkSync(join(root, file), archive); // exclusive destination, unlike rename's overwrite
        unlinkSync(join(root, file));
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

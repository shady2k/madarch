/** Reads and archives retired authored source only during explicit one-time migration. */
import { lstatSync, readFileSync, readdirSync, mkdirSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { insideFolder, type Finding, type KindDecl } from '../product/manifest/kinds.js';

interface ImportedMarkdown {
  id: string;
  kind: string;
  title: string;
  relates: string[];
  producer: string | null;
  sources: string[];
  body: string;
  bodyLine: number;
  file: string;
  source: string;
  front: Record<string, unknown>;
}

/** The front matter and body of a Markdown file; the front matter is null when the file has none. */
function splitFrontMatter(text: string): { front: string | null; body: string; bodyLine: number } {
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return { front: null, body: normalized, bodyLine: 1 };
  const lines = normalized.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if ((line.endsWith('\r') ? line.slice(0, -1) : line) === '---') {
      return { front: lines.slice(1, index).join('\n'), body: lines.slice(index + 1).join('\n'), bodyLine: index + 2 };
    }
  }
  return { front: null, body: normalized, bodyLine: 1 };
}

/** Validates a retired authored file only during explicit migration, never at page or fill time. */
function readImportedMarkdown(text: string, path: string, decl: KindDecl, findings: Finding[]): ImportedMarkdown | null {
  const { front, body, bodyLine } = splitFrontMatter(text);
  if (front === null) {
    findings.push({ file: path, line: 1, message: `the file has no front matter: an entity of kind "${decl.name}" starts with --- , its id and its kind, ---` });
    return null;
  }
  const lines = new LineCounter();
  const doc = parseDocument(front.replace(/\r\n/g, '\n').replace(/\r$/u, ''), { lineCounter: lines });
  if (doc.errors.length > 0) {
    findings.push({ file: path, line: 1 + (doc.errors[0]!.linePos?.[0].line ?? 1), message: `the front matter is not YAML: ${doc.errors[0]!.message.split('\n')[0]}` });
    return null;
  }
  const value: unknown = doc.toJS();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push({ file: path, line: 2, message: 'the front matter is a mapping' });
    return null;
  }
  const record = value as Record<string, unknown>;
  const problem = (message: string, line = 2): null => {
    findings.push({ file: path, line, message });
    return null;
  };
  const id = record['id'];
  if (typeof id !== 'string' || !/^[^:\s]+:\S+$/.test(id)) return problem(`"id" is the kind, a colon and a slug, such as "${decl.name}:name"; got ${JSON.stringify(id)}`);
  if (!id.startsWith(`${decl.name}:`)) return problem(`the id "${id}" does not start with "${decl.name}:", the kind the manifest gives this place`);
  if (record['kind'] !== decl.name) return problem(`"kind" is "${decl.name}" in the manifest and ${JSON.stringify(record['kind'])} here`);
  const relates = record['relates'];
  if (relates !== undefined && (!Array.isArray(relates) || relates.some((entry) => typeof entry !== 'string'))) return problem('"relates" is a list of graph keys');
  const sources = record['sources'];
  if (sources !== undefined && (!Array.isArray(sources) || sources.some((entry) => typeof entry !== 'string'))) return problem('"sources" is a list of texts');
  const title = record['title'];
  if (title !== undefined && typeof title !== 'string') return problem('"title" is a text');
  const producer = record['producer'];
  if (producer !== undefined && producer !== 'agent' && producer !== 'person') return problem('"producer" is "agent" or "person"');
  return {
    id,
    kind: decl.name,
    title: typeof title === 'string' && title !== '' ? title : id.slice(id.indexOf(':') + 1),
    relates: (relates as string[] | undefined) ?? [],
    producer: (producer as string | undefined) ?? null,
    sources: (sources as string[] | undefined) ?? [],
    body,
    bodyLine,
    file: path,
    source: text,
    front: record,
  };
}

/** Every candidate or unreadable entry is reported, including links and unreadable directories. */
export function authoredImportCandidates(root: string, decl: KindDecl, errors: Finding[]): string[] {
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

/** Exact original bytes and their validated legacy entity, never a normal fill reader. */
export function readAuthoredImport(root: string, file: string, decl: KindDecl, findings: Finding[]) {
  const bytes = readFileSync(join(root, file));
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { bytes, entity: readImportedMarkdown(text, file, decl, findings) };
}

/** Archive only the exact committed bytes; links and overwritten destinations remain refused. */
export function archiveAuthoredImport(root: string, file: string, digest: string, bytes: Buffer, archiveFolder: string): void {
        // Compare immediately before removal; an edited source is never discarded after importing its older bytes.
        if (!readFileSync(join(root, file)).equals(bytes)) throw new Error('the source changed during import; its committed original is retained in the journal, and the changed file was not moved');
        const archive = join(root, archiveFolder, digest, file);
        let archiveParent = root;
        for (const leg of `${archiveFolder}/${digest}/${file}`.split('/').slice(0, -1)) {
          archiveParent = join(archiveParent, leg);
          if (existsSync(archiveParent) && lstatSync(archiveParent).isSymbolicLink()) throw new Error(`archive ancestor ${archiveParent} is a symbolic link`);
        }
        mkdirSync(dirname(archive), { recursive: true });
        if (existsSync(archive)) {
          if (!lstatSync(archive).isFile() || !readFileSync(archive).equals(bytes)) throw new Error(`the archive path ${archive} already holds different content`);
        } else linkSync(join(root, file), archive); // exclusive destination, unlike rename's overwrite
        unlinkSync(join(root, file));
}

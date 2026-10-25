/** Narrow generated guide artifact adapter. This module grants no publication/write authority. */
import { LineCounter, parseDocument, stringify } from 'yaml';
import { byCodePoint } from '../../model/order.js';
import { checkStrictYaml } from '../../model/strict-yaml.js';
import { lineForPath, type PathSegment } from '../../model/yaml-position.js';
import { GUIDE_SCHEMA, type GuideDiagnostic, type GuideDocument, type GuideValidationHost } from './model.js';
import { renderGuideMarkdown } from './render.js';
import { validateGuide, type GuideValidation } from './validate.js';

const MAX_ARTIFACT_BYTES = 512 * 1024;
const metadataKeys = ['schema', 'id', 'kind', 'title', 'wiki-language', 'producer', 'guide'];
const bodyOf = (rendered: string): string => rendered.slice(rendered.indexOf('\n---\n', 4) + 5);
const segments = (path: string): PathSegment[] => [...path.matchAll(/(?:^|\.)([^.\[\]]+)|\[(\d+)\]/g)].map((match) => match[2] === undefined ? match[1]! : Number(match[2]));

/** Canonical durable body always says not walked. Fresh receipt overlays are read-time only. */
export function renderGuideArtifact(guide: GuideDocument): string {
  const body = bodyOf(renderGuideMarkdown(guide));
  const front = stringify({ schema: GUIDE_SCHEMA, id: guide.id, kind: guide.kind, title: guide.title,
    'wiki-language': guide.locale, producer: 'agent', guide }).trimEnd();
  return `---\n${front}\n---\n${body}`;
}

/** Ordinary Markdown is not a guide. Exact bytes never substitute for host source verification. */
export async function parseGuideArtifact(file: string, source: string, host: Omit<GuideValidationHost, 'file'>): Promise<GuideValidation> {
  const diagnostics: GuideDiagnostic[] = [];
  const error = (line: number, path: string, code: string, detail: string): void => {
    diagnostics.push({ file, line, path, code, message: `${file}:${line}: ${path}: ${detail}` });
  };
  const failed = (): GuideValidation => ({ ok: false, diagnostics: diagnostics.sort((a, b) => byCodePoint(a.path, b.path) || a.line - b.line || byCodePoint(a.code, b.code)) });
  if (new TextEncoder().encode(source).length > MAX_ARTIFACT_BYTES) { error(1, '$', 'bound', `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`); return failed(); }
  const lines = source.split('\n');
  if (lines[0] !== '---') { error(1, '$', 'artifact-format', 'expected generated guide front matter'); return failed(); }
  const end = lines.indexOf('---', 1);
  if (end < 0) { error(1, '$', 'artifact-format', 'guide front matter is not closed'); return failed(); }
  const yaml = lines.slice(1, end).join('\n');
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, { uniqueKeys: false, lineCounter, strict: true });
  for (const problem of document.errors) error((problem.linePos?.[0]?.line ?? lineCounter.linePos(problem.pos[0]).line) + 1, '$', 'yaml', 'invalid guide YAML');
  // Existing strict-YAML rules reject duplicates, anchors, aliases, merge keys and tags before toJS.
  for (const problem of checkStrictYaml(document, lineCounter, file, yaml)) error(problem.line + 1, problem.path === '' ? '$' : `$.${problem.path}`, 'strict-yaml', 'unsupported or duplicate YAML construct');
  if (diagnostics.length > 0) return failed();
  let raw: unknown;
  try { raw = document.toJS({ maxAliasCount: 0 }); } catch { error(2, '$', 'yaml', 'guide YAML cannot be materialized safely'); return failed(); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { error(2, '$', 'artifact-format', 'guide front matter must be a mapping'); return failed(); }
  const meta = raw as Record<string, unknown>;
  const lineAt = (path: string): number => lineForPath(document, lineCounter, segments(path.replace(/^\$\.?/, ''))) + 1;
  for (const key of Object.keys(meta).sort(byCodePoint)) if (!metadataKeys.includes(key)) error(lineAt(`$.${key}`), `$.${key}`, 'unknown-field', 'field is not part of the guide artifact');
  for (const key of metadataKeys) if (!(key in meta)) error(2, `$.${key}`, 'missing-field', 'required guide metadata is absent');
  if (meta['schema'] !== GUIDE_SCHEMA) error(lineAt('$.schema'), '$.schema', 'schema', `expected ${GUIDE_SCHEMA}`);
  if (meta['producer'] !== 'agent') error(lineAt('$.producer'), '$.producer', 'producer', 'expected generated guide metadata; this field grants no overwrite authority');
  if (diagnostics.length > 0) return failed();
  const checked = await validateGuide(meta['guide'], { ...host, file });
  if (!checked.ok) {
    for (const problem of checked.diagnostics) {
      const path = problem.path === '$' ? '$.guide' : `$.guide${problem.path.slice(1)}`;
      const line = lineAt(path);
      // Keep the code/path but never repeat a host error that might contain source secrets.
      error(line, path, problem.code, `guide validation refused (${problem.code})`);
    }
    return failed();
  }
  const guide = checked.guide;
  for (const [field, expected] of [['id', guide.id], ['kind', guide.kind], ['title', guide.title], ['wiki-language', guide.locale]] as const) {
    if (meta[field] !== expected) error(lineAt(`$.${field}`), `$.${field}`, 'metadata-divergence', 'metadata differs from the canonical guide payload');
  }
  if (diagnostics.length > 0) return failed();
  const expected = renderGuideArtifact(guide);
  if (source !== expected) {
    const expectedLines = expected.split('\n');
    const first = lines.findIndex((line, index) => line !== expectedLines[index]);
    error(first < 0 ? lines.length : first + 1, '$.artifact', 'canonical-divergence', 'artifact bytes differ from canonical generated metadata/body; no authored text was adopted');
    return failed();
  }
  return { ok: true, guide };
}

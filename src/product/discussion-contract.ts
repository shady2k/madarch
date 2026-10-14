import { LineCounter, parseDocument } from 'yaml';
import { Value } from 'typebox/value';
import { checkStrictYaml } from '../model/strict-yaml.js';
import { jsonPointerToSegments, lineForPath, segmentsToPath } from '../model/yaml-position.js';
import { DISCUSSION_MESSAGE_SCHEMA_ID, DiscussionMessage, ULID_PATTERN } from './discussion-schema.js';

export interface DiscussionContractError { file: string; line: number; path: string; message: string }
export type DiscussionMessageRead = { ok: true; message: Record<string, unknown>; body: string } | { ok: false; errors: DiscussionContractError[] };
export interface MarkerScan { errors: DiscussionContractError[] }
const ULID = new RegExp(ULID_PATTERN);

/** Reads a front-matter Markdown discussion message and checks its path identity and v1 schema. */
export function parseDiscussionMessage(file: string, text: string): DiscussionMessageRead {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { ok: false, errors: [{ file, line: 1, path: '', message: 'a discussion message starts with YAML front matter (`---`)' }] };
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end < 0) return { ok: false, errors: [{ file, line: 1, path: '', message: 'the discussion message has no closing front-matter `---`' }] };
  const metadataText = lines.slice(1, end).join('\n') + '\n';
  const lineCounter = new LineCounter();
  const doc = parseDocument(metadataText, { lineCounter, keepSourceTokens: true, merge: false, uniqueKeys: false });
  const strict = checkStrictYaml(doc, lineCounter, file, metadataText);
  const errors: DiscussionContractError[] = strict.map((error) => ({ ...error, line: error.line + 1 }));
  for (const error of doc.errors) errors.push({ file, line: lineCounter.linePos(error.pos[0]).line + 1, path: '', message: error.message });
  if (errors.length) return { ok: false, errors };
  const value: unknown = doc.toJS();
  const shapeErrors = Value.Errors(DiscussionMessage, value).map((error) => {
    const segments = jsonPointerToSegments(error.instancePath);
    return { file, line: lineForPath(doc, lineCounter, segments) + 1, path: segmentsToPath(segments), message: error.message };
  });
  errors.push(...shapeErrors);
  const match = /^comments\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/([0-7][0-9A-HJKMNP-TV-Z]{25})\.md$/.exec(file);
  if (!match) errors.push({ file, line: 1, path: '', message: 'a message path is comments/<thread ULID>/<message ULID>.md' });
  else if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).thread !== match[1]) {
    const fieldLine = lineForPath(doc, lineCounter, ['thread']) + 1;
    errors.push({ file, line: fieldLine, path: 'thread', message: 'the front-matter thread must match the thread ULID in the path' });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, message: value as Record<string, unknown>, body: lines.slice(end + 1).join('\n') };
}

/** Checks paired source markers. Pairing is per id, so distinct ids may cross/overlap. */
export function scanDiscussionMarkers(file: string, text: string): MarkerScan {
  const errors: DiscussionContractError[] = [];
  const stacks = new Map<string, number[]>();
  const token = /<!--(\/?)c:([^>\r\n]*)-->/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    const closing = match[1] === '/';
    const id = match[2]!;
    const line = text.slice(0, match.index).split('\n').length;
    if (!ULID.test(id)) {
      errors.push({ file, line, path: 'marker', message: `marker id ${JSON.stringify(id)} is not a ULID` });
      continue;
    }
    const stack = stacks.get(id) ?? [];
    if (closing) {
      if (stack.length === 0) errors.push({ file, line, path: 'marker', message: `closing marker ${id} has no matching opening marker` });
      else stack.pop();
    } else stack.push(line);
    stacks.set(id, stack);
  }
  for (const [id, stack] of stacks) for (const line of stack) errors.push({ file, line, path: 'marker', message: `opening marker ${id} has no matching closing marker` });
  const markerStarts = [...text.matchAll(/<!--\/?c:/g)];
  for (const malformed of markerStarts) {
    const validToken = /^<!--\/?c:[^>\r\n]*-->/.test(text.slice(malformed.index));
    if (!validToken) errors.push({ file, line: text.slice(0, malformed.index).split('\n').length, path: 'marker', message: 'a discussion marker is malformed' });
  }
  return { errors };
}

/** The published identifier, kept here so contract tooling can assert source/schema identity. */
export const discussionMessageSchemaId = DISCUSSION_MESSAGE_SCHEMA_ID;

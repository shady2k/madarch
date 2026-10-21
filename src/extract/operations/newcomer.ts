/**
 * The newcomer area: what the README and the Makefile say to run — the
 * prerequisites, the steps with their folder and command, and the failure a
 * first run meets — as records that reach the Makefile targets and the files
 * the commands name.
 */
import type { PropertyValue } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type { Records } from './accumulate.js';
import type { TreeText } from './source.js';

/** The newcomer area, over the root README and the Makefile targets. */
export function extractNewcomer(t: TreeText, records: Records, targets: ReadonlyMap<string, ReadonlyMap<string, { key: string; recipe: readonly string[] }>>): void {
  const readmePath = t.has('README.md') ? 'README.md' : (t.pathsNamed(/^README\.md$/)[0] ?? null);
  if (readmePath === null) {
    records.gap('README.md', 'the repository names no README');
    return;
  }
  const makefile = targets.get('Makefile') ?? new Map();

  // The prerequisites line.
  const lines = t.lines(readmePath);
  const prerequisitesAt = lines.findIndex((line) => /^Prerequisites:\s*(.+)$/.test(line));
  if (prerequisitesAt >= 0) {
    const tail = /^Prerequisites:\s*(.+)$/.exec(lines[prerequisitesAt] ?? '')?.[1] ?? '';
    const tools = tail
      .split(/,\s*|\s+and\s+/)
      .map((tool) => tool.trim().replace(/\.$/, ''))
      .filter((tool) => tool !== '')
      .sort(byCodePoint);
    records.add({
      key: `code.newcomer-prerequisites:${readmePath}`,
      kind: 'code.newcomer-prerequisites',
      label: 'prerequisites',
      properties: { tools } satisfies { [key: string]: PropertyValue },
      span: t.spanOfLine(readmePath, prerequisitesAt + 1),
    });
  }

  // The numbered steps of the run-it section: order, folder, command, purpose.
  const runIt = lines.findIndex((line) => line.startsWith('## Run it'));
  if (runIt >= 0) {
    for (let index = runIt + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.startsWith('## ')) break;
      const step = /^(\d+)\.\s+(.*)$/.exec(line);
      if (step === null) continue;
      const order = Number.parseInt(step[1] ?? '', 10);
      const startLine = index + 1;
      const parts = [step[2] ?? ''];
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        const continuation = lines[scan] ?? '';
        if (continuation.trim() === '' || /^\d+\.\s/.test(continuation) || continuation.startsWith('## ')) break;
        parts.push(continuation.trim());
        index = scan;
      }
      const text = parts.join(' ').trim();
      const command = /`([^`]+)`/.exec(text)?.[1]?.trim() ?? text;
      const key = `code.newcomer-command:${readmePath}#step-${order}`;
      records.add({
        key,
        kind: 'code.newcomer-command',
        label: command,
        properties: { order, folder: '.', command, purpose: text } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLines(readmePath, startLine, index + 1),
      });
      for (const target of commandTargets(text)) {
        const made = makefile.get(target);
        if (made !== undefined) records.edge('code.backed-by', key, made.key);
      }
      for (const token of new Set(command.split(/\s+/u))) {
        const candidate = token.replace(/["']/g, '');
        if (!t.has(candidate)) continue;
        records.edge('code.references', key, records.file(candidate));
      }
    }
  }

  // The common failure: symptom, port, fix.
  const failureAt = lines.findIndex((line) => /^Common failure:/.test(line));
  if (failureAt >= 0) {
    const paragraph = [lines[failureAt] ?? ''];
    for (let scan = failureAt + 1; scan < lines.length; scan += 1) {
      const continuation = lines[scan] ?? '';
      if (continuation.trim() === '' || continuation.startsWith('#')) break;
      paragraph.push(continuation.trim());
    }
    const text = paragraph.join(' ');
    const symptom = /"([^"]+)"/.exec(text)?.[1] ?? null;
    const port = Number.parseInt(/\b(\d{4,5})\b/.exec(text)?.[1] ?? '', 10);
    const command = /`([^`]+)`/.exec(text)?.[1] ?? null;
    const fix = text.includes(';') ? text.slice(text.indexOf(';') + 1).trim().replace(/\.$/, '') : null;
    const slug = (symptom ?? 'first-run-failure').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const key = `code.newcomer-failure:${readmePath}#${slug}`;
    records.add({
      key,
      kind: 'code.newcomer-failure',
      label: symptom ?? 'first-run failure',
      properties: { symptom, port: Number.isFinite(port) ? port : null, fix, command } satisfies { [key: string]: PropertyValue },
      span: t.spanOfLines(readmePath, failureAt + 1, failureAt + paragraph.length),
    });
    for (const token of new Set((fix ?? '').split(/\s+/u))) {
      const candidate = token.replace(/\.$/, '');
      if (!t.has(candidate)) continue;
      records.edge('code.references', key, records.file(candidate));
    }
  }
}

/** The make targets a step's text asks for, in the order the text names them. */
function commandTargets(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\bmake\s+(?:-s\s+)?([a-z][a-z0-9-]*)/g)) {
    const target = match[1];
    if (target !== undefined) found.push(target);
  }
  return found;
}


/**
 * The build area: the targets a Makefile offers and the jobs a CI workflow
 * runs, each with the lines that name them. File paths a recipe names are
 * edges into the tree when the tree holds the file, so `make seed` reaches the
 * SQL it feeds psql with.
 */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { PropertyValue } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type { Records } from './accumulate.js';
import { TreeText } from './source.js';

/** The targets of one Makefile. */
export function makeTargets(t: TreeText, records: Records, path: string): Map<string, { key: string; recipe: readonly string[] }> {
  const targets = new Map<string, { key: string; recipe: readonly string[] }>();
  const phony = new Set<string>();
  const lines = t.lines(path);
  for (const line of lines) {
    const declared = /^\.PHONY:\s*(.+)$/.exec(line);
    if (declared !== null) {
      for (const name of (declared[1] ?? '').trim().split(/\s+/u)) phony.add(name);
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const declared = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?!=)(?:\s+(.*))?$/.exec(line);
    if (declared === null) continue;
    const name = declared[1] ?? '';
    const prerequisites = (declared[2] ?? '').trim();
    const recipe: string[] = [];
    let last = index;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = lines[scan] ?? '';
      if (!candidate.startsWith('\t')) break;
      recipe.push(candidate.slice(1).replace(/^[@-]+/, '').trim());
      last = scan;
    }
    const key = `code.make-target:${path}#${name}`;
    targets.set(name, { key, recipe });
    const properties: { [key: string]: PropertyValue } = { phony: phony.has(name), recipe };
    if (prerequisites !== '') properties.prerequisites = prerequisites.split(/\s+/u).sort(byCodePoint);
    records.add({
      key,
      kind: 'code.make-target',
      label: name,
      properties,
      span: t.spanOfLines(path, index + 1, last + 1),
    });
    for (const line1 of recipe) {
      for (const token of line1.split(/\s+/u)) {
        const candidate = token.replace(/^[^A-Za-z0-9_.]+|[^A-Za-z0-9_.]+$/g, '');
        if (!candidate.includes('/') || candidate.includes('*') || candidate.includes('$')) continue;
        if (!t.has(candidate)) continue;
        records.edge('code.references', key, records.file(candidate));
      }
    }
    index = last;
  }
  return targets;
}

/** The workflow of one CI YAML file and one node per job. */
export function ciWorkflows(t: TreeText, records: Records): void {
  for (const path of t.pathsUnder('.github/workflows', /\.ya?ml$/)) {
    const document = parseDocument(t.text(path));
    if (!isMap(document.contents)) {
      records.gap(path, 'the file is no mapping: a workflow maps its jobs and triggers');
      continue;
    }
    const name = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value;
    const on = document.contents.items.find((pair) => isScalar(pair.key) && (pair.key.value === 'on' || pair.key.value === true))?.value;
    const triggers: string[] = [];
    if (isSeq(on)) {
      for (const item of on.items) {
        const text = isScalar(item) && item.value !== null ? String(item.value) : null;
        if (text !== null) triggers.push(text);
      }
    } else if (isMap(on)) {
      for (const pair of on.items) {
        if (isScalar(pair.key) && typeof pair.key.value === 'string') triggers.push(pair.key.value);
      }
    }
    const workflowKey = `code.ci-workflow:${path}`;
    records.add({
      key: workflowKey,
      kind: 'code.ci-workflow',
      label: isScalar(name) && name.value !== null ? String(name.value) : path,
      properties: { name: isScalar(name) && name.value !== null ? String(name.value) : null, on: triggers.sort(byCodePoint) },
      span: t.spanOfFile(path),
    });
    const jobs = document.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'jobs')?.value;
    if (!isMap(jobs)) {
      records.gap(path, 'the file declares no jobs mapping');
      continue;
    }
    for (const pair of jobs.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
      const job = pair.key.value;
      const key = `code.ci-job:${path}#${job}`;
      const steps: string[] = [];
      const uses: string[] = [];
      let workingDirectory: string | null = null;
      if (isMap(pair.value)) {
        const defaults = pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'defaults')?.value;
        const defaultRun = isMap(defaults) ? defaults.items.find((item) => isScalar(item.key) && item.key.value === 'run')?.value : undefined;
        const defaultDirectory = isMap(defaultRun)
          ? defaultRun.items.find((item) => isScalar(item.key) && item.key.value === 'working-directory')?.value
          : undefined;
        if (isScalar(defaultDirectory) && defaultDirectory.value !== null) workingDirectory = String(defaultDirectory.value);
        const stepList = pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'steps')?.value;
        if (isSeq(stepList)) {
          for (const step of stepList.items) {
            if (!isMap(step)) continue;
            const run = step.items.find((item) => isScalar(item.key) && item.key.value === 'run')?.value;
            if (isScalar(run) && run.value !== null) steps.push(String(run.value));
            const action = step.items.find((item) => isScalar(item.key) && item.key.value === 'uses')?.value;
            if (isScalar(action) && action.value !== null) uses.push(String(action.value));
            const runWith = step.items.find((item) => isScalar(item.key) && item.key.value === 'with')?.value;
            const directory = isMap(runWith)
              ? runWith.items.find((item) => isScalar(item.key) && item.key.value === 'working-directory')?.value
              : undefined;
            if (workingDirectory === null && isScalar(directory) && directory.value !== null) workingDirectory = String(directory.value);
          }
        }
      }
      records.add({
        key,
        kind: 'code.ci-job',
        label: job,
        properties: { workingDirectory, steps, uses: [...uses].sort(byCodePoint) } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLine(path, 1),
      });
      records.edge('code.contains-job', workflowKey, key);
    }
  }
}

/** The build area: Makefiles first, then the CI workflows. Returns the targets per Makefile. */
export function extractBuild(t: TreeText, records: Records): Map<string, Map<string, { key: string; recipe: readonly string[] }>> {
  const targets = new Map<string, Map<string, { key: string; recipe: readonly string[] }>>();
  for (const path of t.pathsNamed(/^Makefile$/)) targets.set(path, makeTargets(t, records, path));
  ciWorkflows(t, records);
  return targets;
}

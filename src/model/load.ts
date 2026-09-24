import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { Value } from 'typebox/value';
import type { ModelError } from './errors.js';
import { ModelFile, type Category, type Element, type Environment, type Interface, type Relation, type State, type ValidatedModel, type Zone } from './schema.js';
import { checkStrictYaml } from './strict-yaml.js';
import {
  validateModel,
  type EnvironmentZoneLines,
  type PositionedCategory,
  type PositionedElement,
  type PositionedEnvironment,
  type PositionedInterface,
  type PositionedModel,
  type PositionedRelation,
  type PositionedState,
  type PositionedZone,
  type TransferLines,
} from './validate.js';
import { jsonPointerToSegments, lineForPath, segmentsToPath, type PathSegment } from './yaml-position.js';

export interface LoadResult {
  model?: ValidatedModel;
  errors: ModelError[];
}

/**
 * One file of a model: its path, used only to name it in errors, and its
 * text. `path` need not be a real filesystem path — `parseModel` never
 * reads the filesystem — but `loadModel` gives it the file's path relative
 * to the repository root, so errors name it the way a person reading the
 * repository would.
 */
export interface ModelSourceFile {
  path: string;
  text: string;
}

/**
 * Parses and validates a model already read into memory, with no
 * filesystem access of its own: strict YAML, the schema, ids, references
 * and every other rule in `validate.ts`. `files` are read in the order
 * given; callers that read a folder (see `loadModel`) are responsible for
 * giving that a fixed order.
 *
 * Every file is checked independently, and every problem found anywhere is
 * collected before giving up: one bad file does not stop the others from
 * being checked too. Within one file, a strict-YAML violation or a parse
 * error makes the rest of that file's content unreliable, so schema
 * validation is skipped for it; once every file has parsed and matched the
 * schema, ids and references are checked once across the whole model. Each
 * section (`elements`, `interfaces`, `relations`, `categories`, …)
 * concatenates across files, in the given file order.
 */
export function parseModel(files: ModelSourceFile[]): LoadResult {
  const errors: ModelError[] = [];
  const positioned: PositionedModel = {
    elements: [],
    interfaces: [],
    relations: [],
    categories: [],
    zones: [],
    environments: [],
    states: [],
  };

  for (const file of files) {
    const relativeFile = file.path;
    const text = file.text;
    const lineCounter = new LineCounter();
    // `uniqueKeys: false` turns off the parser's own duplicate-key error,
    // which has no path and cannot say which key repeated; `checkStrictYaml`
    // finds duplicates itself, with the file, line and key the model
    // requires.
    const doc = parseDocument(text, { lineCounter, keepSourceTokens: true, merge: false, uniqueKeys: false });

    const strictYamlErrors = checkStrictYaml(doc, lineCounter, relativeFile, text);
    if (doc.errors.length > 0 || strictYamlErrors.length > 0) {
      errors.push(...strictYamlErrors);
      for (const parseError of doc.errors) {
        const line = lineCounter.linePos(parseError.pos[0]).line;
        errors.push({ file: relativeFile, line, path: '', message: parseError.message });
      }
      continue;
    }

    const value: unknown = doc.toJS();
    const fileErrors = normalizeErrors(Value.Errors(ModelFile, value), value);
    if (fileErrors.length > 0) {
      for (const fileError of fileErrors) {
        const segments = jsonPointerToSegments(fileError.instancePath);
        const line = lineForPath(doc, lineCounter, segments);
        errors.push({ file: relativeFile, line, path: segmentsToPath(segments), message: fileError.message });
      }
      continue;
    }

    const parsed = value as {
      version: 1;
      elements: Element[];
      interfaces?: Interface[];
      relations?: Relation[];
      categories?: Category[];
      zones?: Zone[];
      environments?: Environment[];
      states?: State[];
    };
    const line = (segments: (string | number)[]) => lineForPath(doc, lineCounter, segments);

    parsed.elements.forEach((element, index) => {
      positioned.elements.push({
        element,
        file: relativeFile,
        line: line(['elements', index]),
        parentLine: line(['elements', index, 'parent']),
        zonesLine: line(['elements', index, 'zones']),
        zonesAddLines: (element.zones?.add ?? []).map((_zoneId, zoneIndex) =>
          line(['elements', index, 'zones', 'add', zoneIndex]),
        ),
        zonesExcludeLines: (element.zones?.exclude ?? []).map((_zoneId, zoneIndex) =>
          line(['elements', index, 'zones', 'exclude', zoneIndex]),
        ),
        zonesReplaceLines: (element.zones?.replace ?? []).map((_zoneId, zoneIndex) =>
          line(['elements', index, 'zones', 'replace', zoneIndex]),
        ),
        environmentsLines: (element.environments ?? []).map((_environmentId, environmentIndex) =>
          line(['elements', index, 'environments', environmentIndex]),
        ),
        sinceLine: line(['elements', index, 'since']),
        untilLine: line(['elements', index, 'until']),
      });
    });

    (parsed.interfaces ?? []).forEach((iface, index) => {
      positioned.interfaces.push({
        iface,
        file: relativeFile,
        line: line(['interfaces', index]),
        providerLine: line(['interfaces', index, 'provider']),
      });
    });

    (parsed.relations ?? []).forEach((relation, index) => {
      const transferLines: TransferLines[] = (relation.transfers ?? []).map((transfer, transferIndex) => ({
        categoryLines: transfer.categories.map((_category, categoryIndex) =>
          line(['relations', index, 'transfers', transferIndex, 'categories', categoryIndex]),
        ),
      }));
      positioned.relations.push({
        relation,
        file: relativeFile,
        line: line(['relations', index]),
        fromLine: line(['relations', index, 'from']),
        toLine: line(['relations', index, 'to']),
        refinesLine: line(['relations', index, 'refines']),
        interfaceLine: line(['relations', index, 'interface']),
        transferLines,
        sinceLine: line(['relations', index, 'since']),
        untilLine: line(['relations', index, 'until']),
      });
    });

    (parsed.categories ?? []).forEach((category, index) => {
      positioned.categories.push({
        category,
        file: relativeFile,
        line: line(['categories', index]),
      });
    });

    (parsed.zones ?? []).forEach((zone, index) => {
      positioned.zones.push({
        zone,
        file: relativeFile,
        line: line(['zones', index]),
      });
    });

    (parsed.environments ?? []).forEach((environment, index) => {
      const zonesLines: EnvironmentZoneLines[] = Object.keys(environment.zones ?? {}).map((elementId) => ({
        elementId,
        line: line(['environments', index, 'zones', elementId]),
        addLines: (environment.zones?.[elementId]?.add ?? []).map((_zoneId, zoneIndex) =>
          line(['environments', index, 'zones', elementId, 'add', zoneIndex]),
        ),
        excludeLines: (environment.zones?.[elementId]?.exclude ?? []).map((_zoneId, zoneIndex) =>
          line(['environments', index, 'zones', elementId, 'exclude', zoneIndex]),
        ),
      }));
      positioned.environments.push({
        environment,
        file: relativeFile,
        line: line(['environments', index]),
        zonesLines,
      });
    });

    (parsed.states ?? []).forEach((state, index) => {
      positioned.states.push({
        state,
        file: relativeFile,
        line: line(['states', index]),
        afterLine: line(['states', index, 'after']),
      });
    });
  }

  // Every check `validateModel` runs stands on `positioned`, built only
  // from files that parsed and matched the schema: a file with a strict-YAML
  // or schema problem contributed nothing to it and was already skipped, but
  // that does not stop reference and the other checks from running over
  // every file that did pass — so this runs, and its errors join the ones
  // above, even when `errors` is already non-empty.
  const validationErrors = validateModel(positioned);
  const allErrors = [...errors, ...validationErrors];
  if (allErrors.length > 0) {
    return { errors: allErrors };
  }

  const model = {
    version: 1 as const,
    elements: positioned.elements.map((entry) => entry.element),
    interfaces: positioned.interfaces.map((entry) => entry.iface),
    relations: positioned.relations.map((entry) => entry.relation),
    categories: positioned.categories.map((entry) => entry.category),
    zones: positioned.zones.map((entry) => entry.zone),
    environments: positioned.environments.map((entry) => entry.environment),
    states: positioned.states.map((entry) => entry.state),
  };

  // `parseModel` (through `validateModel`, just above) is the only place
  // that produces a `ValidatedModel`: this is the one, deliberate cast at
  // that boundary, so `compileModel` can require the brand instead of
  // trusting every caller to have validated first.
  return { model: model as unknown as ValidatedModel, errors: [] };
}

/**
 * Loads a repository's model: every `*.yaml` file directly inside its
 * `madarch/` folder, read in sorted file-name order and combined into one
 * model by `parseModel`. A thin adapter over `parseModel`: everything that
 * needs the filesystem — listing the folder, reading each file, and the
 * failures particular to that (a missing or empty folder, a `.yml` file, a
 * folder entry that cannot be read as a file) — lives here; `parseModel`
 * itself does no I/O.
 */
export function loadModel(repoRoot: string): LoadResult {
  const madarchDir = join(repoRoot, 'madarch');

  let entries: string[];
  try {
    entries = readdirSync(madarchDir);
  } catch {
    return {
      errors: [{ file: 'madarch', line: 1, path: '', message: 'the madarch folder was not found' }],
    };
  }

  const errors: ModelError[] = [];
  const yamlNames = entries.filter((name) => name.endsWith('.yaml')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ymlNames = entries.filter((name) => name.endsWith('.yml')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const name of ymlNames) {
    errors.push({
      file: relative(repoRoot, join(madarchDir, name)),
      line: 1,
      path: '',
      message: `"${name}" uses the ".yml" extension; madarch only reads "*.yaml" files, so it is ignored — rename it to ".yaml"`,
    });
  }

  if (yamlNames.length === 0) {
    errors.push({
      file: 'madarch',
      line: 1,
      path: '',
      message: 'the madarch folder has no *.yaml files: a model needs at least one',
    });
    return { errors };
  }

  const files: ModelSourceFile[] = [];
  for (const name of yamlNames) {
    const filePath = join(madarchDir, name);
    const relativeFile = relative(repoRoot, filePath);
    try {
      files.push({ path: relativeFile, text: readFileSync(filePath, 'utf8') });
    } catch (error) {
      errors.push({
        file: relativeFile,
        line: 1,
        path: '',
        message: `could not be read as a file: ${(error as Error).message}`,
      });
    }
  }

  const { model, errors: parseErrors } = parseModel(files);
  errors.push(...parseErrors);

  if (errors.length > 0 || model === undefined) {
    return { errors };
  }
  return { model, errors: [] };
}

interface NormalizedError {
  instancePath: string;
  message: string;
}

/**
 * TypeBox reports an unknown field twice under `additionalProperties:
 * false` (once at the field's own path with an uninformative message,
 * once at the object's path listing the extra names) and reports a
 * literal-union mismatch once per branch, as one `const` error per allowed
 * value, none of which say what value would have been accepted. This turns
 * that into one clear error per actual problem: one unknown-field error per
 * name, and for a literal or a union of literals (`version`, `kind`,
 * `direction`, …), one error per offending value naming everything it
 * could have been instead.
 */
function normalizeErrors(
  rawErrors: Iterable<{ keyword: string; instancePath: string; params: Record<string, unknown>; message: string }>,
  rootValue: unknown,
): NormalizedError[] {
  const out: NormalizedError[] = [];
  const seen = new Set<string>();
  const constGroups = new Map<string, unknown[]>();
  const deferredAnyOf: { instancePath: string; message: string }[] = [];

  const push = (instancePath: string, message: string) => {
    const key = `${instancePath}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ instancePath, message });
  };

  for (const error of rawErrors) {
    if (error.keyword === 'const') {
      const group = constGroups.get(error.instancePath);
      if (group) group.push(error.params.allowedValue);
      else constGroups.set(error.instancePath, [error.params.allowedValue]);
      continue;
    }
    if (error.keyword === 'boolean') continue; // the additionalProperties error below is clearer
    if (error.keyword === 'anyOf') {
      // A union-of-literals mismatch also reports one summary "anyOf" error
      // alongside its per-branch `const` errors; those are collapsed into
      // one clearer error below, which makes this one redundant. Deferred
      // rather than dropped outright: kept only if this path never turns
      // out to have been a union of literals.
      deferredAnyOf.push({ instancePath: error.instancePath, message: error.message });
      continue;
    }
    if (error.keyword === 'additionalProperties') {
      const names = (error.params.additionalProperties as string[] | undefined) ?? [];
      for (const name of names) {
        push(`${error.instancePath}/${name}`, `unknown field "${name}"`);
      }
      continue;
    }
    push(error.instancePath, error.message);
  }

  for (const { instancePath, message } of deferredAnyOf) {
    if (constGroups.has(instancePath)) continue;
    push(instancePath, message);
  }

  for (const [instancePath, allowedValues] of constGroups) {
    const segments = jsonPointerToSegments(instancePath);
    const field = segments[segments.length - 1] ?? instancePath;
    const actual = valueAtPointer(rootValue, segments);
    const allowedText = allowedValues.map((allowed) => JSON.stringify(allowed)).join(', ');
    push(instancePath, `${JSON.stringify(actual)} is not a known "${field}": expected one of ${allowedText}`);
  }

  return out;
}

/** Reads the value a JSON Pointer's segments name, for reporting what was actually there. */
function valueAtPointer(root: unknown, segments: PathSegment[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
}

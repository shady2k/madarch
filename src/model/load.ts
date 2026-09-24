import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { Value } from 'typebox/value';
import type { ModelError } from './errors.js';
import { ModelFile, type Category, type Element, type Interface, type IntendedModel, type Relation } from './schema.js';
import { checkStrictYaml } from './strict-yaml.js';
import {
  validateModel,
  type PositionedCategory,
  type PositionedElement,
  type PositionedInterface,
  type PositionedModel,
  type PositionedRelation,
  type TransferLines,
} from './validate.js';
import { jsonPointerToSegments, lineForPath, segmentsToPath } from './yaml-position.js';

export interface LoadResult {
  model?: IntendedModel;
  errors: ModelError[];
}

/**
 * Loads a repository's model: every `*.yaml` file directly inside its
 * `madarch/` folder, read in sorted file-name order and combined into one
 * model. YAML is parsed with the `yaml` package, which keeps source
 * positions so every error can name its file and line.
 *
 * Every file is read and checked independently, and every problem found
 * anywhere is collected before the loader gives up: one bad file does not
 * stop the others from being checked too. Within one file, a strict-YAML
 * violation or a parse error makes the rest of that file's content
 * unreliable, so schema validation is skipped for it; once every file has
 * parsed and matched the schema, ids and references are checked once
 * across the whole model. Each section (`elements`, `interfaces`,
 * `relations`, `categories`) concatenates across files, in the same fixed
 * file order.
 */
export function loadModel(repoRoot: string): LoadResult {
  const madarchDir = join(repoRoot, 'madarch');

  let fileNames: string[];
  try {
    fileNames = readdirSync(madarchDir)
      .filter((name) => name.endsWith('.yaml'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return {
      errors: [{ file: 'madarch', line: 1, path: '', message: 'the madarch folder was not found' }],
    };
  }

  const errors: ModelError[] = [];
  const positioned: PositionedModel = { elements: [], interfaces: [], relations: [], categories: [] };

  for (const fileName of fileNames) {
    const filePath = join(madarchDir, fileName);
    const relativeFile = relative(repoRoot, filePath);
    const text = readFileSync(filePath, 'utf8');
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, keepSourceTokens: true, merge: false });

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
    const fileErrors = normalizeErrors(Value.Errors(ModelFile, value));
    if (fileErrors.length > 0) {
      for (const fileError of fileErrors) {
        const segments = jsonPointerToSegments(fileError.instancePath);
        const line = lineForPath(doc, lineCounter, segments);
        errors.push({ file: relativeFile, line, path: segmentsToPath(segments), message: fileError.message });
      }
      continue;
    }

    const parsed = value as { version: 1; elements: Element[]; interfaces?: Interface[]; relations?: Relation[]; categories?: Category[] };
    const line = (segments: (string | number)[]) => lineForPath(doc, lineCounter, segments);

    parsed.elements.forEach((element, index) => {
      positioned.elements.push({
        element,
        file: relativeFile,
        line: line(['elements', index]),
        parentLine: line(['elements', index, 'parent']),
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
      });
    });

    (parsed.categories ?? []).forEach((category, index) => {
      positioned.categories.push({
        category,
        file: relativeFile,
        line: line(['categories', index]),
      });
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  const validationErrors = validateModel(positioned);
  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }

  return {
    model: {
      version: 1,
      elements: positioned.elements.map((entry) => entry.element),
      interfaces: positioned.interfaces.map((entry) => entry.iface),
      relations: positioned.relations.map((entry) => entry.relation),
      categories: positioned.categories.map((entry) => entry.category),
    },
    errors: [],
  };
}

interface NormalizedError {
  instancePath: string;
  message: string;
}

/**
 * TypeBox reports an unknown field twice under `additionalProperties:
 * false` (once at the field's own path with an uninformative message,
 * once at the object's path listing the extra names) and reports a
 * literal-union mismatch once per branch. This turns that into one clear
 * error per actual problem, each pointing at the exact offending value.
 */
function normalizeErrors(rawErrors: Iterable<{ keyword: string; instancePath: string; params: Record<string, unknown>; message: string }>): NormalizedError[] {
  const out: NormalizedError[] = [];
  const seen = new Set<string>();

  const push = (instancePath: string, message: string) => {
    const key = `${instancePath}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ instancePath, message });
  };

  for (const error of rawErrors) {
    if (error.keyword === 'const') continue; // covered by the union's own summary error
    if (error.keyword === 'boolean') continue; // the additionalProperties error below is clearer
    if (error.keyword === 'additionalProperties') {
      const names = (error.params.additionalProperties as string[] | undefined) ?? [];
      for (const name of names) {
        push(`${error.instancePath}/${name}`, `unknown field "${name}"`);
      }
      continue;
    }
    push(error.instancePath, error.message);
  }

  return out;
}

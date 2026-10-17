/**
 * The fill's product configuration read (decision 0027): `fill.stages.<id>`
 * in the product's own configuration file enables, disables and limits a
 * stage of the fill.
 *
 * The file is the product's manifest, `workspace.yaml` (decision 0021): it
 * is the product's configuration file madarch's own code reads, it is
 * versioned in the product's git the way decision 0027 asks, and a field
 * the manifest's reader does not know is ignored, so a product declaring
 * `fill.stages` still opens in a madarch older than the fill. The kinds
 * registry at `docs/kinds.yaml` is deliberately not the place: it is the
 * skill set's document contract, and its stage list names the wiki's
 * lifecycle stages, which decision 0027 keeps apart from the fill's
 * processing stages.
 *
 * The manifest's own parser (`parseManifest`) reads the file, so the two
 * readers can never disagree about what the manifest says. Every refusal
 * names the file, the 1-based line and the field's path from the top
 * (`fill.stages.inventory.enabled`). A field this reader does not know is
 * ignored, the manifest's own rule: a product's configuration grows by
 * fields a later madarch reads.
 *
 * This reader judges the shape of `fill.stages` and of each entry's
 * `enabled`, `concurrency` and `limits`. A stage's own `config` is judged
 * against that stage's `configSchema`, which only the registry holds, so
 * the stage graph refuses it (`src/fill/registry.ts`), naming the same file
 * and the line of the field inside it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineOf, MANIFEST_FILE, parseManifest } from '../product/manifest.js';
import type { StageLimits } from './stage.js';

/** One problem found in the product's fill configuration, named where it stands. */
export interface FillConfigError {
  /** The file relative to the product folder; always the manifest's name. */
  file: string;
  /** 1-based line in that file. */
  line: number;
  /** The field's path from the file's top, like `fill.stages.inventory.enabled`. */
  path: string;
  message: string;
}

/** The limits one stage's configuration may override, each optional. */
export type StageLimitOverrides = Partial<StageLimits>;

/** One stage's configuration, as the product declares it under `fill.stages.<id>`. */
export interface FillStageConfigurationEntry {
  /** Whether the stage runs; where it is left out, the stage's own default holds. */
  enabled?: boolean;
  /** How many units of the stage may run at once; where it is left out, the stage's own default holds. */
  concurrency?: number;
  /** The unit limits this product overrides; the rest keep the stage's own defaults. */
  limits?: StageLimitOverrides;
  /** The stage's own configuration, judged against the stage's `configSchema` at resolution. */
  config?: unknown;
}

/** What reading the product's fill configuration gave. */
export type FillStageConfigurationRead =
  | {
    ok: true;
    /** Each stage the product configures, by stage id. */
    stages: Record<string, FillStageConfigurationEntry>;
    /** The 1-based line each `fill.stages.<id>` stands on, by stage id, so a later refusal names its line. */
    lines: Record<string, number>;
  }
  | { ok: false; errors: FillConfigError[] };

/** A stage id a configuration may name: a word, the registry's own ids. */
const STAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** The whole non-negative numbers a limit count may be. */
const WHOLE_LIMITS: ReadonlySet<string> = new Set(['contextTokens', 'maxTurns', 'maxOutputTokens']);
/** The positive durations a limit may carry. */
const POSITIVE_LIMITS: ReadonlySet<string> = new Set(['maxDurationMs']);
/** The fractions between 0 and 1 a limit may carry. */
const FRACTION_LIMITS: ReadonlySet<string> = new Set(['wrapAtFraction', 'stopAtFraction']);

/** What reading an empty product configuration gives: no stage configured, none to name. */
const NOTHING_CONFIGURED: { ok: true; stages: Record<string, FillStageConfigurationEntry>; lines: Record<string, number> } =
  { ok: true, stages: {}, lines: {} };

/** A refusal of the whole configuration, at the file's own line. */
const refused = (file: string, line: number, path: string, message: string): { ok: false; errors: FillConfigError[] } =>
  ({ ok: false, errors: [{ file, line, path, message }] });

/**
 * Reads the product's fill configuration, fresh, from the product folder.
 * A folder holding no manifest reads as one with no fill configuration:
 * every stage keeps its own defaults. A manifest that does not read refuses
 * the configuration whole — the manifest's own refusal, at its own line —
 * since the same file standing damaged cannot be half trusted for the fill.
 */
export function readFillStageConfiguration(productFolder: string): FillStageConfigurationRead {
  const file = MANIFEST_FILE;
  const full = join(productFolder, file);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NOTHING_CONFIGURED;
    return refused(file, 1, '', `${file} could not be read: ${(error as Error).message}`);
  }
  const parsed = parseManifest(text, file);
  if (!parsed.ok) return refused(file, parsed.line, '', parsed.message);
  const value = parsed.value as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return NOTHING_CONFIGURED;

  const fill = value['fill'];
  if (fill === undefined) return NOTHING_CONFIGURED;
  if (fill === null || typeof fill !== 'object' || Array.isArray(fill)) {
    return refused(file, lineOf(value, 'fill'), 'fill', `fill is a mapping of the fill's own keys, not ${shown(fill)}`);
  }
  const fillMap = fill as Record<string, unknown>;
  const stages = fillMap['stages'];
  if (stages === undefined) return NOTHING_CONFIGURED;
  if (stages === null || typeof stages !== 'object' || Array.isArray(stages)) {
    return refused(file, lineOf(fillMap, 'stages'), 'fill.stages', `fill.stages is a mapping of stage ids to their configuration, not ${shown(stages)}`);
  }
  const stagesMap = stages as Record<string, unknown>;
  const errors: FillConfigError[] = [];
  const read: Record<string, FillStageConfigurationEntry> = {};
  const lines: Record<string, number> = {};
  for (const id of Object.keys(stagesMap)) {
    const path = `fill.stages.${id}`;
    const line = lineOf(stagesMap, id);
    if (!STAGE_ID_PATTERN.test(id)) {
      errors.push({ file, line, path, message: `"${id}" is not a stage id: a stage id is a word the registry registers` });
      continue;
    }
    const entry = stagesMap[id];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ file, line, path, message: `${path} is a mapping of the stage's configuration, not ${shown(entry)}` });
      continue;
    }
    const entryMap = entry as Record<string, unknown>;
    const readEntry: FillStageConfigurationEntry = {};
    const enabled = entryMap['enabled'];
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        errors.push({ file, line: lineOf(entryMap, 'enabled'), path: `${path}.enabled`, message: `${path}.enabled is true or false, not ${shown(enabled)}` });
      } else {
        readEntry.enabled = enabled;
      }
    }
    const concurrency = entryMap['concurrency'];
    if (concurrency !== undefined) {
      if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1) {
        errors.push({ file, line: lineOf(entryMap, 'concurrency'), path: `${path}.concurrency`, message: `${path}.concurrency is a whole number of 1 or more, not ${shown(concurrency)}` });
      } else {
        readEntry.concurrency = concurrency;
      }
    }
    const limits = entryMap['limits'];
    if (limits !== undefined) {
      if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
        errors.push({ file, line: lineOf(entryMap, 'limits'), path: `${path}.limits`, message: `${path}.limits is a mapping of limit names to their values, not ${shown(limits)}` });
      } else {
        const limitsMap = limits as Record<string, unknown>;
        const readLimits: StageLimitOverrides = {};
        for (const name of Object.keys(limitsMap)) {
          const limitPath = `${path}.limits.${name}`;
          const limitLine = lineOf(limitsMap, name);
          const limitValue = limitsMap[name];
          if (WHOLE_LIMITS.has(name)) {
            if (typeof limitValue !== 'number' || !Number.isInteger(limitValue) || limitValue < 0) {
              errors.push({ file, line: limitLine, path: limitPath, message: `${limitPath} is a whole number of 0 or more, not ${shown(limitValue)}` });
              continue;
            }
          } else if (POSITIVE_LIMITS.has(name)) {
            if (typeof limitValue !== 'number' || !Number.isInteger(limitValue) || limitValue < 1) {
              errors.push({ file, line: limitLine, path: limitPath, message: `${limitPath} is a whole number of 1 or more, not ${shown(limitValue)}` });
              continue;
            }
          } else if (FRACTION_LIMITS.has(name)) {
            if (typeof limitValue !== 'number' || !Number.isFinite(limitValue) || limitValue <= 0 || limitValue >= 1) {
              errors.push({ file, line: limitLine, path: limitPath, message: `${limitPath} is a fraction between 0 and 1, not ${shown(limitValue)}` });
              continue;
            }
          } else {
            // A limit name this madarch does not know is the manifest's
            // own unknown field: kept out, never a refusal, so a product's
            // configuration written for a later madarch still reads.
            continue;
          }
          readLimits[name as keyof StageLimits] = limitValue;
        }
        readEntry.limits = readLimits;
      }
    }
    if ('config' in entryMap) readEntry.config = entryMap['config'];
    read[id] = readEntry;
    lines[id] = line;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, stages: read, lines };
}

/** How one parsed value stands in a refusal: as YAML would read it back. */
function shown(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

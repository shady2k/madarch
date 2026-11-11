/**
 * The language producer's heuristic rules (madarch-j9ao.1, item 7): when a path's extension is one
 * several languages claim, GitHub Linguist's own `heuristics.yml` decides among them — the file
 * vendored under `linguist/` from github-linguist v9.7.0, never a rule of ours. The ordered rules
 * for the extension are evaluated with Oniguruma (`vscode-oniguruma`, the engine Ruby's `Regexp` is
 * built on), over the first 50 KiB of the text, as linguist's `HEURISTICS_CONSIDER_BYTES` states.
 *
 * The result is one language where the rules decide it, or nothing where they name several or none:
 * the caller keeps the dataset's candidates then, and the claim says the same.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { loadWASM, createOnigScanner, type OnigScanner } from 'vscode-oniguruma';
import heuristicsText from './linguist/heuristics.yml' with { type: 'text' };
import onigurumaWasm from 'vscode-oniguruma/release/onig.wasm' with { type: 'file' };

/** How much of a file linguist's rules consider: its first 50 KiB (`HEURISTICS_CONSIDER_BYTES`). */
export const HEURISTICS_CONSIDER_BYTES = 50 * 1024;

/** A rule's condition, as linguist reads it (`and` of these, a `pattern` list read as an alternative, a negation). */
type Condition =
  | { readonly type: 'always' }
  | { readonly type: 'pattern'; readonly scanner: OnigScanner }
  | { readonly type: 'negative'; readonly scanner: OnigScanner }
  | { readonly type: 'and'; readonly parts: readonly Condition[] };

interface Rule {
  /** The language the rule names, or the several it cannot choose between. */
  readonly language: string | readonly string[];
  readonly condition: Condition;
}

interface Disambiguation {
  readonly extensions: readonly string[];
  readonly rules: readonly Rule[];
}

interface HeuristicsData {
  readonly disambiguations: readonly Disambiguation[];
  readonly named: ReadonlyMap<string, OnigScanner[]>;
}

let loaded: Promise<HeuristicsData> | undefined;

/** A Ruby/Oniguruma pattern as one scanner: `findNextMatchSync` answers every pattern, the first match wins. */
function scannerOf(patterns: readonly string[]): OnigScanner {
  return createOnigScanner([...patterns]);
}

/** Whether a text holds a match of the condition, by linguist's own semantics. */
function matches(condition: Condition, text: string): boolean {
  switch (condition.type) {
    case 'always': return true;
    case 'pattern': return condition.scanner.findNextMatchSync(text, 0) !== null;
    case 'negative': return condition.scanner.findNextMatchSync(text, 0) === null;
    case 'and': return condition.parts.every((part) => matches(part, text));
  }
}

function conditionOf(rule: Record<string, unknown>, named: ReadonlyMap<string, OnigScanner[]>): Condition {
  // The order is linguist's (`Heuristics.parse_rule`): `and`, then `pattern`, then `negative_pattern`, then
  // `named_pattern`, and a rule with none of them always matches (the extension's default language).
  if (Array.isArray(rule['and'])) return { type: 'and', parts: (rule['and'] as Record<string, unknown>[]).map((part) => conditionOf(part, named)) };
  if (rule['pattern'] !== undefined) {
    const patterns = Array.isArray(rule['pattern']) ? rule['pattern'].map(String) : [String(rule['pattern'])];
    return { type: 'pattern', scanner: scannerOf(patterns) };
  }
  if (rule['negative_pattern'] !== undefined) return { type: 'negative', scanner: scannerOf([String(rule['negative_pattern'])]) };
  const name = rule['named_pattern'];
  if (typeof name === 'string') {
    const scanner = named.get(name);
    if (scanner === undefined) throw new Error(`src/fill/stages/linguist/heuristics.yml: the rule names the pattern ${JSON.stringify(name)}, and the file declares none`);
    return { type: 'pattern', scanner: scanner[0]! };
  }
  return { type: 'always' };
}

/** The vendored data, parsed and compiled once per process. */
function load(): Promise<HeuristicsData> {
  loaded ??= (async () => {
    const wasm = readFileSync(onigurumaWasm);
    await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const data = parse(heuristicsText) as { disambiguations: { extensions: string[]; rules: Record<string, unknown>[] }[]; named_patterns: Record<string, string | string[]> };
    const named = new Map<string, OnigScanner[]>();
    for (const [name, value] of Object.entries(data.named_patterns)) named.set(name, [scannerOf(Array.isArray(value) ? value : [value])]);
    return {
      disambiguations: data.disambiguations.map((disambiguation) => ({
        extensions: disambiguation.extensions.map((extension) => extension.toLowerCase()),
        rules: disambiguation.rules.map((rule) => ({ language: typeof rule['language'] === 'string' ? rule['language'] : (rule['language'] as string[]).map(String), condition: conditionOf(rule, named) })),
      })),
      named,
    };
  })();
  return loaded;
}

/** The first rule set whose extension the path's lower-cased name ends with, as linguist finds it. */
function disambiguationOf(path: string, data: HeuristicsData): Disambiguation | undefined {
  const name = path.toLowerCase();
  return data.disambiguations.find((entry) => entry.extensions.some((extension) => name.endsWith(extension)));
}

/** A content's first `limit` bytes, decoded as UTF-8: the part linguist's rules read. */
export function firstBytes(content: string, limit: number): string {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= limit) return content;
  let end = limit;
  // Do not cut a UTF-8 sequence in two: a continuation byte starts with 10xxxxxx.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** What the rules answer for a path: one language, or nothing where they name several or none. */
export interface LanguageDecision {
  readonly language: string;
}

/**
 * The language GitHub Linguist's rules decide for a path and its text, when the dataset's candidates
 * name several languages. Nothing is returned where no rule set covers the path, where the matching
 * rule names several languages, or where the language it names is not one of the candidates (the data
 * and the dataset disagree then, and the producer keeps the candidates rather than invent one).
 */
export async function decideLanguage(path: string, content: string, candidates: readonly string[]): Promise<LanguageDecision | undefined> {
  const data = await load();
  const entry = disambiguationOf(path, data);
  if (entry === undefined) return undefined;
  const text = firstBytes(content, HEURISTICS_CONSIDER_BYTES);
  for (const rule of entry.rules) {
    if (!matches(rule.condition, text)) continue;
    if (typeof rule.language !== 'string') return undefined;
    return candidates.includes(rule.language) ? { language: rule.language } : undefined;
  }
  return undefined;
}

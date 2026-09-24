import { isAlias, isMap, isPair, isScalar, isSeq, visit, type Document, type LineCounter } from 'yaml';
import type { ModelError } from './errors.js';
import { segmentsToPath, type PathSegment } from './yaml-position.js';

type Range = readonly [number, number, number] | undefined;

/**
 * Refuses anchors, aliases, merge keys, custom tags and duplicate keys. The
 * `yaml` package parses all of them without complaint by default, so
 * strictness is enforced here by walking the parsed tree.
 *
 * Duplicate keys are found by this module's own walk, not the parser's
 * `uniqueKeys` option (the caller turns that off): the option's own error
 * has no path and cannot say which key repeated, only that some map has a
 * duplicate, whereas the model needs "the file, the line and the key" (the
 * `strict-yaml`/`duplicate-key` requirement).
 */
export function checkStrictYaml(doc: Document, lineCounter: LineCounter, file: string, text: string): ModelError[] {
  const errors: ModelError[] = [];

  const lineOf = (range: Range): number => (range ? lineCounter.linePos(range[0]).line : 1);

  /**
   * The node an anchor decorates has its own range start *after* the
   * `&name` marker (the marker belongs to the enclosing sequence or
   * mapping item, which `visit` does not expose here), so the node's own
   * range would point one line too late. The marker itself is found by
   * scanning backwards in the source for the last `&name` before the
   * node it decorates.
   */
  const anchorLine = (name: string, beforeOffset: number): number => {
    const pattern = new RegExp(`&${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    let offset = -1;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && match.index < beforeOffset) {
      offset = match.index;
    }
    return offset >= 0 ? lineCounter.linePos(offset).line : lineOf([beforeOffset, beforeOffset, beforeOffset]);
  };

  visit(doc, (_key, node) => {
    if (node === null || typeof node !== 'object') return;

    if (isAlias(node)) {
      errors.push({
        file,
        line: lineOf(node.range as Range),
        path: '',
        message: `alias "*${node.source}" is not allowed: strict YAML forbids aliases`,
      });
      return;
    }

    if (isPair(node)) {
      if (isScalar(node.key) && node.key.value === '<<') {
        errors.push({
          file,
          line: lineOf(node.key.range as Range),
          path: '',
          message: 'merge key "<<" is not allowed: strict YAML forbids merge keys',
        });
      }
      return;
    }

    const withAnchor = node as { anchor?: string; range?: Range };
    if (withAnchor.anchor) {
      const start = withAnchor.range?.[0] ?? 0;
      errors.push({
        file,
        line: anchorLine(withAnchor.anchor, start),
        path: '',
        message: `anchor "&${withAnchor.anchor}" is not allowed: strict YAML forbids anchors`,
      });
    }

    const withTag = node as { tag?: string; range?: Range };
    if (withTag.tag) {
      // Refuses every explicit tag, core-schema ones (`!!str`) included, not
      // only custom ones: the simpler strict reading of "strict YAML forbids
      // custom tags", since core tags carry the same risk of the file
      // meaning something other than what its plain values show.
      errors.push({
        file,
        line: lineOf(withTag.range),
        path: '',
        message: `explicit tag "${withTag.tag}" is not allowed: strict YAML forbids explicit tags`,
      });
    }
  });

  errors.push(...checkDuplicateKeys(doc.contents, lineCounter, file));

  return errors;
}

/**
 * Walks the document looking for a map with the same key twice, reporting
 * one error per repeated key at its last occurrence, naming the key and
 * its path from the model's top (`elements[0].parent`, not just `parent`).
 * Only scalar keys are considered: a non-scalar key is already unusual
 * enough (and, if it comes from an alias or a merge key, already refused
 * on its own).
 */
function checkDuplicateKeys(node: unknown, lineCounter: LineCounter, file: string): ModelError[] {
  const errors: ModelError[] = [];

  const walk = (current: unknown, segments: PathSegment[]): void => {
    if (isMap(current)) {
      const byKey = new Map<string, { key: { range?: Range }; value: unknown }[]>();
      for (const item of current.items) {
        if (!isScalar(item.key)) continue;
        const keyValue = String(item.key.value);
        const entry = { key: item.key as { range?: Range }, value: item.value };
        const group = byKey.get(keyValue);
        if (group) group.push(entry);
        else byKey.set(keyValue, [entry]);
      }

      for (const [keyValue, group] of byKey) {
        if (group.length < 2) continue;
        const path = segmentsToPath([...segments, keyValue]);
        const last = group[group.length - 1]!;
        errors.push({
          file,
          line: last.key.range ? lineCounter.linePos(last.key.range[0]).line : 1,
          path,
          message: `key "${keyValue}" is repeated at "${path}": strict YAML forbids a duplicate key`,
        });
      }

      for (const [keyValue, group] of byKey) {
        // Recurse from the last occurrence, the one whose value the
        // document actually resolves to (and the one the duplicate error
        // above points at).
        walk(group[group.length - 1]!.value, [...segments, keyValue]);
      }
      return;
    }

    if (isSeq(current)) {
      current.items.forEach((item, index) => walk(item, [...segments, index]));
    }
  };

  walk(node, []);
  return errors;
}

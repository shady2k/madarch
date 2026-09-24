import { isAlias, isPair, isScalar, visit, type Document, type LineCounter } from 'yaml';
import type { ModelError } from './errors.js';

type Range = readonly [number, number, number] | undefined;

/**
 * Refuses anchors, aliases, merge keys and custom tags. The `yaml` package
 * parses all of them without complaint, so strictness is enforced here by
 * walking the parsed tree. Duplicate keys need no code of their own: with
 * the parser's default `uniqueKeys`, they already surface as ordinary parse
 * errors (`doc.errors`), which the caller reports the same way.
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
      errors.push({
        file,
        line: lineOf(withTag.range),
        path: '',
        message: `custom tag "${withTag.tag}" is not allowed: strict YAML forbids custom tags`,
      });
    }
  });

  return errors;
}

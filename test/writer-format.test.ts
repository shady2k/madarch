/** A document's anchors: its heading slugs, its bold list phrases and their identifiers (the knowledge page format's targets). */
import { describe, expect, test } from 'bun:test';
import { documentAnchors, slugOf } from '../src/knowledge/anchors.js';

describe('targets and document anchors', () => {
  test('a document\'s anchors are its heading slugs, its bold list phrases and their identifiers', () => {
    const anchors = documentAnchors([
      '# Requirements', '', '## Use cases', '', '- **UC-1 Place order.** A shopper submits a cart.', '1. **Pay** - the shopper pays.', '',
      '## Use cases', '', '```', '# not a heading', '```', '', '# ADR-0001 Broker',
    ].join('\n'));
    expect(anchors).toEqual(['adr-0001', 'adr-0001-broker', 'pay', 'requirements', 'uc-1', 'uc-1-place-order', 'use-cases', 'use-cases-1']);
    expect(slugOf('What the **value** is?')).toBe('what-the-value-is');
  });
});

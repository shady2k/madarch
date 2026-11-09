/**
 * The links the core writes where an agent wrote a known name (madarch-ztyq.8; decision 0032, section 8).
 * The rendered targets are read from the tree, so invisible links and unused footnote definitions are not
 * parsed, rendered targets.
 */
import { describe, expect, test } from 'bun:test';
import { madarchTargets } from '../src/writer/mentions.js';

describe('remark structure, not character patterns, decides what is prose', () => {
  test('invisible links and unused footnote definitions are not parsed, rendered targets', () => {
    const page = [
      'Kafka[^used]',
      '',
      '<!-- [Kafka](madarch:code.broker:kafka) -->',
      '',
      '[^used]: [Kafka](madarch:code.broker:kafka)',
      '',
      '[^unused]: [Kafka](madarch:code.broker:kafka)',
    ].join('\n');
    expect(madarchTargets(page)).toEqual(['code.broker:kafka']);
    const unused = ['Kafka', '', '<!-- [Kafka](madarch:code.broker:kafka) -->', '', '[^unused]: [Kafka](madarch:code.broker:kafka)'].join('\n');
    expect(madarchTargets(unused)).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDiscussionMessage, scanDiscussionMarkers } from '../src/product/discussion-contract.js';

const suite = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/contract/discussion-cases.json', import.meta.url)), 'utf8')) as {
  cases: { name: string; path: string; text: string; ok?: boolean; line?: number; message?: string; source?: string; markerLine?: number; markerMessage?: string }[];
};

describe('published discussion-message contract cases', () => {
  for (const one of suite.cases) {
    test(one.name, () => {
      const read = parseDiscussionMessage(one.path, one.text);
      if (one.ok === false) {
        expect(read.ok).toBe(false);
        if (read.ok) return;
        expect(read.errors.some((error) => error.line === one.line && error.message.includes(one.message ?? ''))).toBe(true);
      } else expect(read.ok).toBe(true);
      if (one.source === undefined) return;
      const markers = scanDiscussionMarkers('docs/vision.md', one.source);
      if (one.markerMessage === undefined) expect(markers.errors).toEqual([]);
      else expect(markers.errors.some((error) => error.line === one.markerLine && error.message.includes(one.markerMessage!))).toBe(true);
    });
  }
});

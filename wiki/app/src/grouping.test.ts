/**
 * The navigation's grouping rule (walk 2, finding 3): the first folder under
 * `docs/` names the kind at any depth, so a described repository's pages —
 * `docs/repositories/<name>/architecture.md` — stand in the repository group
 * instead of falling out of every kind into "Other".
 */
import { describe, expect, test } from 'bun:test';
import { groupOf, kindOf } from './shell.js';

describe('the navigation groups a page by the first folder under docs, at any depth', () => {
  test('the two-segment paths keep their groups', () => {
    expect(groupOf('README.md')).toBe('product');
    expect(groupOf('docs/vision.md')).toBe('product');
    expect(groupOf('docs/requirements/reading.md')).toBe('requirements');
    expect(groupOf('docs/questions/Q-001-open.md')).toBe('questions');
  });

  test('a described repository page stands in the repositories group, not Other', () => {
    expect(groupOf('docs/repositories/library/architecture.md')).toBe('repositories');
    expect(groupOf('docs/repositories/library/decisions/0001-slug.md')).toBe('repositories');
    expect(kindOf('docs/repositories/library/architecture.md', 'repositories')).toBe('REPOSITORY');
  });

  test('a path outside docs stays Other', () => {
    expect(groupOf('skills/own.md')).toBe('other');
  });
});

/**
 * The navigation's grouping rule (walk 2, finding 3): the first folder under
 * `docs/` names the kind at any depth, so a described repository's pages —
 * `docs/repositories/<name>/architecture.md` — stand in the repository group
 * instead of falling out of every kind into "Other".
 */
import { describe, expect, test } from 'bun:test';
import { displayGroupLabel, groupOf, kindOf, localizedRegistryLabel } from './shell.js';

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


describe('localized registry labels in the shell', () => {
  test('plain path groups keep their translated or humanized labels', () => {
    const translate = (key: string, options?: { defaultValue: string }): string => key === 'groups.research' ? 'Research' : options?.defaultValue ?? key;
    expect(displayGroupLabel('research', null, 'en', translate)).toBe('Research');
    expect(displayGroupLabel('my-group', null, 'en', translate)).toBe('My Group');
  });

  test('a registered kind with no active-locale label shows its manifest name', () => {
    const offer = {
      present: true as const,
      stages: [{ id: 'idea' }],
      kinds: [{ name: 'research', prefix: 'R', folder: 'docs/research', stage: 'idea', hint: 'one' }],
    };
    const translate = (key: string, options?: { defaultValue: string }): string => options?.defaultValue ?? key;
    expect(displayGroupLabel('research', offer, 'ru', translate)).toBe('research');
  });

  test('selects only the requested locale', () => {
    const entry = { name: 'Source', labels: { en: 'Source', ru: 'Источник' } };
    expect(localizedRegistryLabel(entry, 'en')).toBe('Source');
    expect(localizedRegistryLabel(entry, 'ru')).toBe('Источник');
  });

  test('uses the manifest name unchanged when the active locale label is absent', () => {
    expect(localizedRegistryLabel({ name: 'Source', id: 'source', labels: { en: 'English only' } }, 'ru'))
      .toBe('Source');
    expect(localizedRegistryLabel({ name: 'Source', id: 'source' }, 'ru'))
      .toBe('Source');
  });

  test('uses the stage name, or its id when it has no name, unchanged', () => {
    expect(localizedRegistryLabel({ id: 'idea', name: 'Idea' }, 'ru')).toBe('Idea');
    expect(localizedRegistryLabel({ id: 'idea' }, 'ru')).toBe('idea');
  });
});

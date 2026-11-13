/** The system Git floor belongs to declared Git producers, never to the whole fill. */
import { expect, test } from 'bun:test';
import { systemGit } from '../src/plugin/system-git.js';

test('system Git 2.40 is the producer floor, including vendor and Windows version suffixes', () => {
  for (const version of ['2.40.0', '2.43.0', '3.0.0', '2.43.0.windows.1', '2.43.0 (Apple Git-1)']) {
    expect(systemGit('2.40', {}, { resolve: () => '/fixture/git', version: () => `git version ${version}` })).toEqual({ name: 'git', executable: '/fixture/git' });
  }
});

test('old, malformed and unavailable Git refuse with a producer-local repair instruction', () => {
  for (const said of ['git version 2.39.5', 'not git at all']) {
    expect(() => systemGit('2.40', {}, { resolve: () => '/fixture/git', version: () => said })).toThrow('Git 2.40 or newer');
    expect(() => systemGit('2.40', {}, { resolve: () => '/fixture/git', version: () => said })).toThrow(said);
  }
  expect(() => systemGit('2.40', {}, { resolve: () => null, version: () => { throw new Error('must not probe'); } })).toThrow('no git executable on PATH');
  expect(() => systemGit('2.40', {}, { resolve: () => '/fixture/git', version: () => { throw new Error('cannot execute'); } })).toThrow('could not run --version');
});

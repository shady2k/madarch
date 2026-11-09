/**
 * The web address of a code place (madarch-m38l.8): each host shape the engine
 * knows, each remote shape git writes, and the hosts it must not guess.
 */
import { describe, expect, test } from 'bun:test';
import { parseRemote, webLink } from '../src/knowledge/index/web-link.js';

const commit = '0123456789abcdef0123456789abcdef01234567';
const path = 'services/payments/src/refund.ts';

describe('webLink: one address shape per host', () => {
  test('GitHub over https, ssh (scp-like), ssh:// with a port and git://', () => {
    const expected = { host: 'GitHub' as const, url: `https://github.com/acme/shop/blob/${commit}/${path}#L10-L20` };
    for (const origin of ['https://github.com/acme/shop.git', 'https://github.com/acme/shop', 'git@github.com:acme/shop.git', 'ssh://git@github.com:22/acme/shop.git', 'git://github.com/acme/shop.git', 'https://github.com/acme/shop/']) {
      expect(webLink({ origin, commit, path, lineStart: 10, lineEnd: 20 })).toEqual(expected);
    }
  });

  test('GitHub: one line, no line, and a path that needs escaping', () => {
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit, path, lineStart: 7 })?.url).toBe(`https://github.com/acme/shop/blob/${commit}/${path}#L7`);
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit, path, lineStart: 7, lineEnd: 7 })?.url).toBe(`https://github.com/acme/shop/blob/${commit}/${path}#L7`);
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit, path })?.url).toBe(`https://github.com/acme/shop/blob/${commit}/${path}`);
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit, path: 'docs/a b#c.md' })?.url).toBe(`https://github.com/acme/shop/blob/${commit}/docs/a%20b%23c.md`);
  });

  test('GitLab: subgroups, the /-/ route and the L10-20 range', () => {
    for (const origin of ['git@gitlab.com:acme/platform/shop.git', 'https://gitlab.com/acme/platform/shop.git', 'ssh://git@gitlab.com/acme/platform/shop.git']) {
      expect(webLink({ origin, commit, path, lineStart: 10, lineEnd: 20 })).toEqual({ host: 'GitLab', url: `https://gitlab.com/acme/platform/shop/-/blob/${commit}/${path}#L10-20` });
    }
    expect(webLink({ origin: 'git@gitlab.example.org:acme/shop.git', commit, path, lineStart: 3 })?.url).toBe(`https://gitlab.example.org/acme/shop/-/blob/${commit}/${path}#L3`);
  });

  test('Bitbucket: the src route and the lines-10:20 anchor', () => {
    for (const origin of ['git@bitbucket.org:acme/shop.git', 'https://bitbucket.org/acme/shop.git', 'https://someone@bitbucket.org/acme/shop.git']) {
      expect(webLink({ origin, commit, path, lineStart: 10, lineEnd: 20 })).toEqual({ host: 'Bitbucket', url: `https://bitbucket.org/acme/shop/src/${commit}/${path}#lines-10:20` });
    }
    expect(webLink({ origin: 'git@bitbucket.org:acme/shop.git', commit, path, lineStart: 4 })?.url).toBe(`https://bitbucket.org/acme/shop/src/${commit}/${path}#lines-4`);
  });

  test('Gitea and Forgejo: the src/commit route', () => {
    expect(webLink({ origin: 'git@gitea.example.org:acme/shop.git', commit, path, lineStart: 10, lineEnd: 20 })).toEqual({ host: 'Gitea', url: `https://gitea.example.org/acme/shop/src/commit/${commit}/${path}#L10-L20` });
    expect(webLink({ origin: 'https://codeberg.org/acme/shop.git', commit, path, lineStart: 5 })).toEqual({ host: 'Forgejo', url: `https://codeberg.org/acme/shop/src/commit/${commit}/${path}#L5` });
    expect(webLink({ origin: 'ssh://git@forgejo.example.org:2222/acme/shop.git', commit, path })).toEqual({ host: 'Forgejo', url: `https://forgejo.example.org/acme/shop/src/commit/${commit}/${path}` });
  });

  test('an https remote with a port keeps the web port; an ssh port is dropped', () => {
    expect(webLink({ origin: 'https://gitea.example.org:3000/acme/shop.git', commit, path })?.url).toBe(`https://gitea.example.org:3000/acme/shop/src/commit/${commit}/${path}`);
    expect(webLink({ origin: 'ssh://git@gitea.example.org:2222/acme/shop.git', commit, path })?.url).toBe(`https://gitea.example.org/acme/shop/src/commit/${commit}/${path}`);
  });

  test('credentials in a remote never reach the address', () => {
    const link = webLink({ origin: 'https://user:secret-token@github.com/acme/shop.git', commit, path });
    expect(link?.url).toBe(`https://github.com/acme/shop/blob/${commit}/${path}`);
    expect(link?.url).not.toContain('secret');
  });
});

describe('webLink: no link rather than a wrong one', () => {
  test('an unknown host, a local path, a file URL, an empty origin and a malformed remote give none', () => {
    for (const origin of ['git@git.internal.example:acme/shop.git', 'https://code.example.org/acme/shop.git', '/srv/repos/shop', 'file:///srv/repos/shop', '', '   ', 'https://github.com/', 'https://github.com/onlyowner', 'git@github.com:', '../shop']) {
      expect(webLink({ origin, commit, path, lineStart: 1 })).toBeUndefined();
    }
  });

  test('a missing commit or path gives none', () => {
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit: '', path })).toBeUndefined();
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit, path: '' })).toBeUndefined();
  });

  test('a line that is no positive whole number is left out of the address, not guessed', () => {
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit, path, lineStart: 0 })?.url).toBe(`https://github.com/acme/shop/blob/${commit}/${path}`);
    expect(webLink({ origin: 'git@github.com:acme/shop.git', commit, path, lineStart: 1.5 })?.url).toBe(`https://github.com/acme/shop/blob/${commit}/${path}`);
  });
});

describe('parseRemote', () => {
  test('reads host and repository apart', () => {
    expect(parseRemote('git@gitlab.com:acme/b/c.git')).toEqual({ host: 'gitlab.com', repository: 'acme/b/c', scheme: 'https', port: undefined });
    expect(parseRemote('http://Host.Example:8080/acme/b')).toEqual({ host: 'host.example', repository: 'acme/b', scheme: 'http', port: '8080' });
  });
});

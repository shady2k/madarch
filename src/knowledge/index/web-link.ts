/**
 * The web address of a code place (owner's wish, 2026-10-23: "open the web
 * version of github, gitlab or whatever the user has"). A page records, per
 * repository it was written from, the commit, the branch and the origin URL
 * (`written-at` in its front matter). From those and a path with lines this
 * module builds the address that host serves for that file at that commit.
 *
 * Hosts are known by name: GitHub, GitLab, Bitbucket Cloud, and Gitea or
 * Forgejo (including Codeberg). A host the module does not know gets no link:
 * a wrong address is worse than none. Remotes are read in every shape git
 * writes: `https://host/owner/repo(.git)`, `ssh://git@host[:port]/owner/repo`,
 * scp-like `git@host:owner/repo.git`, and `git://`. Credentials in a URL are
 * never kept.
 */

/** A web link for a code place: the label the reader sees ("Open in GitHub"'s host name) and the address. */
export interface WebLink {
  readonly host: 'GitHub' | 'GitLab' | 'Bitbucket' | 'Gitea' | 'Forgejo';
  readonly url: string;
}

/** A remote read apart: the host name (lower case, no port, no credentials) and the repository path without `.git`. */
export interface Remote {
  readonly host: string;
  /** `owner/repo`, or `group/subgroup/repo`. */
  readonly repository: string;
  /** The web scheme the remote implies: `http` only when the remote said so. */
  readonly scheme: 'https' | 'http';
  /** A port of the web address, when a web remote carried one; an ssh port is not the web port and is dropped. */
  readonly port: string | undefined;
}

/** Reads a git remote URL; `undefined` when it has no host or no repository path. */
export function parseRemote(origin: string): Remote | undefined {
  const text = origin.trim();
  if (text === '') return undefined;
  const clean = (path: string): string | undefined => {
    const repository = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    return repository.includes('/') && !repository.split('/').some((part) => part === '' || part === '.' || part === '..') ? repository : undefined;
  };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (scheme !== null) {
    const protocol = scheme[1]!.toLowerCase();
    const rest = scheme[2]!;
    const slash = rest.indexOf('/');
    if (slash < 0) return undefined;
    const authority = rest.slice(0, slash);
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const colon = hostPort.lastIndexOf(':');
    const host = (colon >= 0 && /^\d*$/.test(hostPort.slice(colon + 1)) ? hostPort.slice(0, colon) : hostPort).toLowerCase();
    const port = colon >= 0 && /^\d+$/.test(hostPort.slice(colon + 1)) ? hostPort.slice(colon + 1) : undefined;
    if (host === '' || host.includes('[')) return undefined;
    const repository = clean(rest.slice(slash));
    if (repository === undefined) return undefined;
    const web = protocol === 'https' || protocol === 'http';
    return { host, repository, scheme: protocol === 'http' ? 'http' : 'https', port: web ? port : undefined };
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
  if (scp !== null) {
    const repository = clean(scp[2]!);
    return repository === undefined ? undefined : { host: scp[1]!.toLowerCase(), repository, scheme: 'https', port: undefined };
  }
  return undefined;
}

type HostKind = WebLink['host'];

/** Which web interface a host name serves; `undefined` for a host not known. */
export function hostKind(host: string): HostKind | undefined {
  const name = host.replace(/^www\./, '');
  if (name === 'github.com') return 'GitHub';
  if (name === 'gitlab.com' || name.startsWith('gitlab.')) return 'GitLab';
  if (name === 'bitbucket.org') return 'Bitbucket';
  if (name === 'codeberg.org' || name.startsWith('forgejo.')) return 'Forgejo';
  if (name === 'gitea.com' || name.startsWith('gitea.')) return 'Gitea';
  return undefined;
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export interface PlaceInput {
  readonly origin: string;
  readonly commit: string;
  /** The file's path in the repository, `/`-separated. */
  readonly path: string;
  /** 1-based lines; `lineEnd` defaults to `lineStart`. Without `lineStart` the link opens the file. */
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/** The address of the file (and lines) at the commit on the origin's web host, or `undefined` when the host is not known or the origin is unreadable. */
export function webLink(place: PlaceInput): WebLink | undefined {
  const remote = parseRemote(place.origin);
  if (remote === undefined || place.commit === '' || place.path === '' || /[\s#?]/.test(place.commit)) return undefined;
  const host = hostKind(remote.host);
  if (host === undefined) return undefined;
  const base = `${remote.scheme}://${remote.host}${remote.port === undefined ? '' : `:${remote.port}`}/${encodePath(remote.repository)}`;
  const file = encodePath(place.path);
  const start = place.lineStart;
  const end = place.lineEnd !== undefined && start !== undefined && place.lineEnd > start ? place.lineEnd : undefined;
  const valid = start !== undefined && Number.isInteger(start) && start >= 1 && (end === undefined || Number.isInteger(end));
  switch (host) {
    case 'GitHub':
      return { host, url: `${base}/blob/${place.commit}/${file}${valid ? `#L${start}${end === undefined ? '' : `-L${end}`}` : ''}` };
    case 'GitLab':
      return { host, url: `${base}/-/blob/${place.commit}/${file}${valid ? `#L${start}${end === undefined ? '' : `-${end}`}` : ''}` };
    case 'Bitbucket':
      return { host, url: `${base}/src/${place.commit}/${file}${valid ? `#lines-${start}${end === undefined ? '' : `:${end}`}` : ''}` };
    case 'Gitea':
    case 'Forgejo':
      return { host, url: `${base}/src/commit/${place.commit}/${file}${valid ? `#L${start}${end === undefined ? '' : `-L${end}`}` : ''}` };
  }
}

/**
 * The wiki's one page mechanism (decision 0036, sections 6 and 7): the app reads the product's bootstrap once, composes
 * the page its address names, and asks the graph one operation for it. A press re-asks the same operation with the
 * variables the press named; nothing of the product is known here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { composePage, splitResponse, type Bootstrap, type PageComposition } from '../../../src/page-contract/index.js';
import { basePathOf, codesOf, postQuery, readBootstrap } from './client.js';
import { parseAddress } from './address.js';
import { PageView, type PageRuntime } from './page.js';
import { ShellFrame } from './components/ui/shell.js';
import { Button, Select } from './components/ui/controls.js';
import { Inline, PageColumn, Stack } from './components/ui/layout.js';
import { Notice } from './components/ui/data.js';
import { Link } from './components/ui/typography.js';
import { STALE_STRUCTURE } from './stale.js';

const LANGUAGE_KEY = 'madarch-wiki-language';
const ROLE_KEY = 'madarch-wiki-role';

function stored(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
}

/** What one page's answer holds: its composition, the variables it was asked with and the sections' data. */
interface Loaded {
  readonly composition: PageComposition;
  readonly variables: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

export function App(): ReactElement {
  const [base] = useState(() => basePathOf(window.location.pathname));
  const [path, setPath] = useState(() => window.location.pathname.slice(base.length) + window.location.search);
  const [language, setLanguage] = useState(() => stored(LANGUAGE_KEY, document.documentElement.lang || 'en'));
  const [role, setRole] = useState(() => stored(ROLE_KEY, 'all'));
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bootstrapVersion = useRef(0);
  const alive = useRef(true);

  const address = useMemo(() => {
    const [pathname, search = ''] = path.split('?');
    return parseAddress(pathname ?? '/', `?${search}`, '');
  }, [path]);

  const open = useCallback((next: string): void => {
    window.history.pushState({}, '', base + next);
    setPath(next);
    // A press on a link scrolls the page it opens to its top, as a page load would.
    window.scrollTo(0, 0);
  }, [base]);

  useEffect(() => {
    const follow = (): void => { setPath(window.location.pathname.slice(base.length) + window.location.search); };
    window.addEventListener('popstate', follow);
    return () => { window.removeEventListener('popstate', follow); };
  }, [base]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadBootstrap = useCallback(async (): Promise<Bootstrap | undefined> => {
    const read = await readBootstrap(base, language);
    if (!alive.current) return undefined;
    bootstrapVersion.current += 1;
    if (read.bootstrap === undefined) {
      setFailure(read.message ?? 'the bootstrap could not be read');
      return undefined;
    }
    setBootstrap(read.bootstrap);
    return read.bootstrap;
  }, [base, language]);

  // The bootstrap is read once per structure: its templates and the pages they open change only with a product's files.
  useEffect(() => {
    setBootstrap(null);
    void loadBootstrap();
  }, [loadBootstrap]);

  const ask = useCallback(async (composition: PageComposition, variables: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    const answer = await postQuery<Record<string, unknown>>(base, composition.operation, variables);
    if (!alive.current) return;
    setBusy(false);
    const codes = codesOf(answer.errors);
    if (answer.errors.length > 0) {
      if (codes.includes(STALE_STRUCTURE) && bootstrap !== null) {
        const read = await loadBootstrap();
        if (read !== undefined) {
          const again = composePage(read, { ...address.page, lang: language, role, ...(address.home ? { home: true } : {}) });
          if (again.findings.length === 0) await ask(again, again.variables);
        }
        return;
      }
      setFailure(answer.errors.map((error) => error.message).join('; '));
      return;
    }
    setFailure(null);
    setLoaded({ composition, variables, data: splitResponse(composition, answer.data ?? {}) });
  }, [address, base, bootstrap, language, loadBootstrap, role]);

  // One page view, one operation: the page is composed from the bootstrap and the address, then asked once.
  const compositionKey = `${language}\u0000${role}\u0000${path}\u0000${bootstrap?.structureRevision ?? ''}`;
  useEffect(() => {
    if (bootstrap === null) return;
    if (address.unknown) {
      setFailure(`no page stands at ${window.location.pathname}`);
      setLoaded(null);
      return;
    }
    const composition = composePage(bootstrap, { ...address.page, lang: language, role });
    if (composition.findings.length > 0) {
      setFailure(composition.findings.map((finding) => `${finding.file}:${String(finding.line)}: ${finding.message}`).join('\n'));
      setLoaded(null);
      return;
    }
    void ask(composition, composition.variables);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositionKey]);

  const reload = useCallback((variables: Record<string, unknown>): void => {
    if (loaded === null) return;
    const merged = { ...loaded.variables, ...variables };
    // A key set to null drops the variable, as the connection's own default asks.
    for (const [key, value] of Object.entries(variables)) if (value === null) delete merged[key];
    void ask(loaded.composition, merged);
  }, [ask, loaded]);

  const runtime: PageRuntime = { base, language, busy, open, reload };
  const languages = [{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }].filter((one) => one.value === language || one.value === 'en' || one.value === 'ru');
  const roles = [{ value: 'all', label: 'all' }, ...(bootstrap?.roles ?? []).map((name) => ({ value: name, label: name }))];
  return (
    <ShellFrame
      title="Madarch wiki"
      actions={
        <Inline gap={2}>
          <Link href={base + '/'} onOpen={open}>Home</Link>
          <Select label="language" value={language} options={languages} onChange={(value) => { setLanguage(value); keep(LANGUAGE_KEY, value); }} />
          <Select label="role" value={role} options={roles} onChange={(value) => { setRole(value); keep(ROLE_KEY, value); }} />
          <Button kind="quiet" disabled={busy} onClick={() => { setBootstrap(null); void loadBootstrap(); }}>Reload</Button>
        </Inline>
      }
    >
      <PageColumn>
        <Stack gap={4}>
          {failure === null ? null : <Notice>{failure}</Notice>}
          {bootstrap === null && failure === null ? <Notice>Reading the product…</Notice> : null}
          {loaded === null ? null : <PageView composition={loaded.composition} data={loaded.data} runtime={runtime} />}
        </Stack>
      </PageColumn>
    </ShellFrame>
  );
}

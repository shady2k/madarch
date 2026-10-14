/**
 * The app itself: a home page naming the product and listing its documents as
 * quiet kind groups, and a page per document. The page list is asked for once
 * at load, and again only when the wiki's Server-Sent Events stream carries
 * a change event — the server watches the product's working tree — so a file
 * saved in the product shows within two seconds with no reload and no server
 * restart (requirements `pages`, `live`, `app`). A tab the reader leaves alone
 * adds no requests beyond its one open stream: there is no polling. The
 * stream reconnects with backoff when it drops, and the backoff resets when a
 * stream answers again. It keeps one list request in flight at a time, aborts
 * it on cleanup, and never lets an older answer overwrite a newer one —
 * including while the tab is hidden, where the stream keeps delivering. A
 * failed page read is retried on its own, bounded, with the failure shown
 * while the retries run.
 */
import { useContext, useEffect, useRef, useState, useCallback, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTextIcon, FolderGit2Icon, GitBranch, NetworkIcon } from 'lucide-react';
import { relativeTime } from './i18n.js';
import { getProduct, getPages, getPage, getQuestions, getRepos, getRegistry, type Product, type ProductWithAudience, type PageList, type Page, type QuestionList, type QuestionEntry, type PageDocument, type Architecture, type RepoEntry, type ReposList, type RegistryOffer } from './api.js';
import { routeOf, addressOfPage, architectureAddress, type Route } from './routes.js';
import { Markdown, PageLink } from './view.js';
import { routeContext, statusContext } from './hold.js';
import { groupNav, groupOf, kindOf, wordLabel, Shell } from './shell.js';
import { wordCount } from './text.js';
import { useArchitecture, ArchitectureIndex, ViewPage, ElementPage, elementLinksFor } from './architecture.js';
import { StagePage, useStages } from './stages.js';
import { QuestionsView } from './questions.js';
import { HomeOverviewFacts, registryDisplayLabel, registryStageDisplayLabel, type HomeOverviewProjection } from './overview.js';
export type RouteSnapshot = Route;

/** How many times one page read is tried before the app gives up on it. */
export const pageTriesLimit = 3;

/** How long one read of the wiki may run before it is aborted and its failure shown. */
export const defaultPollTimeoutMs = 5000;

/** The first gap before a dropped stream is asked for again; each miss doubles it. */
export const defaultReconnectMs = 1000;

/** The longest gap a dropped stream waits before it is asked for again. */
const maxReconnectMs = 15_000;

/** Where the wiki's change stream answers. */
export const EVENTS_PATH = '/api/events';

export type AppProps = {
  pageRetryMs?: number;
  pollTimeoutMs?: number;
  /** The reconnect base for the tests; a dropped stream doubles it each miss. */
  reconnectMs?: number;
};

export function App({ pageRetryMs = 1000, pollTimeoutMs = defaultPollTimeoutMs, reconnectMs = defaultReconnectMs }: AppProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [route, setRoute] = useState<RouteSnapshot>(() => routeOf(window.location.pathname));
  // The repositories' answer is optional (docs/changes/wiki-repos): a
  // product whose manifest declares no repositories has no `/api/repos` at
  // all — the server refuses it — and the wiki loads all the same, the
  // section simply absent.
  const [data, setData] = useState<{ product: ProductWithAudience; list: PageList; repos: ReposList | null; questions?: QuestionList; registry: RegistryOffer | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [streamConnected, setStreamConnected] = useState(false);
  const productName = data?.product.name;
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
    document.title = t('brand.title', { product: productName ?? 'madarch' });
  }, [i18n.resolvedLanguage, productName, t]);

  // The route follows the history bar: back and forward as much as the app's own moves.
  useEffect(() => {
    const onPop = (): void => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The wiki's page list, asked for at load and again only on the stream's
  // change events (there is no polling): one request in flight at a time,
  // aborted on cleanup, and an answer from an older request never wins
  // against a newer one. The reader reads regardless of the tab's
  // visibility, since the stream delivers events while the tab is hidden too.
  useEffect(() => {
    let alive = true;
    let controller: AbortController | undefined;
    let asking = false;
    let requestTurn = 0;
    let lastAnsweredTurn = 0;
    const loadList = async (): Promise<void> => {
      if (asking) return;
      asking = true;
      controller = new AbortController();
      const turn = ++requestTurn;
      // A request that never answers must not hold the flag forever: the
      // read is aborted when its own timeout passes and the failure shown;
      // the stream's next change event asks again (finding 4).
      let timeoutFired = false;
      const timeout = pollTimeoutMs > 0
        ? window.setTimeout(() => {
            timeoutFired = true;
            controller?.abort();
          }, pollTimeoutMs)
        : undefined;
      // The request that was actually in flight when the timeout fired, so
      // the sentence names it and not always the page list (finding 2.11).
      let current: string = '/api/pages';
      try {
        const nextList = await getPages(controller.signal);
        current = '/api/product';
        const nextProduct = await getProduct(controller.signal);
        current = '/api/questions';
        let nextQuestions: QuestionList | undefined;
        try {
          nextQuestions = await getQuestions(controller.signal);
        } catch {
          if (!alive || lastAnsweredTurn > turn) return;
        }
        // The kinds registry's ask is the other optional read: a server
        // without the route (or a product without a registry file) reads
        // the plain way. A registry file standing but refused comes whole
        // as its refusal: the app reads the plain way the same offer says.
        current = '/api/registry';
        let nextRegistry: RegistryOffer | null = null;
        try {
          nextRegistry = await getRegistry(controller.signal);
        } catch {
          if (!alive || lastAnsweredTurn > turn) return;
          nextRegistry = null;
        }
        // The repositories' ask is the one optional read: its refusal (the
        // server's 404 for an undeclared product, or any other failure) is
        // the section's absence, never the wiki's failure.
        current = '/api/repos';
        const nextRepos = await getRepos(controller.signal).catch(() => null);
        if (!alive || lastAnsweredTurn > turn) return;
        lastAnsweredTurn = turn;
        setData({ product: nextProduct, list: nextList, repos: nextRepos, questions: nextQuestions, registry: nextRegistry });
        setError(null);
      } catch (caught: unknown) {
        const aborted = caught instanceof DOMException && caught.name === 'AbortError';
        const expired = aborted && timeoutFired;
        if (alive && lastAnsweredTurn <= turn && (!aborted || expired)) {
          // A read the app itself killed at its own timeout is named as
          // such: what was being read — the request that timed out — and
          // that it timed out — never the abort's raw message (finding 2.10).
          if (expired) setError(`Could not read the page list: the request to ${current} timed out after ${pollTimeoutMs} ms`);
          else setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        asking = false;
      }
    };
    loadList();
    return () => {
      alive = false;
      controller?.abort();
      controller = undefined;
      asking = false;
    };
  }, [pollTimeoutMs, refresh]);

  // The stream itself: one long-lived request, held for the tab's whole
  // life, reading Server-Sent Events frames. A change event asks for the
  // list again; a dropped stream reconnects with backoff, resetting the
  // backoff when a stream answers again.
  useEffect(() => {
    let alive = true;
    let misses = 0;
    let timer: number | undefined;
    const decoder = new TextDecoder();
    let stream: AbortController | undefined;
    const open = async (): Promise<void> => {
      if (!alive) return;
      stream = new AbortController();
      try {
        const response = await fetch(EVENTS_PATH, { signal: stream.signal });
        if (!response.ok || response.body === null) {
          throw new Error(String('the stream to ' + EVENTS_PATH + ' answered ' + response.status));
        }
        setStreamConnected(true);
        // A stream that answers after a miss is asked with one resync: the
        // events the dead stream swallowed are read as a change now.
        if (misses > 0) {
          misses = 0;
          setRefresh((held) => held + 1);
        }
        const reader = response.body.getReader();
        let frame = '';
        while (alive) {
          const next = await reader.read();
          if (next.done) break;
          frame += decoder.decode(next.value, { stream: true });
          let end: number;
          while ((end = frame.indexOf('\n\n')) !== -1) {
            const lines = frame.slice(0, end).split('\n');
            frame = frame.slice(end + 2);
            const kind = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
            if (kind === 'change') setRefresh((held) => held + 1);
          }
        }
        throw new Error('the stream to ' + EVENTS_PATH + ' ended');
      } catch (caught: unknown) {
        const stop = !alive || (caught instanceof DOMException && caught.name === 'AbortError');
        if (!stop && alive) {
          setStreamConnected(false);
          misses += 1;
          const wait = Math.min(maxReconnectMs, reconnectMs * 2 ** (misses - 1));
          timer = window.setTimeout(open, wait);
        }
      }
    };
    open();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.abort();
      stream = undefined;
    };
  }, [reconnectMs]);

  // The Architecture bundle of the page list's revision: the sidebar's
  // entry and count, the section's pages and the documents' element links
  // all read the one shared ask (useArchitecture memoizes per revision).
  // Called before the early returns, as hooks must be.
  const architecture = useArchitecture(data?.list.revision ?? '').bundle;
  if (error !== null) return <ErrorLine message={error} />;
  if (data === null) return <p className="loading">{t('loading.wiki')}</p>;

  const list = data.list;
  const heldPaths = new Set(list.pages.map((meta) => meta.path));
  // The Architecture pages' breadcrumb fact (feature E): the section's
  // name as the kind and the open view's or element's name as the title,
  // read off the shared bundle.
  let architectureCrumb: { kind: string; title: string } | undefined;
  if (route.name === 'architecture') architectureCrumb = { kind: 'architecture', title: t('architecture.title') };
  else if (route.name === 'view') {
    const view = architecture?.model?.views.find((candidate) => candidate.scope === route.scope);
    architectureCrumb = { kind: 'architecture', title: view ? (view.scope === '' ? t('architecture.landscape') : view.title) : (route.scope === '' ? t('architecture.landscape') : route.scope) };
  } else if (route.name === 'element') {
    const element = architecture?.model?.elements.find((candidate) => candidate.id === route.id);
    architectureCrumb = { kind: 'architecture', title: element?.name ?? (route.id || '') };
  }
  return (
    <StatusBridge streamConnected={streamConnected}>
      <routeContext.Provider value={{ path: route.name === 'page' ? route.path : undefined, stage: route.name === 'stage' ? route.stage : undefined, group: route.name === 'group' ? route.group : undefined, architecture: architectureCrumb, heldPaths }}>
        <Shell product={data.product} list={list} architecture={architecture} reposCount={data.repos?.repos.length} reposOpen={route.name === 'repos'} offer={data.registry}>
        {route.name === 'home' ? (
          <HomePage product={data.product} list={list} architecture={architecture} offer={data.registry} />
        ) : route.name === 'group' ? (
          <GroupPage group={route.group} list={list} offer={data.registry} />
        ) : route.name === 'repos' && (data.repos?.repos.length ?? 0) > 0 ? (
          <RepositoriesPage product={data.product} repos={data.repos!.repos} />
        ) : route.name === 'repos' ? (
          // `/r` of an undeclared product: no repositories section exists —
          // the server refuses the route and the reader sees the home.
          <HomePage product={data.product} list={list} architecture={architecture} offer={data.registry} />
        ) : route.name === 'architecture' ? (
          <ArchitectureReader key={'architecture:' + list.revision} revision={list.revision} routeName="index" />
        ) : route.name === 'view' ? (
          <ArchitectureReader key={'view:' + route.scope + ':' + list.revision} revision={list.revision} routeName="view" scope={route.scope} />
        ) : route.name === 'element' ? (
          <ArchitectureReader key={'element:' + route.id + ':' + list.revision} revision={list.revision} routeName="element" id={route.id} />
        ) : route.name === 'stage' ? (
          <StageRoute key={"stage:" + route.stage + ":" + list.revision} stage={route.stage} revision={list.revision} offer={data.registry} />
        ) : route.name === 'questions' ? (
          <QuestionsView key={"questions:" + list.revision} questions={data.questions ?? null} />

        ) : (
          <PageReader
            key={"page:" + route.path + ":" + list.revision}
            path={route.path}
            heldPaths={heldPaths}
            retryMs={pageRetryMs}
            revision={list.revision}
            offer={data.registry}
          />
        )}
        </Shell>
      </routeContext.Provider>
    </StatusBridge>
  );
}

/**
 * One stage's page: the index asked for the revision the list was last told,
 * so a changed product refetches the stages the way a page is refetched. The
 * read is refetched on every revision change and a refusal shows as the
 * stage's error line.
 */
function StageRoute({ stage, revision, offer }: { stage: string; revision: string; offer?: RegistryOffer | null }): ReactElement {
  const { t } = useTranslation();
  const index = useStages(revision);
  if (index === null) return <p className="loading">{t('loading.wiki')}</p>;
  const section = index.stages.find((each) => each.id === stage);
  if (section === undefined) {
    return (
      <main id="stage">
        <p className="error">
          <strong>{t('errors.prefix')}</strong>{' '}
          <span>{t('stages.unknownStage', { stage })}</span>
        </p>
      </main>
    );
  }
  return <StagePage stage={section} index={index} offer={offer} />;
}

/** The home page's status is localized in its current UI language. */
/** Whether two status lines name exactly the same parts; the same line is one state, not a new one. */
function sameLine(held: readonly string[] | null, parts: readonly string[] | null): boolean {
  if (held === parts) return true;
  if (held === null || parts === null || held.length !== parts.length) return false;
  return held.every((word, at) => word === parts[at]);
}

/**
 * Holds the shell's status line: whatever is open publishes here, and the
 * shell's bottom edge reads it. The setter is stable and lets an
 * unchanged line through, so a publish never re-renders for nothing.
 */
export function StatusBridge({ children, streamConnected }: { children: ReactNode; streamConnected: boolean }): ReactElement {
  const [line, setLine] = useState<readonly string[] | null>(null);
  const publish = useCallback((parts: readonly string[] | null): void => {
    setLine((held) => (sameLine(held, parts) ? held : parts));
  }, []);
  return (
    <statusContext.Provider value={{ publish, parts: line, connection: streamConnected ? 'live' : 'reconnecting' }}>
      {children}
    </statusContext.Provider>
  );
}

/** A generic group page: only live pages with this route's group identity, in code-point path order. */
export function GroupPage({ group, list, offer }: { group: string; list: PageList; offer?: RegistryOffer | null }): ReactElement {
  const { publish } = useContext(statusContext);
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage === 'ru' ? 'ru' : 'en';
  const catalogueLabel = t('stages.kinds.' + group, { defaultValue: '' });
  const label = catalogueLabel || registryDisplayLabel(offer, group, locale) || t('groups.' + group, { defaultValue: wordLabel(group) });
  const pages = groupNav(list.pages, offer ?? null).find((entry) => entry.name === group)?.pages ?? [];
  useEffect(() => {
    publish(pages.length === 0 ? null : [t('status.documents', { count: pages.length, unit: t('units.document', { count: pages.length }) })]);
    return () => publish(null);
  }, [publish, pages.length, t]);
  return (
    <main id="group" data-testid="group-page">
      <p className="eyebrow">{t('navigation.documents')}</p>
      <h1 className="app-title">{label}</h1>
      <ul className="home-rows">
        {pages.map((meta) => (
          <li key={meta.path}>
            <PageLink path={meta.path} className="home-row">
              <FileTextIcon aria-hidden="true" className="home-row-icon" />
              <span className="home-row-title">{meta.title}</span>
            </PageLink>
          </li>
        ))}
      </ul>
    </main>
  );
}

/**
 * The home page, in the mockup's overview language: an eyebrow, the product's
 * name, a short lead, then the documents as quiet groups — a small kind label
 * with its count beside it, and the documents as icon plus title rows on the
 * navigation's row rhythm. No boxed cards, no divider lines between links, no
 * underlines: the kind and its small muted count say what a reader is
 * choosing between, the rows read like the sidebar's. A product with no
 * pages yet says so plainly in the lead.
 */
export function HomePage({ product, list, architecture, offer, overview }: { product: ProductWithAudience; list: PageList; architecture?: Architecture | null; offer?: RegistryOffer | null; overview?: HomeOverviewProjection }): ReactElement {
  const registryOffer = offer ?? null;
  const groups = groupNav(list.pages, registryOffer);
  const documents = list.pages.length;
  const { publish } = useContext(statusContext);
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage === 'ru' ? 'ru' : 'en';
  const documentUnit = t('units.document', { count: documents });
  const groupUnit = t('units.group', { count: groups.length });
  useEffect(() => {
    publish(documents === 0 ? null : [
      t('status.documents', { count: documents, unit: documentUnit }),
      t('status.formatMarkdown'),
      t('status.formatUtf8'),
    ]);
    return () => publish(null);
  }, [publish, documents, documentUnit, t]);
  const lead = documents === 0
    ? t('home.noPages', { product: product.name })
    : t('home.lead', { product: product.name, count: documents, documentUnit, groupCount: groups.length, groupUnit });
  return (
    <main id="home">
      <p className="eyebrow">{t('home.overview')}</p>
      <h1 className="app-title">{product.name}</h1>
      <p className="home-lead" data-testid="home-lead">{lead}</p>
      {product.id === undefined ? null : <HomeOverviewFacts overview={overview} legacyAudience={product.audience} />}
      {documents === 0 ? (
        <section className="home-group mt-7" data-testid="empty-home-guidance" aria-labelledby="empty-home-guidance-title">
          <h2 id="empty-home-guidance-title" className="text-h2 font-medium">{t(product.id === undefined ? 'home.noManifestTitle' : 'home.gettingStartedTitle')}</h2>
          <p className="mt-3 text-secondary">{t(product.id === undefined ? 'home.noManifestDescription' : 'home.productRepository')}</p>
          <ol className="mt-3 list-decimal pl-6">
            <li>{t('home.newProduct')} <code>madarch new</code></li>
            <li>{t('home.setupProduct')} <code>setup-shady2k-skills</code> {t('home.setupProductManifest')} <code>{t('home.workspaceFile')}</code> {t('home.setupProductEnd')}</li>
            <li>
              <p>{t('home.demoProduct')} <a href="https://github.com/shady2k/madarch-product" target="_blank" rel="noreferrer" className="text-link underline">{t('home.demoRepository')}</a></p>
              <ol className="mt-2 list-decimal pl-6">
                <li><code>{t('home.demoClone')}</code></li>
                <li><code>{t('home.demoServe')}</code></li>
              </ol>
            </li>
          </ol>
        </section>
      ) : null}
      <div className="home-groups">
        {documents === 0 ? null : groups.map((group) => (
          <section key={group.name} data-kind={group.name} className="home-group mt-7 first:mt-0">
            <header className="home-group-head">
              <h2 className="text-ink">{t('stages.kinds.' + group.name, { defaultValue: '' })
                || registryDisplayLabel(registryOffer, group.name, locale)
                || t('groups.' + group.name, { defaultValue: wordLabel(group.name) })}</h2>
              <span className="home-count" data-testid="card-count">{group.pages.length}</span>
            </header>
            <ul className="home-rows">
              {group.pages.map((meta) => (
                <li key={meta.path}>
                  <PageLink path={meta.path} className="home-row">
                    <FileTextIcon aria-hidden="true" className="home-row-icon" />
                    <span className="home-row-title">{meta.title}</span>
                  </PageLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {/* The Architecture group is an entry to the product model even when
            the model is absent or does not compile. */}
        <section data-kind="architecture" className="home-group mt-7" data-testid="home-architecture">
          <header className="home-group-head">
            <h2 className="text-ink">{t('architecture.title')}</h2>
            <span className="home-count" data-testid="architecture-count">{architecture?.model?.views.length ?? 0}</span>
          </header>
          <ul className="home-rows">
            <li>
              <a className="home-row" href={architectureAddress()}>
                <NetworkIcon aria-hidden="true" className="home-row-icon" />
                <span className="home-row-title">{t('architecture.openIndex')}</span>
              </a>
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

/**
 * One page, asked for and refetched for each revision of the list the app was
 * last told: a file saved in the product changes the revision, so the open
 * page is read again from the working tree. A read that fails is retried on
 * its own, a bounded number of times, whatever the revision says; the last
 * failure's reason stays on the screen while the retries run.
 */
export function PageReader({
  path,
  heldPaths,
  retryMs = 1000,
  revision,
  offer,
}: {
  path: string;
  heldPaths: ReadonlySet<string>;
  retryMs?: number;
  /** The wiki revision the page was read at; the Architecture bundle of the same revision links documents to elements. */
  revision?: string;
  offer?: RegistryOffer | null;
}): ReactElement {
  const { bundle } = useArchitecture(revision ?? '');
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  // Whether the document rendered its own first-level heading: the fallback
  // title above it then leaves the DOM, so a page holds exactly one h1.
  const [ownTitle, setOwnTitle] = useState(false);
  const pageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setPage(null);
    setError(null);
    setTries(0);
    setOwnTitle(false);
  }, [path]);

  // The decision reads the rendered truth: the Markdown's first child being
  // an h1 is what the renderer itself produced, never a text guess.
  useEffect(() => {
    if (page === null) setOwnTitle(false);
    else setOwnTitle(pageRef.current?.querySelector('.reading > h1:first-child') !== null);
  }, [page]);

  // The shell's bottom status bar is fed by what is open: this page's word
  // count and its format facts. The facts leave when the page leaves, so a
  // home page is never shown a document's count.
  const { publish } = useContext(statusContext);
  const words = page === null ? 0 : wordCount(page.markdown);
  const wordUnit = t('units.word', { count: words });
  useEffect(() => {
    if (page === null) publish(null);
    else publish([
      t('status.words', { count: words, unit: wordUnit }),
      t('status.formatMarkdown'),
      t('status.formatUtf8'),
    ]);
    return () => publish(null);
  }, [page, publish, t, words, wordUnit]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let attempt = 0;
    const loadPage = async (): Promise<void> => {
      attempt++;
      setTries(attempt);
      try {
        const next = await getPage(path);
        if (!alive) return;
        setPage(next);
        setError(null);
      } catch (caught: unknown) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        if (attempt < pageTriesLimit) timer = window.setTimeout(loadPage, retryMs);
      }
    };
    loadPage();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [path, retryMs, revisionKey(heldPaths)]);

  if (error !== null && page === null && tries >= pageTriesLimit)
    return <ErrorLine message={error} />;
  if (error !== null) return <ErrorLine message={error} />;
  if (page === null) return <p className="loading">{t('loading.wiki')}</p>;
  // The document this page is, or a plain page no kind names: the
  // header block reads the form's fields where the registry names the document,
  // and keeps the mockup's plain eyebrow where it does not.
  const doc = page.document;
  const kind = doc?.kind ?? kindOf(path, groupOf(path));
  const locale = i18n.resolvedLanguage === 'ru' ? 'ru' : 'en';
  const catalogueLabel = t('stages.kinds.' + kind, { defaultValue: '' });
  const kindLabel = catalogueLabel || registryDisplayLabel(offer, kind, locale) || wordLabel(kind);
  return (
    <main id="page" ref={pageRef}>
      {/* The document's header: the kind as an eyebrow above the title, then
       * the calm field block for a document the registry names. Exactly one
       * h1 per page: when the document renders its own first-level heading,
       * the fallback title above it is not rendered (the checkpoint's
       * doubled-title defect). */}
      <div className="document-meta eyebrow">
        <strong className="eyebrow-kind">{kindLabel}</strong>
        <span className="eyebrow-dot" aria-hidden="true">•</span>
        <span className="eyebrow-secondary">{page.changedAt ? t('document.changed', { when: relativeTime(page.changedAt, i18n.resolvedLanguage) }) : t('document.local')}</span>
      </div>
      {!ownTitle && <h1 className="app-title">{page.title}</h1>}
      {doc !== undefined && <DocumentHeader document={doc} />}
      <Markdown text={page.markdown} elementLinks={elementLinksFor(bundle, path)} />
      <DocumentLinks page={page} />
      <StructuralBlock page={page} />
      <FindingsBlock page={page} />
    </main>
  );
}

/**
 * The document's fields, shown calm: the identity fields the form
 * names — the id, the status the document's own text computes, the dates
 * and the people a kind carries — then the rest of the form's fields, one
 * quiet row each, values as written. A form the text computes nothing for
 * shows its fields and nothing invented.
 */
function DocumentHeader({ document: doc }: { document: PageDocument }): ReactElement | null {
  const { t } = useTranslation();
  const identity: { label: string; value: string }[] = [];
  if (doc.id !== undefined) identity.push({ label: t('document.fieldId'), value: doc.id });
  if (doc.status !== undefined) identity.push({ label: t('document.fieldStatus'), value: t('status.' + doc.status, { defaultValue: doc.status }) });
  const namedDates = new Set(['Date', 'Since']);
  const people = new Set(['With']);
  const all = doc.fields ?? [];
  const rest = all.filter((field) => !namedDates.has(field.name) && !people.has(field.name));
  const dates = all.filter((field) => namedDates.has(field.name));
  if (dates.length > 0) {
    identity.push({
      label: t('document.fieldDates'),
      value: dates.map((field) => `${field.name} ${field.value}`).join(' · '),
    });
  }
  const peopleFields = all.filter((field) => people.has(field.name));
  if (peopleFields.length > 0) {
    identity.push({
      label: t('document.fieldWho'),
      value: peopleFields.map((field) => field.value).join(' · '),
    });
  }
  if (identity.length === 0 && rest.length === 0) return null;
  return (
    <dl className="doc-fields" data-testid="doc-fields">
      {identity.map((field) => (
        <div key={field.label} className="doc-field doc-field-identity">
          <dt className="doc-field-name">{field.label}</dt>
          <dd className="doc-field-value">{field.value}</dd>
        </div>
      ))}
      {rest.map((field) => (
        <div key={field.name + String(field.line)} className="doc-field">
          <dt className="doc-field-name">{field.name}</dt>
          <dd className="doc-field-value">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The link rows after the document: the fields the kind's registry data
 * declares (each row's head is the naming field's own word, data, never the
 * shell's), then the pages that name this one back — each under the
 * declaring kind's label where one is written, and every undeclared one
 * under the shell's own generic wording. The rows are the form's way of
 * walking the chain up and down; a plain page, and one with neither, shows
 * neither.
 */
function DocumentLinks({ page }: { page: Page }): ReactElement {
  const { t } = useTranslation();
  const document = page.document;
  if (document === undefined) return <></>;
  const grew = document.grewFrom ?? [];
  const backlinks = document.backlinks ?? [];
  if (grew.length === 0 && backlinks.length === 0) return <></>;
  // Each naming field's own word heads its rows; the fields' first-seen
  // order the document read kept.
  const viaNames: string[] = [];
  const byVia = new Map<string, typeof grew>();
  for (const entry of grew) {
    if (!byVia.has(entry.via)) {
      viaNames.push(entry.via);
      byVia.set(entry.via, []);
    }
    byVia.get(entry.via)!.push(entry);
  }
  // The backlinks' labels: a declared one first, the shell's generic word
  // for the rest, every label's first-seen order kept.
  const labels: string[] = [];
  const byLabel = new Map<string, typeof backlinks>();
  for (const entry of backlinks) {
    const label = entry.label ?? t('document.linkedFrom');
    if (!byLabel.has(label)) {
      labels.push(label);
      byLabel.set(label, []);
    }
    byLabel.get(label)!.push(entry);
  }
  return (
    <div className="doc-links" data-testid="doc-links">
      {viaNames.map((via) => (
        <section className="doc-links-row" data-testid={`grown-from-${via.toLowerCase().replaceAll(' ', '-')}`} key={via}>
          <h2 className="doc-links-head">{via}</h2>
          <ul className="doc-links-list">
            {(byVia.get(via) as typeof grew).map((entry) => (
              <li key={entry.id} className="doc-links-item">
                {entry.path !== undefined ? (
                  <PageLink path={entry.path} className="doc-links-link">
                    <span className="doc-links-id">{entry.id}</span>
                    {entry.title !== undefined && entry.title !== entry.id ? <span className="doc-links-title">{entry.title}</span> : null}
                  </PageLink>
                ) : (
                  <span className="doc-links-link doc-links-unresolved">
                    <span className="doc-links-id">{entry.id}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {labels.map((label) => (
        <section className="doc-links-row" data-testid="linked-from" key={label}>
          <h2 className="doc-links-head">{label}</h2>
          <ul className="doc-links-list">
            {(byLabel.get(label) as typeof backlinks).map((entry, at) => (
              <li key={`${entry.path}-${at}`} className="doc-links-item">
                <PageLink path={entry.path} className="doc-links-link">
                  {entry.id !== undefined ? <span className="doc-links-id">{entry.id}</span> : null}
                  <span className="doc-links-title">{entry.title}</span>
                </PageLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The set's product check, on the page that fails it: every finding of
 * this page with its rule, its line and the full path the check named. A
 * page the check says nothing about shows nothing; the check's absence is
 * said once, on the page a reader opens while the check could not run.
 */
export function FindingsBlock({ page }: { page: Page }): ReactElement | null {
  const { t } = useTranslation();
  const findings = page.findings ?? [];
  const note = t('document.checkNote');
  if (findings.length > 0) {
    return (
      <section className="doc-findings" data-testid="doc-findings" aria-live="polite">
        <h2 className="doc-findings-head">{t('document.findings', { count: findings.length })}</h2>
        <p className="doc-findings-note">{t('document.findingsNote', { version: page.check?.ran === true ? page.check.version : '', product: page.path })}</p>
        <ul className="doc-findings-list">
          {findings.map((finding, at) => (
            <li key={at} className="doc-finding" data-rule={finding.rule} data-note={finding.note === true ? 'true' : undefined}>
              <span className="doc-finding-place">{finding.file}:{finding.line}</span>
              <span className="doc-finding-rule">{finding.rule}</span>
              <span className="doc-finding-what">{finding.what}</span>
              {finding.why ? <span className="doc-finding-why">{finding.why}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (page.check !== undefined && page.check.ran === false) {
    return (
      <section className="doc-findings doc-findings-unavailable" data-testid="doc-check-unavailable">
        <p className="doc-finding-what">{note} {page.check.message}</p>
      </section>
    );
  }
  return null;
}

/**
 * The registry's structural findings, on the page that carries one: the
 * broken link, the link to an undeclared kind or field, the missing
 * required link, the status outside the kind's list — the engine's own
 * reads, each at the line it stands on. A page the reads say nothing
 * about shows nothing.
 */
export function StructuralBlock({ page }: { page: Page }): ReactElement | null {
  const { t } = useTranslation();
  const findings = page.structural ?? [];
  if (findings.length === 0) return null;
  return (
    <section className="doc-findings" data-testid="doc-structural" aria-live="polite">
      <h2 className="doc-findings-head">{t('document.structural', { count: findings.length })}</h2>
      <ul className="doc-findings-list">
        {findings.map((finding, at) => (
          <li key={at} className="doc-finding" data-rule={finding.rule}>
            <span className="doc-finding-place">{finding.file}:{finding.line}</span>
            <span className="doc-finding-rule">{finding.rule}</span>
            <span className="doc-finding-what">{finding.what}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The revision of the list the app was last told, so a changed wiki refetches the open page. */
function revisionKey(heldPaths: ReadonlySet<string>): string {
  return [...heldPaths].sort().join('\u0000');
}

/**
 * The Architecture section's reader (feature E): the bundle asked fresh per
 * revision, the section's three page kinds routed off it. A bundle read
 * that fails shows the failure; an uncompilable model is the section's own
 * error page (never the wiki's failure).
 */
export function ArchitectureReader({
  revision,
  routeName,
  scope,
  id,
}: {
  revision: string;
  routeName: 'index' | 'view' | 'element';
  scope?: string;
  id?: string;
}): ReactElement {
  const { t } = useTranslation();
  const { bundle, error } = useArchitecture(revision);
  if (error !== null) return <ErrorLine message={error} />;
  if (bundle === null) return <p className="loading">{t('loading.architecture')}</p>;
  if (routeName === 'view') return <ViewPage bundle={bundle} scope={scope ?? ''} />;
  if (routeName === 'element') return <ElementPage bundle={bundle} id={id ?? ''} />;
  return <ArchitectureIndex bundle={bundle} />;
}

/** A failed read, shown to the reader as a short message naming what was asked for. */
export function ErrorLine({ message }: { message: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <p className="error">
      <strong>{t('errors.prefix')}</strong>{' '}
      <span>{t('errors.details', { message })}</span>
    </p>
  );
}

/**
 * The repositories' page (docs/changes/wiki-repos, requirement
 * `repositories`): the code repositories the product's manifest declares,
 * one card each — its name, its url, its branch when declared, the checkout
 * state, its last commit (the short sha, the subject, the age through the
 * same relative-time machinery the pages use), and its README rendered as
 * markdown through the same pipeline the pages use. The section exists only
 * where the manifest declares repositories: the app never renders an empty
 * stub, and the sidebar entry is the shell's to hold.
 */
export function RepositoriesPage({ product, repos }: { product: Product; repos: readonly RepoEntry[] }): ReactElement {
  const { publish } = useContext(statusContext);
  const { t } = useTranslation();
  const count = repos.length;
  const unit = t('units.repository', { count });
  useEffect(() => {
    publish([t('status.repos', { count, unit }), t('status.formatMarkdown'), t('status.formatUtf8')]);
    return () => publish(null);
  }, [publish, count, unit, t]);
  return (
    <main id="repos">
      <p className="eyebrow">{t('repos.overview')}</p>
      <h1 className="app-title">{t('repos.title')}</h1>
      <p className="home-lead" data-testid="repos-lead">{t('repos.lead', { product: product.name, count, unit })}</p>
      {count === 0 ? null : (
        <div className="home-groups">
          {repos.map((entry) => <RepoCard key={entry.name} entry={entry} />)}
        </div>
      )}
    </main>
  );
}

/** The state labels the card shows, by the entry's state. */
function stateLabelOf(entry: RepoEntry, t: (key: string) => string): string {
  if (entry.state === 'checked-out') return t('repos.stateCheckedOut');
  if (entry.state === 'not-checked-out') return t('repos.stateNotCheckedOut');
  return t('repos.stateUnreadable');
}

/** One repository's card: the declared facts on quiet rows, the rendered README beneath. */
export function RepoCard({ entry }: { entry: RepoEntry }): ReactElement {
  const { t, i18n } = useTranslation();
  const state = stateLabelOf(entry, t);
  return (
    <section key={entry.name} data-repo={entry.name} data-state={entry.state} className="home-group mt-7 first:mt-0">
      <header className="home-group-head">
        <h2 className="text-ink" data-testid="repo-name">{entry.name}</h2>
        <span className="home-count" data-testid="repo-state">{state}</span>
      </header>
      <ul className="home-rows repo-rows">
        <li className="home-row as-line" data-testid="repo-url" title={entry.url}>
          <FolderGit2Icon aria-hidden="true" className="home-row-icon" />
          <span className="home-row-title">{entry.url}</span>
        </li>
        {entry.branch !== undefined && (
          <li className="home-row as-line" data-testid="repo-branch">
            <GitBranch aria-hidden="true" className="home-row-icon" />
            <span className="home-row-title">{t('repos.branchValue', { branch: entry.branch })}</span>
          </li>
        )}
        {entry.state === 'checked-out' && entry.head !== undefined && (
          <li className="home-row as-line" data-testid="repo-commit">
            <FileTextIcon aria-hidden="true" className="home-row-icon" />
            <span className="home-row-title">
              {entry.head.sha} {entry.head.subject} · {t('repos.lastCommit', { when: relativeTime(entry.head.committedAt, i18n.resolvedLanguage) })}
            </span>
          </li>
        )}
        {entry.problem !== undefined && (
          <li className="home-row as-line" data-testid="repo-problem">
            <FileTextIcon aria-hidden="true" className="home-row-icon" />
            <span className="home-row-title">{t('errors.details', { message: entry.problem })}</span>
          </li>
        )}
        {entry.readme === undefined && entry.state !== 'unreadable' && (
          <li className="home-row as-line" data-testid="repo-no-readme">
            <FileTextIcon aria-hidden="true" className="home-row-icon" />
            <span className="home-row-title">{t('repos.noReadme')}</span>
          </li>
        )}
      </ul>
      {entry.readme !== undefined && (
        <div className="repo-readme">
          <Markdown text={entry.readme.markdown} />
        </div>
      )}
    </section>
  );
}

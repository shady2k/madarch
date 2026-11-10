import { currentAddress } from './tabs.js';
import { ENTITY_ADDRESS_PREFIX } from './routes.js';

export function currentHistory(): { repo: string; at: string } | undefined {
  const address = currentAddress();
  const query = new URL(address, 'https://wiki.invalid').searchParams;
  const at = query.get('at');
  return at === null ? undefined : { repo: query.get('repo') ?? '', at };
}

/** Only code pages and source links inherit the selected date. Product prose is not historical evidence. */
export function historyAddress(href: string, history = currentHistory()): string {
  if (history === undefined || !/^\/(?:e\/|src(?:\?|$))/.test(href)) return href;
  if (href.startsWith(ENTITY_ADDRESS_PREFIX) && !decodeURIComponent(href.slice(ENTITY_ADDRESS_PREFIX.length).split('?')[0]!).startsWith('code.')) return href;
  const url = new URL(href, 'https://wiki.invalid');
  url.searchParams.set('repo', history.repo);
  url.searchParams.set('at', history.at);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function historyQuery(): string {
  const history = currentHistory();
  return history === undefined ? '' : `&${new URLSearchParams(history).toString()}`;
}

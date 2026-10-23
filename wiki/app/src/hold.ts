/** Moves the app to an address without a full page load: the new address pushed into the history, so the server can answer it again on a reload. */
export function navigateTo(address: string): void {
  window.history.pushState({}, '', address);
  window.dispatchEvent(new Event('popstate'));
}

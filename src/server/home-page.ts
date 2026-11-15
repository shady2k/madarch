/**
 * The page a products-home server answers for an address it does not serve (madarch-64o5.98): a reader who clicks a
 * link into the wrong place — an entity address without its product's prefix, a mistyped folder — gets a page in their
 * language that names the products with links, never the server's JSON in the browser.
 */

/** One product the home serves. */
export interface HomeProduct {
  readonly name: string;
  readonly folder: string;
  readonly own?: boolean;
}

const WORDS = {
  en: {
    title: 'Nothing is served at this address',
    lead: 'This server serves each product\'s wiki under /products/<folder>/.',
    products: 'Products',
    none: 'No product is served yet. Run madarch init [folder] to start one.',
    address: 'The address asked for',
  },
  ru: {
    title: 'По этому адресу ничего не обслуживается',
    lead: 'Этот сервер отдаёт вики каждого продукта по адресу /products/<папка>/.',
    products: 'Продукты',
    none: 'Пока не обслуживается ни один продукт. Запустите «madarch init [папка]», чтобы создать первый.',
    address: 'Запрошенный адрес',
  },
} as const;

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The reader's language, from the browser's own preference; the wiki's stored choice is not known on this page. */
export function homeLanguage(acceptLanguage: string | undefined): 'en' | 'ru' {
  return (acceptLanguage ?? '').trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** The one page the home answers for an unknown address: the products, each a link, and where the reader stands. */
export function productsHomePage(options: { path: string; products: readonly HomeProduct[]; acceptLanguage?: string }): string {
  const lang = homeLanguage(options.acceptLanguage);
  const words = WORDS[lang];
  const products = [...options.products].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const items = products.map((product) => {
    const href = `/products/${encodeURIComponent(product.folder)}/`;
    const label = product.name === product.folder ? product.name : `${product.name} (${product.folder})`;
    return `      <li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Madarch</title>
<style>
  :root { color-scheme: light dark; --page: #ffffff; --ink: #2e3034; --muted: #6e7178; --link: #2e3034; --line: #e4e5e8; }
  @media (prefers-color-scheme: dark) { :root { --page: #292929; --ink: #e5e5e5; --muted: #a0a0a0; --link: #e5e5e5; --line: #444444; } }
  html, body { margin: 0; background: var(--page); color: var(--ink); }
  body { padding: 40px 24px; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.25; }
  p { margin: 0 0 12px; }
  p.place { color: var(--muted); font-size: 14px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; }
  ul { margin: 8px 0 0; padding: 0; list-style: none; }
  li { border-top: 1px solid var(--line); padding: 8px 0; }
  a { color: var(--link); text-underline-offset: 2px; }
</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(words.title)}</h1>
    <p>${escapeHtml(words.lead)}</p>
    <p class="place">${escapeHtml(words.address)}: <code>${escapeHtml(options.path)}</code></p>
    <h2>${escapeHtml(words.products)}</h2>
${products.length === 0 ? `    <p>${escapeHtml(words.none)}</p>` : `    <ul>\n${items}\n    </ul>`}
  </main>
</body>
</html>
`;
}

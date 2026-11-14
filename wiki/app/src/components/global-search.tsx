
/**
 * The top bar's search (decision 0029's frame, kept on every page): a field on a wide screen and a search sheet on a
 * phone. A press opens the home page's search section with the query bound to its address, so the search is one page read
 * of its own and the field never takes the place of a page's own data.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchIcon } from 'lucide-react';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Sheet, SheetContent } from './ui/sheet.js';
import { Stack } from './ui/typography.js';

function searchAddress(text: string): string {
  return `/?q=${encodeURIComponent(text.trim())}`;
}

export function GlobalSearch({ open }: { readonly open: (path: string) => void }): ReactElement {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState(false);
  const submit = (value = text): void => {
    if (value.trim() === '') return;
    setSheet(false);
    open(searchAddress(value));
  };
  return (
    <>
      <Stack className="relative hidden items-center md:flex">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 text-muted" size={15} />
        <Input
          type="search"
          value={text}
          aria-label={t('knowledge.searchLabel')}
          placeholder={t('knowledge.searchLabel')}
          className="h-9 w-44 pl-8 text-small lg:w-56"
          data-testid="top-search"
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(event.currentTarget.value); }}
        />
      </Stack>
      <Button variant="ghost" size="icon" className="md:!hidden" aria-label={t('knowledge.searchLabel')} title={t('knowledge.searchLabel')} data-testid="top-search-phone" onClick={() => setSheet(true)}>
        <SearchIcon aria-hidden="true" size={19} />
      </Button>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="right" title={t('knowledge.searchLabel')} closeLabel={t('navigation.close')} data-testid="top-search-sheet">
          <Stack className="grid gap-2">
            <Input
              autoFocus
              type="search"
              value={text}
              aria-label={t('knowledge.searchLabel')}
              placeholder={t('knowledge.searchPlaceholder')}
              data-testid="top-search-sheet-input"
              onInput={(event) => setText(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submit(event.currentTarget.value); }}
            />
            <Button variant="default" size="default" onClick={() => submit()}>{t('knowledge.searchButton')}</Button>
          </Stack>
        </SheetContent>
      </Sheet>
    </>
  );
}

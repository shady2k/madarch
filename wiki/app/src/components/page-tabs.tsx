/**
 * The bar of the window's open pages (the first version had them): one tab per page the reader opened, the one in front
 * drawn as the current page, each with the name the page gave itself and a press that closes it. A middle press on a tab
 * closes it, as the first version's bar did.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from 'lucide-react';
import { ShellTab, ShellTabClose, ShellTabTrigger, ShellTabs } from './ui/shell.js';
import type { WikiTab } from '../tabs.js';

export function PageTabs({ tabs, active, activate, close }: {
  readonly tabs: readonly WikiTab[];
  readonly active: string;
  readonly activate: (key: string) => void;
  readonly close: (key: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <ShellTabs aria-label={t('knowledge.tabs')} data-testid="tab-bar">
      {tabs.map((tab) => {
        const here = tab.key === active;
        const title = tab.title ?? t('knowledge.loading');
        return (
          <ShellTab key={tab.key} active={here} data-testid="tab" data-active={here ? 'true' : 'false'}>
            <ShellTabTrigger
              aria-selected={here}
              title={title}
              data-testid="tab-trigger"
              onClick={() => activate(tab.key)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); close(tab.key); } }}
            >
              {title}
            </ShellTabTrigger>
            {tabs.length > 1
              ? (
                <ShellTabClose
                  aria-label={t('knowledge.closeTab', { title })}
                  title={t('knowledge.closeTabShort')}
                  data-testid="tab-close"
                  onClick={() => close(tab.key)}
                >
                  <XIcon aria-hidden="true" size={14} />
                </ShellTabClose>
              )
              : null}
          </ShellTab>
        );
      })}
    </ShellTabs>
  );
}

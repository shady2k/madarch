import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs.js';

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  GlobalRegistrator.unregister();
});

test('controlled Tabs switch the selected trigger and mounted panel', async () => {
  function ControlledTabs() {
    const [value, setValue] = useState('table');
    return createElement(Tabs, { value, onValueChange: setValue },
      createElement(TabsList, { 'aria-label': 'Views' },
        createElement(TabsTrigger, { value: 'table' }, 'Table'),
        createElement(TabsTrigger, { value: 'graph' }, 'Graph')),
      createElement(TabsContent, { value: 'table' }, 'Table content'),
      createElement(TabsContent, { value: 'graph' }, 'Graph content'));
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(ControlledTabs)); });
    const selectedPanel = () => container.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')!;
    expect(selectedPanel().textContent).toBe('Table content');
    const triggers = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    await act(async () => {
      triggers[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(triggers[1]!.getAttribute('aria-selected')).toBe('true');
    expect(selectedPanel().hidden).toBe(false);
    expect(selectedPanel().textContent).toBe('Graph content');
    await act(async () => {
      triggers[0]!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(triggers[0]!.getAttribute('aria-selected')).toBe('true');
    expect(selectedPanel().hidden).toBe(false);
    expect(selectedPanel().textContent).toBe('Table content');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

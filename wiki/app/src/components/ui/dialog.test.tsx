import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DialogPreview } from './dialog.js';

test('dialog preview uses a fixed header and footer around the sole scrolling body', () => {
  const html = renderToStaticMarkup(<DialogPreview title="Notice" description="Details"><p>Long content</p></DialogPreview>);
  expect(html).toContain('data-slot="dialog-body"');
  expect(html).toContain('data-slot="dialog-header"');
  expect(html).toContain('data-slot="dialog-footer"');
  expect(html).toContain('overflow-hidden');
  expect(html).toContain('overflow-y-auto');
});

test('live dialog keeps its close Button in the header and actions in the footer', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogClose } = await import('./dialog.js');
  const { Button } = await import('./button.js');
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Dialog><DialogTrigger asChild><Button>Open</Button></DialogTrigger><DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>Notice</DialogTitle></DialogHeader><DialogBody><p>Long content</p></DialogBody><DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter></DialogContent></Dialog>); });
    await act(async () => { container.querySelector('button')!.click(); });
    const surface = document.querySelector('[role="dialog"]')!;
    expect(surface.className).toContain('overflow-hidden');
    expect(surface.className).not.toContain('overflow-y-auto');
    const close = surface.querySelector<HTMLButtonElement>('[data-slot="dialog-header"] button')!;
    expect(close.className).toContain('ui-button');
    expect(surface.querySelector('[data-slot="dialog-body"]')?.className).toContain('overflow-y-auto');
    expect(surface.querySelector('[data-slot="dialog-footer"] button')?.textContent).toBe('Done');
    await act(async () => { close.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    if (previous === undefined) delete env.IS_REACT_ACT_ENVIRONMENT;
    else env.IS_REACT_ACT_ENVIRONMENT = previous;
    GlobalRegistrator.unregister();
  }
});

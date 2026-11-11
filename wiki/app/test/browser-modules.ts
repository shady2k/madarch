import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Keep ReactDOM's existing non-browser initialization used by page fixtures.
await import('react-dom/client');
// Radix selects its layout effect at import time. Initialize it with a DOM,
// then let each page fixture register its own isolated window as usual.
GlobalRegistrator.register({ url: 'http://localhost/' });
await import('@radix-ui/react-tabs');
await import('@radix-ui/react-popover');
await GlobalRegistrator.unregister();

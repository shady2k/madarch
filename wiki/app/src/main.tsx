/**
 * The app's entry: one root element, rendered into index.html's root, before
 * history changes get a chance to arrive.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html holds no root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

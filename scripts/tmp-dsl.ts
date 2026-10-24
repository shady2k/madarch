
import { diagramWorkspace } from '../src/product-wiki/graph-workspace.js';
const model = {
  type: 'domain-map',
  title: 'Domains',
  elements: [
    { id: 'product', label: 'shop', kind: 'product' },
    { id: 'domain:payment', label: 'payment', kind: 'domain', detail: 'neighbouring domain' },
    { id: 'code.service:payments', label: 'payments', kind: 'service', detail: 'TypeScript' },
  ],
  edges: [
    { from: 'product', to: 'domain:payment', label: 'contains', dashed: false },
    { from: 'domain:payment', to: 'code.service:payments', label: 'implemented by', dashed: true },
  ],
};
const held = diagramWorkspace(model, { pageAddress: () => '' });
console.log(held.workspace.split('\n').map((line, at) => `${at + 1}: ${line}`).join('\n'));

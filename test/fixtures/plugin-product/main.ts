import { definePlugin } from 'madarch-plugin-sdk';
import contract from './contract.json';

await definePlugin({
  name: 'fixture-product', version: '1.0.0',
  contract: contract.outputs as never,
  async extract() {
    return {
      vertices: [{ kind: 'product', key: { name: 'Repository fixture' }, values: {
        purpose: 'Exercise repository fills without a model.', status: 'in development',
        vision: 'Keep repository facts reproducible.',
      } }],
      end: { state: 'complete' },
    };
  },
});

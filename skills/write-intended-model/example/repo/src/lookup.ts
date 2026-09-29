// Prints one receipt from the archive: bun run lookup -- <id>.
import { findReceipt } from './store';

const receipt = findReceipt(process.argv[2]!);
console.log(receipt === undefined ? 'not found' : JSON.stringify(receipt, null, 2));

/**
 * The wiki's shell (decision 0036, section 7): the template frontend lands in the next change. What stands now is the
 * app frame the server serves; every page will be a template of the product, run in the browser over the one GraphQL API.
 */
import type { ReactElement } from 'react';
import { ShellFrame, ShellNote } from './components/ui/shell.js';

export function Shell(): ReactElement {
  return (
    <ShellFrame title="Madarch wiki">
      <ShellNote />
    </ShellFrame>
  );
}

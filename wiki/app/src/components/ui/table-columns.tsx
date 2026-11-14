import type { ColgroupHTMLAttributes } from 'react';

/** Column definitions are grouped separately from table rows. */
export function TableColumns(props: ColgroupHTMLAttributes<HTMLTableColElement>) {
  return <colgroup {...props} />;
}

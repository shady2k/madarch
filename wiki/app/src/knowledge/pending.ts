import { createContext } from 'react';

/** The ids of the pages an agent has yet to write: a link to one of them is not broken, its unit has not come to it. */
export const PendingPages = createContext<ReadonlySet<string>>(new Set());

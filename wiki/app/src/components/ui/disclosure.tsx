import type { HTMLAttributes, DetailsHTMLAttributes } from 'react';
export function Disclosure(props: DetailsHTMLAttributes<HTMLDetailsElement>) { return <details {...props} />; }
export function DisclosureSummary(props: HTMLAttributes<HTMLElement>) { return <summary {...props} />; }

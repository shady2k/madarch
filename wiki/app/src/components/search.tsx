/**
 * The product's search (decision 0036, section 7): one question to the `search` root, its answers as links. A press is
 * the reader's own read, so it is a request of its own; a page view is still one request.
 */
import { useState, type ReactElement } from 'react';
import { postQuery } from '../client.js';
import { Button, Field, TextInput } from './ui/controls.js';
import { Inline, Stack } from './ui/layout.js';
import { Link, Muted } from './ui/typography.js';
import { entityHref } from './connection.js';
import type { SectionContext } from './types.js';

interface SearchAnswer {
  readonly search: { readonly edges: readonly { readonly node: Record<string, unknown> }[]; readonly totalCount: number };
}

export function SearchSection({ context }: { readonly context: SectionContext }): ReactElement {
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer['search'] | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const kinds = Array.isArray(context.section.params['kinds']) ? (context.section.params['kinds'] as string[]) : undefined;
  const ask = async (): Promise<void> => {
    setFailed(undefined);
    const query = kinds === undefined
      ? 'query Search($text: String!) { search(text: $text, first: 20) { edges { node { id kind label template } } totalCount } }'
      : 'query Search($text: String!, $kinds: [String!]) { search(text: $text, kinds: $kinds, first: 20) { edges { node { id kind label template } } totalCount } }';
    const result = await postQuery<SearchAnswer>(context.base, query, { text, ...(kinds === undefined ? {} : { kinds }) });
    if (result.errors.length > 0) {
      setFailed(result.errors.map((error) => error.message).join('; '));
      return;
    }
    setAnswer(result.data?.search);
  };
  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <Field label="search">
          <TextInput value={text} label="search" onInput={setText} onSubmit={() => { void ask(); }} />
        </Field>
        <Button onClick={() => { void ask(); }}>Search</Button>
      </Inline>
      {failed === undefined ? null : <Muted>{failed}</Muted>}
      {answer === undefined ? null : (
        <Stack gap={1}>
          <Muted>{`${String(answer.totalCount)} found`}</Muted>
          {answer.edges.map((edge, at2) => {
            const href = entityHref(edge.node);
            return href === undefined ? null : (
              <Link key={String(at2)} href={context.base + href} onOpen={context.open}>{String(edge.node['label'] ?? href)}</Link>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * A failure of the fill or the writer, told once in the reader's language, with the engineer's detail (the English
 * message with its paths) behind a link and the Problems page one click away (madarch-m38l.11). The server sends a
 * `code` for the kind of failure and keeps `message` as the detail; a code the app has no words for shows the message.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { KLink } from './blocks.js';
import { K_PROBLEMS } from './routes.js';

export function FailureNote({ scope, code, message }: { scope: 'fill' | 'writer'; code: string | undefined; message: string | undefined }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  if (message === undefined && code === undefined) return null;
  const key = `errors.${scope}.${code ?? ''}`;
  const known = code !== undefined && i18n.exists(key);
  if (!known) return message === undefined ? null : <p className="m-0" data-testid="failure-message">{message}</p>;
  return (
    <div data-testid="failure-note" data-code={code}>
      <p className="m-0">{t(key)}</p>
      <p className="mb-0 mt-1 text-small">
        <KLink href={K_PROBLEMS}>{t('errors.problems')}</KLink>
        {message !== undefined && message !== '' && (
          <>
            {' · '}
            <button type="button" className="cursor-pointer bg-transparent p-0 text-left text-secondary underline" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="failure-details">
              {open ? t('knowledge.findingsHide') : t('knowledge.findingsDetails')}
            </button>
          </>
        )}
      </p>
      {open && message !== undefined && <pre className="!mb-0 !mt-2 whitespace-pre-wrap break-words text-[0.8125rem]" data-testid="failure-detail">{message}</pre>}
    </div>
  );
}

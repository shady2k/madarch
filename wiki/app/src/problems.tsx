import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { postQuery } from './client.js';
import { useConnection } from './connection.js';
import { Alert, AlertDescription } from './components/ui/alert.js';
import { BulletList, ListItem, Metadata, PageHeader, PageSection, PageTitle, Paragraph, SectionTitle } from './components/ui/typography.js';

interface TemplateFinding {
  readonly file: string;
  readonly line: number;
  readonly path: string;
  readonly message: string;
}

/** The template checks only: other product checks are not part of this read. */
export function ProblemsPage({ base }: { readonly base: string }): ReactElement {
  const { t } = useTranslation();
  const connection = useConnection();
  const [findings, setFindings] = useState<readonly TemplateFinding[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setFindings(null);
    setFailure(null);
    void (async () => {
      try {
        const answer = await postQuery<{ templateFindings?: readonly TemplateFinding[] | null }>(
          base, 'query TemplateFindings { templateFindings { file line path message } }', {},
        );
        if (!current) return;
        if (answer.offline === true) {
          // The frame's calm state says the server cannot be reached; the page asks again when it returns.
          setFindings(null);
          setFailure(null);
        } else if (answer.errors.length > 0) {
          setFailure(answer.errors.map(({ message }) => message).join('; '));
        } else if (answer.data?.templateFindings == null) {
          setFailure('the graph answered no template findings');
        } else {
          setFindings(answer.data.templateFindings);
        }
      } catch (error) {
        if (current) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { current = false; };
  }, [base, connection.generation]);
  return (
    <>
      <PageHeader><PageTitle>{t('loop.problemsTitle')}</PageTitle></PageHeader>
      <PageSection>
        <SectionTitle>{t('problems.templateFindings')}</SectionTitle>
        {failure !== null ? <Alert variant="problem" role="alert"><AlertDescription>{failure}</AlertDescription></Alert> : findings === null ? (
          <Paragraph role="status">{t('problems.loadingTemplates')}</Paragraph>
        ) : findings.length === 0 ? (
          <Paragraph>{t('problems.noTemplateFindings')}</Paragraph>
        ) : (
          <BulletList>{findings.map((finding, index) => (
            <ListItem key={index}>
              <Paragraph>{finding.message}</Paragraph>
              <Metadata>{finding.file}:{finding.line} — {finding.path}</Metadata>
            </ListItem>
          ))}</BulletList>
        )}
      </PageSection>
    </>
  );
}

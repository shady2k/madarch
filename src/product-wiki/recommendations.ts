/** Deterministic next-step selection from product registry and current wiki state. */
export interface RecommendationKind {
  name: string;
  folder: string;
  hint: string;
  links?: readonly { field: string; required?: boolean }[];
}
export interface RecommendationQuestion {
  id: string;
  path: string;
  title: string;
  prompt: string;
  dependsOn: readonly string[];
  rank: number;
  state: string;
}
export interface RecommendationPage {
  path: string;
  title: string;
  kind?: string;
  id?: string;
  markdown?: string;
  structural?: readonly { rule: string; what: string }[];
}
export interface NextStepRecommendation {
  action: string;
  reason: string;
  target: string;
  rule: 'answer-question' | 'review-assumption' | 'fill-required' | 'registry-hint' | 'inspect-update';
}

/** Select the highest-priority step; ties use rank then code-point id/path order. */
export function recommendNextStep(input: {
  kinds: readonly RecommendationKind[];
  pages: readonly RecommendationPage[];
  questions: readonly RecommendationQuestion[];
  pagePath?: string;
}): NextStepRecommendation {
  const current = input.pagePath === undefined ? undefined : input.pages.find((page) => page.path === input.pagePath);
  const relevantQuestions = input.questions
    .filter((question) => question.state === 'open' && (current === undefined || question.path === current.path || question.dependsOn.includes(current.path) || (current.id !== undefined && question.dependsOn.includes(current.id))))
    .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const question = relevantQuestions[0];
  if (question !== undefined) return {
    action: `Answer: ${question.title}`,
    reason: question.prompt || question.title,
    target: question.path,
    rule: 'answer-question',
  };

  const assumptions = input.pages.filter((page) => (current === undefined || page.path === current.path) && /\*\*Unverified\*\*/i.test(page.markdown ?? ''))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const assumption = assumptions[0];
  if (assumption !== undefined) return {
    action: 'Review unverified assumption',
    reason: 'This page contains a claim marked Unverified.',
    target: assumption.path,
    rule: 'review-assumption',
  };

  // The engine has no kind vocabulary: folders and required links come only from the registry.
  const orderedKinds = [...input.kinds].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const missingKind = orderedKinds.find((kind) => !input.pages.some((page) => kind.folder.endsWith('.md') ? page.path === kind.folder : page.path.startsWith(`${kind.folder.replace(/\/$/, '')}/`)));
  if (missingKind !== undefined) return {
    action: `Add ${missingKind.name}`,
    reason: `The registry requires a page of ${missingKind.name}, but none is present.`,
    target: missingKind.folder,
    rule: 'fill-required',
  };
  const structuralCandidates = input.pages
    .filter((page) => current === undefined || page.path === current.path)
    .flatMap((page) => (page.structural ?? []).filter((finding) => finding.rule === 'structural.required-link').map((finding) => ({ page, finding })))
    .sort((a, b) => a.page.path < b.page.path ? -1 : a.page.path > b.page.path ? 1 : 0);
  const missingLink = structuralCandidates[0];
  if (missingLink !== undefined) return {
    action: 'Fill a required link',
    reason: missingLink.finding.what,
    target: missingLink.page.path,
    rule: 'fill-required',
  };

  const hintKind = orderedKinds.find((kind) => !current || current.kind === kind.name) ?? orderedKinds[0];
  if (hintKind !== undefined) return {
    action: hintKind.hint,
    reason: hintKind.hint,
    target: hintKind.folder,
    rule: 'registry-hint',
  };
  return {
    action: 'Review this page and its sources',
    reason: 'Check whether this page still reflects the product.',
    target: current?.path ?? input.pages[0]?.path ?? '/',
    rule: 'inspect-update',
  };
}

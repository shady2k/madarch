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
  /** The open question's title, set when the rule answered a question; the reader's label localizes around it. */
  questionTitle?: string;
  /** The registry kind's name, set when the rule names a kind; the reader's label localizes around it. */
  kindName?: string;
}

/** The page's Markdown without its fenced code blocks: a badge quoted in an example is not the page's own claim. */
function withoutFencedCode(markdown: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence === undefined) {
      if (marker !== null) fence = marker[1]![0]!;
      else lines.push(line);
    } else if (marker !== null && marker[1]![0]! === fence) {
      fence = undefined;
    }
  }
  return lines.join('\n');
}

/** Select the highest-priority step; ties use the registry's declared order and code-point ids/paths. */
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
    questionTitle: question.title,
  };

  const assumptions = input.pages.filter((page) => (current === undefined || page.path === current.path) && /\*\*Unverified\*\*/i.test(withoutFencedCode(page.markdown ?? '')))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const assumption = assumptions[0];
  if (assumption !== undefined) return {
    action: 'Review unverified assumption',
    reason: assumption.path === current?.path
      ? 'This page contains a claim marked Unverified.'
      : `The page ${assumption.title} contains a claim marked Unverified.`,
    target: assumption.path,
    rule: 'review-assumption',
  };

  // The engine has no kind vocabulary: folders and required links come only from the registry,
  // read in the order the product's registry declares them.
  const missingKind = input.kinds.find((kind) => !input.pages.some((page) => kind.folder.endsWith('.md') ? page.path === kind.folder : page.path.startsWith(`${kind.folder.replace(/\/$/, '')}/`)));
  if (missingKind !== undefined) return {
    action: `Add ${missingKind.name}`,
    reason: `The registry requires a page of ${missingKind.name}, but none is present.`,
    target: missingKind.folder,
    rule: 'fill-required',
    kindName: missingKind.name,
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

  const hintKind = input.kinds.find((kind) => current !== undefined && current.kind === kind.name) ?? input.kinds[0];
  if (hintKind !== undefined) return {
    action: hintKind.hint,
    reason: hintKind.hint,
    target: hintKind.folder,
    rule: 'registry-hint',
    kindName: hintKind.name,
  };
  return {
    action: 'Review this page and its sources',
    reason: 'Check whether this page still reflects the product.',
    target: current?.path ?? input.pages[0]?.path ?? '/',
    rule: 'inspect-update',
  };
}

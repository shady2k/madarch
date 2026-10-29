import type { RuleSpec, SonarKind, ProblemSeverity } from './types.js';

/**
 * The rule set, as data (madarch-m38l.19): each rule names the section it
 * belongs to, the Sonar kind its findings carry and the severity they start
 * with. The engine reads this list; a product's manifest may lower a severity
 * or switch a rule off, and the starter set writes the defaults.
 */
export const PROBLEM_RULES: readonly RuleSpec[] = [
  // ---- the code ------------------------------------------------------------------------------
  { id: 'dependency.cycle', kind: 'dependency-cycle', sonar: 'bug', severity: 'major', section: 'code', action: 'task', label: { en: 'Dependency cycle', ru: 'Цикл зависимостей' } },
  { id: 'security.sql-input', kind: 'sql-input', sonar: 'vulnerability', severity: 'blocker', section: 'code', action: 'task', label: { en: 'Untrusted input reaches SQL', ru: 'Внешние данные попадают в SQL' } },
  { id: 'security.export-route', kind: 'route-outside-auth', sonar: 'vulnerability', severity: 'critical', section: 'code', action: 'task', label: { en: 'Route outside the auth group', ru: 'Маршрут вне группы авторизации' } },
  { id: 'large-file', kind: 'large-file', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', label: { en: 'Large file', ru: 'Большой файл' } },
  { id: 'hotspot', kind: 'change-hotspot', sonar: 'code-smell', severity: 'major', section: 'code', action: 'task', label: { en: 'Change hotspot', ru: 'Горячая точка изменений' } },
  { id: 'dead-export', kind: 'dead-export', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', label: { en: 'Exported but unused', ru: 'Экспорт без использования' } },
  { id: 'debt.todo', kind: 'debt-todo', sonar: 'code-smell', severity: 'info', section: 'code', action: 'task', label: { en: 'TODO', ru: 'TODO' } },
  { id: 'debt.fixme', kind: 'debt-fixme', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', label: { en: 'FIXME', ru: 'FIXME' } },
  { id: 'config.required-dev-value', kind: 'config-development-value', sonar: 'vulnerability', severity: 'critical', section: 'code', action: 'task', label: { en: 'Required setting has a checked-in value', ru: 'Обязательная настройка задана в репозитории' } },
  { id: 'dependency.declared-unused', kind: 'dependency-declared-unused', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', label: { en: 'Dependency declared but unused', ru: 'Зависимость объявлена, но не используется' } },
  { id: 'dependency.used-undeclared', kind: 'dependency-used-undeclared', sonar: 'bug', severity: 'major', section: 'code', action: 'task', label: { en: 'Dependency used but undeclared', ru: 'Зависимость используется, но не объявлена' } },
  { id: 'contract.operation-without-route', kind: 'operation-without-route', sonar: 'bug', severity: 'major', section: 'code', action: 'task', label: { en: 'Contract operation is not implemented', ru: 'Операция контракта не реализована' } },
  { id: 'contract.route-without-operation', kind: 'route-without-operation', sonar: 'bug', severity: 'minor', section: 'code', action: 'task', label: { en: 'Route is not in the contract', ru: 'Маршрута нет в контракте' } },

  // ---- the documents -------------------------------------------------------------------------
  { id: 'document.contradiction', kind: 'document-contradiction', sonar: 'bug', severity: 'major', section: 'documents', action: 'task', label: { en: 'Contradiction', ru: 'Противоречие' } },
  { id: 'document.stale', kind: 'document-stale', sonar: 'bug', severity: 'major', section: 'documents', action: 'task', label: { en: 'Stale statement', ru: 'Устаревшее утверждение' } },
  { id: 'document.undocumented', kind: 'document-undocumented', sonar: 'code-smell', severity: 'major', section: 'documents', action: 'task', label: { en: 'Undocumented behaviour', ru: 'Неописанное поведение' } },
  { id: 'document.ambiguous-term', kind: 'document-ambiguous', sonar: 'code-smell', severity: 'minor', section: 'documents', action: 'task', label: { en: 'Ambiguous term', ru: 'Неоднозначный термин' } },

  // ---- the wiki ------------------------------------------------------------------------------
  { id: 'wiki.correction', kind: 'correction', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', label: { en: 'Correction', ru: 'Исправление' } },
  { id: 'wiki.ground-removed', kind: 'ground-removed', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', label: { en: 'Ground removed', ru: 'Основание исчезло' } },
  { id: 'wiki.broken-link', kind: 'broken-link', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', label: { en: 'Broken link', ru: 'Ссылка никуда не ведёт' } },
  { id: 'wiki.unreadable-file', kind: 'unreadable-file', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', label: { en: 'Unreadable file', ru: 'Файл не читается' } },
  { id: 'wiki.unread-passage', kind: 'unread-passage', sonar: 'code-smell', severity: 'minor', section: 'wiki', action: 'task', label: { en: 'Passage not read', ru: 'Фрагмент не прочитан' } },
  { id: 'wiki.unplaced', kind: 'unplaced', sonar: 'code-smell', severity: 'minor', section: 'wiki', action: 'task', label: { en: 'Unplaced finding', ru: 'Находка без места' } },
  { id: 'wiki.manifest', kind: 'manifest', sonar: 'bug', severity: 'major', section: 'wiki', action: 'task', label: { en: 'Manifest finding', ru: 'Замечание к манифесту' } },
];

export const RULE_BY_ID: ReadonlyMap<string, RuleSpec> = new Map(PROBLEM_RULES.map((rule) => [rule.id, rule] as const));

/** The rule of a finding kind, for the legacy wiki findings whose kind is their rule's last part. */
export function ruleForKind(kind: string): RuleSpec {
  const direct = PROBLEM_RULES.find((rule) => rule.id === kind);
  if (direct !== undefined) return direct;
  const byKind = PROBLEM_RULES.find((rule) => rule.kind === kind);
  if (byKind !== undefined) return byKind;
  const wiki = RULE_BY_ID.get(`wiki.${kind}`);
  return wiki ?? RULE_BY_ID.get('wiki.manifest')!;
}

/** The severity a finding has after the product's overrides. */
export function severityOf(rule: RuleSpec, settings: { rules: Readonly<Record<string, { severity?: ProblemSeverity }>> }): ProblemSeverity {
  return settings.rules[rule.id]?.severity ?? rule.severity;
}

/** The Sonar kind a rule's findings carry; the rule data is the only place it is written. */
export const sonarOf = (rule: RuleSpec): SonarKind => rule.sonar;

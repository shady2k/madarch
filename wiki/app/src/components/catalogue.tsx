
/**
 * The entity catalogue (the design change of madarch-64o5.71): the kinds the product declares, read by default, with a
 * visible way into an explicit selection mode. A kind's definition, its entity count and whether the product holds it are
 * separate signs; the fill method comes from the server's plan. Selection is explicit: the prerequisites the server adds
 * are marked «Нужно для X», cannot be dropped while their dependant stays, and the short bottom bar leads to the
 * preparation panel.
 *
 * The page as a reader had it before PR #299 (madarch-64o5.133): its header states how many kinds and records stand in
 * view, each area and subgroup states its own share, every kind wears the state its fill left it in — never filled, filled
 * or failed — and a contents list follows the areas as the page scrolls. The state is the graph's count with the newest
 * run's own verdict on top of it.
 */
import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { Input } from './ui/input.js';
import { ChoiceMenu } from './ui/choice-menu.js';
import { Skeleton } from './ui/skeleton.js';
import { ResponsiveContents } from './ui/table-of-contents.js';
import { FieldLabel, InlineGroup, ListItem, Paragraph, PlainList, SectionTitle, SmallTitle, Stack, Text, TextLink } from './ui/typography.js';
import { readFillPlan, useCommandRead, useChangeStream, type FillPlanError, type FillPlanView, type FillRunDetail } from './command.js';
import { fetchFillRuns } from '../client.js';
import { fieldLabel, filledBy, planKindOf } from './plan-words.js';
import { PluginNames } from './plugin-names.js';
import type { Navigation, NavigationKind } from '../client.js';
import { CATALOGUE_KIND } from '../../../../src/page-contract/index.js';
import { catalogueSelectionAddress, entityAddress, prepareAddress } from '../address.js';
import type { SectionContext } from './types.js';

const lower = (text: string, language: string): string => text.toLocaleLowerCase(language);

interface Area {
  readonly id: string;
  readonly label: string;
  readonly direct: readonly NavigationKind[];
  readonly subgroups: readonly { readonly id: string; readonly label: string; readonly kinds: readonly NavigationKind[] }[];
}

/** The catalogue's top areas, their direct kinds and their sub-areas, in the manifest's group order. */
function areasOf(navigation: Navigation | null, kindOk: (kind: NavigationKind) => boolean, language: string): Area[] {
  const groups = navigation?.groups ?? [];
  const known = new Set(groups.map((group) => group.name));
  const kinds = (navigation?.kinds ?? []).filter(kindOk);
  const top = groups.filter((group) => group.parent === null || !known.has(group.parent));
  const areas: Area[] = [];
  for (const group of top) {
    const subgroups = groups.filter((child) => child.parent === group.name).map((child) => ({
      id: child.name,
      label: child.labels[language] ?? child.labels.en ?? child.name,
      kinds: kinds.filter((kind) => kind.group === child.name),
    })).filter((subgroup) => subgroup.kinds.length > 0);
    const direct = kinds.filter((kind) => kind.group === group.name);
    if (direct.length > 0 || subgroups.length > 0) areas.push({ id: group.name, label: group.labels[language] ?? group.labels.en ?? group.name, direct, subgroups });
  }
  const loose = kinds.filter((kind) => kind.group === null || !known.has(kind.group));
  if (loose.length > 0) areas.push({ id: '', label: '', direct: loose, subgroups: [] });
  return areas;
}

function kindLabel(navigation: Navigation | null, kind: string): string | undefined {
  return navigation?.kinds.find((one) => one.kind === kind)?.many;
}

/** The group a kind's request belongs to, for the «Выбрать N» reach. */
function groupCheck(visible: readonly NavigationKind[], active: ReadonlySet<string>): { all: boolean; some: boolean; count: number } {
  const on = visible.filter((kind) => active.has(kind.kind)).length;
  return { all: visible.length > 0 && on === visible.length, some: on > 0 && on < visible.length, count: visible.length };
}

/** What one kind's fill stands as: nothing the graph holds of it, records it holds, or a fill that did not finish it. */
type KindState = 'never' | 'filled' | 'failed';

/**
 * The kinds the newest runs left failed (madarch-64o5.133): the newest run that reached a kind decides it, and only a
 * failed or cancelled unit says the fill did not finish the kind. A kind the newest run never reached, or reached while
 * waiting or running, keeps the graph's own verdict.
 */
function failedKinds(runs: readonly FillRunDetail[]): Set<string> {
  const seen = new Set<string>();
  const failed = new Set<string>();
  for (const run of runs) {
    for (const group of run.groups) {
      if (seen.has(group.kind)) continue;
      seen.add(group.kind);
      if (group.phase === 'failed' || group.phase === 'cancelled') failed.add(group.kind);
    }
  }
  return failed;
}

/** One kind's state: a failed fill first, then whether the graph holds any record of the kind at all. */
const stateOf = (kind: NavigationKind, failed: ReadonlySet<string>): KindState =>
  failed.has(kind.kind) ? 'failed' : kind.count > 0 ? 'filled' : 'never';

const sectionId = (key: string): string => `catalogue-section-${encodeURIComponent(key)}`;

/** One filter: the kit's one-choice-of-several menu, on the same line as the other controls. */
function FilterSelect({ label, value, options, onChange, testId }: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly testId: string;
}): ReactElement {
  return (
    <FieldLabel className="grid gap-1 text-small">
      {label}
      <ChoiceMenu label={label} value={value} options={options} onChange={onChange} testId={testId} />
    </FieldLabel>
  );
}

export function CatalogueSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const descriptionId = useId();
  const language = (context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en');
  const navigation = context.navigation;
  const base = context.base;
  const initialKinds = typeof context.variables['kinds'] === 'string' ? context.variables['kinds'] : '';
  const [selecting, setSelecting] = useState(context.variables['select'] === '1');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialKinds.split(',').filter((kind) => kind !== '')));
  const lastKinds = useRef(initialKinds);
  const lastSelect = useRef(context.variables['select'] === '1');
  const [search, setSearch] = useState('');
  const [area, setArea] = useState('');
  const [taken, setTaken] = useState('any');
  const [fill, setFill] = useState('any');
  const [onlySelected, setOnlySelected] = useState(false);
  const allKinds = (navigation?.kinds ?? []).map((kind) => kind.kind).sort();
  const allKey = allKinds.join(',');
  const allRead = useCommandRead<{ plan: FillPlanView }>(`catalogue-plan:${allKey}`, (signal) => readFillPlan(base, allKinds, signal), allKinds.length > 0);
  const selection = [...selected].sort();
  const selectedKey = selection.join(',');
  const planRead = useCommandRead<{ plan: FillPlanView }>(`catalogue-selection:${selectedKey}`, (signal) => readFillPlan(base, selection, signal), selecting && selection.length > 0);
  const allPlan = allRead.data?.plan;
  const selectionPlan = selection.length === 0 ? undefined : planRead.data?.plan;
  // The fill's own record of each kind: the newest run that reached a kind says whether a fill left it failed, and the
  // graph's count says whether it holds anything of the kind (madarch-64o5.133). The runs are read through the one
  // read API, as the rest of the page's data is (madarch-64o5.136 restore).
  const runs = useCommandRead<{ runs: readonly FillRunDetail[] }>('fill-runs', (signal) => fetchFillRuns(context.base, undefined, signal));
  useChangeStream(context.base, () => { runs.reload(); });
  const failed = failedKinds(runs.data?.runs ?? []);

  // A new address (the kind page's «Изменить состав», a reload) resets the mode and the explicit selection.
  useEffect(() => {
    const incoming = typeof context.variables['kinds'] === 'string' ? context.variables['kinds'] : '';
    const mode = context.variables['select'] === '1';
    if (incoming !== lastKinds.current || mode !== lastSelect.current) {
      lastKinds.current = incoming;
      lastSelect.current = mode;
      setSelecting(mode);
      setSelected(new Set(incoming.split(',').filter((kind) => kind !== '')));
    }
  }, [context.variables]);

  const added = new Map<string, string>();
  for (const entry of selectionPlan?.added ?? []) added.set(entry.kind, entry.neededBy);
  const active = new Set([...selected, ...added.keys()]);
  const errors = new Map((allPlan?.errors ?? []).map((error) => [error.kind, error]));
  const groupLabels = (id: string | null): string => id === null ? t('knowledge.groupOther') : navigation?.groups.find((group) => group.name === id)?.labels[language] ?? id;

  const sync = (next: Set<string>, mode = selecting): void => {
    const address = mode ? catalogueSelectionAddress([...next]) : '/p/catalogue';
    try { window.history.replaceState({}, '', `${base}${address}`); } catch { /* a browser that refuses history keeps the page */ }
  };
  const enterSelection = (): void => {
    setSelecting(true);
    setOnlySelected(false);
    lastSelect.current = true;
    sync(selected, true);
  };
  const leaveSelection = (): void => {
    setSelecting(false);
    setOnlySelected(false);
    setSelected(new Set());
    lastSelect.current = false;
    lastKinds.current = '';
    sync(new Set(), false);
  };
  const toggle = (ids: readonly string[], add: boolean): void => {
    setSelected((held) => {
      const next = new Set(held);
      for (const id of ids) { if (add) next.add(id); else next.delete(id); }
      sync(next, true);
      return next;
    });
  };

  const needle = lower(search.trim(), language);
  const matches = (kind: NavigationKind): boolean => {
    if (needle !== '' && !lower(`${kind.one} ${kind.many} ${kind.definition ?? ''}`, language).includes(needle)) return false;
    if (area !== '' && kind.group !== area && !(navigation?.groups.find((group) => group.name === kind.group)?.parent === area)) return false;
    if (taken === 'in' && !kind.taken) return false;
    if (taken === 'out' && kind.taken) return false;
    if (fill !== 'any') {
      const filled = filledBy(planKindOf(allPlan, kind.kind));
      if (fill === 'plugins' && filled.plugins.length === 0) return false;
      if (fill === 'agent' && filled.agent.length === 0) return false;
    }
    if (selecting && onlySelected && !active.has(kind.kind)) return false;
    return true;
  };
  const areas = areasOf(navigation, matches, language);
  const kindsOf = (area: Area): NavigationKind[] => [...area.direct, ...area.subgroups.flatMap((subgroup) => subgroup.kinds)];
  const shownCount = areas.reduce((sum, one) => sum + kindsOf(one).length, 0);
  const shownRecords = areas.reduce((sum, one) => sum + kindsOf(one).reduce((inner, kind) => inner + kind.count, 0), 0);
  /** The header's and each area's line: how many kinds stand here and how many records the graph holds of them. */
  const totalsOf = (kinds: readonly NavigationKind[]): string =>
    `${t('knowledge.catalogueKinds', { count: kinds.length })}, ${t('knowledge.catalogueEntities', { count: kinds.reduce((sum, kind) => sum + kind.count, 0) })}`;
  const contents = areas.map((area) => ({
    id: sectionId(area.id === '' ? '\u0000other' : area.id),
    label: area.id === '' ? t('knowledge.groupOther') : area.label,
    children: area.subgroups.map((subgroup) => ({ id: sectionId(subgroup.id), label: subgroup.label })),
  }));
  const topAreas = [...new Set((navigation?.groups ?? []).filter((group) => group.parent === null || !new Set((navigation?.groups ?? []).map((one) => one.name)).has(group.parent)).map((group) => group.name))];
  const linkOf = (kind: NavigationKind): { href: string; onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void } | null => {
    if (kind.entryId === null) return null;
    const href = entityAddress(CATALOGUE_KIND, kind.entryId);
    return { href: base + href, onClick: (event) => { event.preventDefault(); context.open(href); } };
  };

  const groupBox = (kinds: readonly NavigationKind[]): ReactElement | null => {
    if (!selecting) return null;
    const box = groupCheck(kinds, active);
    return (
      <FieldLabel className="ml-auto flex items-center gap-2 text-small text-muted">
        <Checkbox
          checked={box.all ? true : box.some ? 'indeterminate' : false}
          onCheckedChange={() => toggle(kinds.filter((kind) => !added.has(kind.kind)).map((kind) => kind.kind), !box.all)}
          data-testid="catalogue-group-check"
        />
        {t('catalogue.selectGroup', { count: box.count })}
      </FieldLabel>
    );
  };

  const row = (kind: NavigationKind): ReactElement => {
    const planKind = planKindOf(allPlan, kind.kind);
    const filled = filledBy(planKind);
    const applicability = planKind?.applicability;
    const needed = added.get(kind.kind);
    const neededLabel = needed === undefined ? undefined : kindLabel(navigation, needed) ?? needed;
    const neededId = needed === undefined ? undefined : `${descriptionId}-${kind.kind}`;
    const error: FillPlanError | undefined = errors.get(kind.kind);
    const link = linkOf(kind);
    const state = stateOf(kind, failed);
    return (
      <ListItem key={kind.kind} className="border-b border-line py-3 last:border-b-0" data-testid="catalogue-kind" data-kind={kind.kind} data-changed={context.changedKinds?.has(kind.kind) ? 'true' : undefined}>
        <Stack className="flex items-start gap-3">
          {selecting ? (
            <Checkbox
              checked={active.has(kind.kind)}
              disabled={needed !== undefined}
              aria-describedby={neededId}
              onCheckedChange={() => toggle([kind.kind], !selected.has(kind.kind))}
              aria-label={kind.many}
              data-testid={`catalogue-kind-check-${kind.kind}`}
            />
          ) : null}
          <Stack className="min-w-0 flex-1 gap-1">
            <InlineGroup className="mb-0 gap-x-3">
              {link === null ? <Text className="font-medium">{kind.many}</Text> : <TextLink href={link.href} onClick={link.onClick} className="font-medium">{kind.many}</TextLink>}
              <Text className="text-small text-muted" data-testid="catalogue-count">{t('knowledge.catalogueEntities', { count: kind.count })}</Text>
              <Badge variant={state === 'never' ? 'outline' : 'solid'} data-testid="catalogue-state" data-state={state}>{t(`knowledge.catalogueState.${state}`)}</Badge>
              {kind.taken ? <Badge variant="outline" data-testid="catalogue-taken">{t('catalogue.taken')}</Badge> : null}
            </InlineGroup>
            {kind.definition === null || kind.definition === '' ? null : <Paragraph className="m-0 text-small text-secondary" data-testid="catalogue-definition">{kind.definition}</Paragraph>}
            {applicability === undefined ? null : (
              <Stack className="grid gap-1" data-testid="catalogue-applicability">
                <InlineGroup className="mb-0 gap-2">
                  <Badge variant="outline" data-testid="catalogue-applicability-state">{t(`applicability.state.${applicability.state}`)}</Badge>
                  {applicability.contested ? <Badge variant="outline">{t('applicability.contested')}</Badge> : null}
                </InlineGroup>
                {applicability.state === 'not-searched' ? null : <Paragraph className="m-0 text-small text-muted" data-testid="catalogue-applicability-reason">{t('applicability.reason', { reason: applicability.reason })}</Paragraph>}
                {applicability.ancestor === undefined ? null : <Paragraph className="m-0 text-small text-muted" data-testid="catalogue-applicability-ancestor">{t('applicability.ancestor', { kind: kindLabel(navigation, applicability.ancestor) ?? applicability.ancestor })}</Paragraph>}
              </Stack>
            )}
            {error !== undefined ? <Paragraph className="m-0 text-small" data-testid="catalogue-fill-error">{error.plugin === undefined ? error.message : t('catalogue.errorPlugin', { plugin: error.plugin })}</Paragraph> : null}
            {error === undefined && filled.plugins.length > 0 ? <Paragraph className="m-0 text-small text-muted" data-testid="catalogue-fill-line">{t('catalogue.filledBy')} <PluginNames names={filled.plugins} plan={allPlan} language={language} /></Paragraph> : null}
            {planKind?.agentOnly ? (
              <Paragraph className="m-0 text-small text-muted" data-testid="catalogue-agent-line">{t('catalogue.agentOnly')}</Paragraph>
            ) : error === undefined && filled.agent.length > 0 ? (
              <Paragraph className="m-0 text-small text-muted" data-testid="catalogue-agent-line">{t('catalogue.agentFills', { fields: filled.agent.map((field) => fieldLabel(allPlan, kind.kind, field, language)).join(', ') })}</Paragraph>
            ) : null}
            {error === undefined && !planKind?.agentOnly && filled.plugins.length === 0 && filled.agent.length === 0 ? <Paragraph className="m-0 text-small text-muted" data-testid="catalogue-no-fields">{t('catalogue.noFields')}</Paragraph> : null}
            {neededLabel === undefined ? null : <Paragraph className="m-0 text-small text-muted" id={neededId} data-testid="catalogue-needed">{t('catalogue.neededFor', { kind: neededLabel })}</Paragraph>}
          </Stack>
        </Stack>
      </ListItem>
    );
  };

  return (
    <Stack layout="catalogue" className="gap-4" data-testid="catalogue-page">
      <Stack className="grid min-w-0 gap-4">
        <Stack className="flex flex-wrap items-end justify-between gap-3">
          <Paragraph className="m-0 text-secondary">{t('knowledge.catalogueIntro')}</Paragraph>
          {selecting ? (
            <Button variant="ghost" size="default" onClick={leaveSelection} data-testid="catalogue-exit">{t('catalogue.exitSelection')}</Button>
          ) : (
            <Button variant="default" size="default" onClick={enterSelection} data-testid="catalogue-select">{t('catalogue.select')}</Button>
          )}
        </Stack>
        {allRead.error === null ? null : <Alert variant="problem" data-testid="catalogue-error"><AlertDescription>{allRead.error}</AlertDescription></Alert>}
        {allPlan === undefined && allRead.error === null ? <Skeleton className="h-8 w-72" /> : null}
        {allPlan === undefined ? null : (
          <>
            <Stack className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FieldLabel className="grid gap-1 text-small">{t('catalogue.search')}
                <Input type="search" className="w-full" value={search} onInput={(event) => setSearch(event.currentTarget.value)} placeholder={t('catalogue.search')} aria-label={t('catalogue.search')} data-testid="catalogue-search" />
              </FieldLabel>
              <FilterSelect label={t('catalogue.area')} value={area} onChange={setArea} testId="catalogue-area" options={[{ value: '', label: t('catalogue.areaAll') }, ...topAreas.map((name) => ({ value: name, label: groupLabels(name) }))]} />
              <FilterSelect label={t('catalogue.inProduct')} value={taken} onChange={setTaken} testId="catalogue-taken-filter" options={[{ value: 'any', label: t('catalogue.any') }, { value: 'in', label: t('catalogue.inProductOnly') }, { value: 'out', label: t('catalogue.notInProduct') }]} />
              <FilterSelect label={t('catalogue.filledByFilter')} value={fill} onChange={setFill} testId="catalogue-fill-filter" options={[{ value: 'any', label: t('catalogue.any') }, { value: 'plugins', label: t('catalogue.fillPlugins') }, { value: 'agent', label: t('catalogue.fillAgent') }]} />
            </Stack>
            <Stack className="flex flex-wrap items-center gap-3">
              <Text className="text-small text-muted" data-testid="catalogue-total">{t('knowledge.catalogueKinds', { count: shownCount })}{', '}{t('knowledge.catalogueEntities', { count: shownRecords })}</Text>
              {selecting ? <Button size="default" variant={onlySelected ? 'default' : 'ghost'} onClick={() => setOnlySelected((held) => !held)} data-testid="catalogue-show-selected">{t(onlySelected ? 'catalogue.showAll' : 'catalogue.showSelected')}</Button> : null}
            </Stack>
            {areas.length === 0 ? <Paragraph className="text-small text-muted" data-testid="catalogue-nomatch">{t('catalogue.noMatch')}</Paragraph> : null}
            {areas.map((top) => (
              <Stack key={top.id === '' ? '\u0000other' : top.id} id={sectionId(top.id === '' ? '\u0000other' : top.id)} className="grid scroll-mt-4 gap-3" data-testid="catalogue-area" data-group={top.id}>
                <Stack className="flex w-full flex-wrap items-baseline justify-between gap-3">
                  <SectionTitle className="m-0 min-w-0">{top.id === '' ? t('knowledge.groupOther') : top.label}</SectionTitle>
                  <Text className="text-small text-muted" data-testid="catalogue-group-total">{totalsOf(kindsOf(top))}</Text>
                  {groupBox(kindsOf(top))}
                </Stack>
                {top.direct.length === 0 ? null : <PlainList className="m-0 list-none p-0">{top.direct.map(row)}</PlainList>}
                {top.subgroups.map((subgroup) => (
                  <Disclosure key={subgroup.id} open id={sectionId(subgroup.id)} className="scroll-mt-4 rounded-lg border border-line p-3" data-testid="catalogue-subgroup" data-subgroup={subgroup.id}>
                    <DisclosureSummary className="flex w-full cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
                      <SmallTitle className="m-0 text-small font-medium">{subgroup.label}</SmallTitle>
                      <Text className="text-small text-muted" data-testid="catalogue-subgroup-count">{totalsOf(subgroup.kinds)}</Text>
                      {groupBox(subgroup.kinds)}
                    </DisclosureSummary>
                    <PlainList className="m-0 list-none p-0">{subgroup.kinds.map(row)}</PlainList>
                  </Disclosure>
                ))}
              </Stack>
            ))}
          </>
        )}
        {selecting ? (
          <Stack className="sticky bottom-0 z-10 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-page px-4 py-2 shadow-sm" data-testid="catalogue-bottom">
            <Text className="text-small" data-testid="catalogue-selected-count">{t('catalogue.selectedCount', { count: selected.size })}{' · '}{t('catalogue.dependencyCount', { count: added.size })}</Text>
            <InlineGroup className="mb-0 gap-2">
              <Button variant="default" size="default" disabled={selection.length === 0} disabledReason={t('catalogue.chooseKind')} onClick={() => context.open(prepareAddress(selection))} data-testid="catalogue-prepare">{t('catalogue.toPrepare')}</Button>
            </InlineGroup>
          </Stack>
        ) : null}
      </Stack>
      {areas.length === 0 ? null : <ResponsiveContents title={t('knowledge.catalogueViews.contents')} items={contents} />}
    </Stack>
  );
}

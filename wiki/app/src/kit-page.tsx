/**
 * The kit's review surface (the owner's approval of the shadcn-shaped kit, decision 0020): every component the app may
 * compose, in its states, drawn from the kit and nothing else. New components still require the owner's approval, so the
 * page is the whole kit's one list: a component that is not here is not the kit's.
 */
import { useState, type ReactElement } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, CircleHelpIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import {
  Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from './components/ui/breadcrumb.js';
import { Button } from './components/ui/button.js';
import { ChoiceMenu } from './components/ui/choice-menu.js';
import { DateTimeField, DateTimePanel, type DateTimeLabels } from './components/ui/date-time-field.js';
import {
  ActivityCalendar, ChartBar, ChartCalendar, ChartHeatmap, ChartSparkline, ChartStackedBar, ChartSunburst, ChartTreemap,
  type ChartDay, type ChartNode,
} from './components/ui/charts.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Checkbox } from './components/ui/checkbox.js';
import { ChoiceCard, ChoiceDescription } from './components/ui/choice-card.js';
import { ConfirmationPanel } from './components/ui/confirmation-panel.js';
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPreview,
  DialogTitle, DialogTrigger,
} from './components/ui/dialog.js';
import { Disclosure, DisclosureSummary } from './components/ui/disclosure.js';
import {
  ColourSwatch, Drawing, DrawingGroup, DrawingPath, DrawingRect, DrawingSurface, DrawingText, EmbeddedFrame,
} from './components/ui/drawing.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import { FactChart } from './components/ui/fact-chart.js';
import { Figure, FigureCaption } from './components/ui/figure.js';
import { FilterBar, FilterField, FilterResults, PaginationBar, PaginationSummary } from './components/ui/filter-bar.js';
import { InlineCode, Strong } from './components/ui/inline-content.js';
import { Input } from './components/ui/input.js';
import { LogViewer, type LogViewerEntry, type LogViewerFilters, type LogViewerLabels } from './components/ui/log-viewer.js';
import { KitFigureState, KitNarrow, KitPageLayout, KitSection, KitState } from './components/ui/kit-preview.js';
import { MetadataLine } from './components/ui/metadata-line.js';
import {
  NavigationCount, NavigationGroup, NavigationGroupTrigger, NavigationLabel, NavigationLink, NavigationPending,
  NavigationSubheading,
} from './components/ui/navigation.js';
import { OrderedList } from './components/ui/ordered-list.js';
import { Progress } from './components/ui/progress.js';
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.js';
import { Blockquote, ReadingContent } from './components/ui/reading-content.js';
import {
  SearchContainer, SearchGroupTitle, SearchResultLink, SearchResults,
} from './components/ui/search-results.js';
import { SegmentedChoice } from './components/ui/segmented-choice.js';

import {
  ShellAnswersCount, ShellAnswersLink, ShellAnswersWords, ShellBreadcrumb, ShellBreadcrumbSeparator, ShellIconLink,
  ShellTab, ShellTabClose, ShellTabTrigger, ShellTabs,
} from './components/ui/shell.js';
import { Skeleton } from './components/ui/skeleton.js';
import { Switch } from './components/ui/switch.js';
import { SyntaxToken } from './components/ui/syntax-token.js';
import {
  Table, TableBody, TableCell, TableColumn, TableHead, TableHeader, TableRow,
} from './components/ui/table.js';
import { TableColumns } from './components/ui/table-columns.js';
import { ResponsiveContents, TableOfContents } from './components/ui/table-of-contents.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs.js';
import { TechnicalText } from './components/ui/technical-text.js';
import { Textarea } from './components/ui/textarea.js';
import { Toggle } from './components/ui/toggle.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip.js';
import {
  BulletList, ClippedLabel, CodeFrame, ContentsSidebar, DefinitionList, DefinitionTerm, DefinitionValue, FieldLabel,
  FileTitle, Form, InlineGroup, ListItem, Metadata, PageArticle, PageHeader, PageSection, PageTitle, Paragraph,
  PlainList, Preformatted, SectionTitle, SmallTitle, Stack, Text, TextLink,
} from './components/ui/typography.js';

const EXAMPLE_GEOMETRY = {
  contentsStart: "kit-intro",
  swatchBackground: "var(--text)",
  drawingPath: "M0 40 L120 0",
  firstChoice: "one",
  segmentedTestId: "kit-segmented",
  embeddedWidth: "100%",
  columnWidth: "lg",
} as const;

const CONTENTS = [{ id: 'kit-intro', label: 'UI kit' }, { id: 'kit-forms', label: 'Forms' }];

/** The entries the kit's log viewer is shown with: worded engine events, one quoted outside line, and their context. */
function logSample(t: TFunction): readonly LogViewerEntry[] {
  const detail = 'src/index.ts:3: the fixture plugin refused the unit';
  return [
    { id: 'sample-1', at: '2026-11-15T09:41:02.114Z', level: 'info', source: t('logs.source.fill'), run: 'fill-sample', unit: 'disk:code.file', message: t('logs.event.unit-extracted'), quoted: false, detail: null, fields: { attempt: '1', fence: '3' } },
    { id: 'sample-2', at: '2026-11-15T09:41:02.480Z', level: 'warn', source: t('logs.source.plugin'), run: 'fill-sample', unit: 'disk:code.file', message: 'the plugin read a file whose language its parser does not know', quoted: true, detail: null, fields: { path: 'repos/app/src/notes.txt' } },
    { id: 'sample-3', at: '2026-11-15T09:41:07.007Z', level: 'error', source: t('logs.source.fill'), run: 'fill-sample', unit: 'disk:code.repository', message: t('logs.event.plugin-session-failed', { detail }), raw: `the plugin session failed: ${detail}`, quoted: false, detail: 'Error: the plugin is pinned to bun 1.4.2, and this madarch runs another interpreter\n    at startPluginProcess (src/plugin/sandbox.ts:210:11)', fields: { code: 'plugin-closure', file: 'madarch/plugins.lock', path: 'plugins/disk/plugin.json' } },
    { id: 'sample-4', at: '2026-11-15T09:41:07.240Z', level: 'info', source: t('logs.source.store'), run: null, unit: null, message: 'database system is ready to accept connections', quoted: true, detail: null, fields: {} },
    { id: 'sample-5', at: '2026-11-15T09:41:08.902Z', level: 'debug', source: t('logs.source.agent'), run: 'fill-sample', unit: 'agent-fill:doc.term', message: t('logs.event.agent-tool-call', { text: 'Read docs/terms.md (completed)' }), quoted: false, detail: null, fields: {} },
  ];
}

// The figures' data: a repository by bytes, a catalogue by kinds, fill outcomes by day, and ninety days of fills. Fixed
// numbers, so the page reads the same on every run and a shot can be compared with the one before it.
const REPOSITORY: readonly ChartNode[] = [
  { label: 'src', children: [{ label: 'fill', value: 412 }, { label: 'graph', value: 268 }, { label: 'service', value: 196 }, { label: 'knowledge', value: 154 }] },
  { label: 'wiki/app', children: [{ label: 'components', value: 231 }, { label: 'styles', value: 88 }, { label: 'page.tsx', value: 64 }] },
  { label: 'samples', children: [{ label: 'fixtures', value: 142 }, { label: 'fill', value: 96 }] },
  { label: 'docs', value: 120 },
];
/** The same shape the catalogue has: many kinds whose tail is folded into one entry when it outgrows the budget. */
const CATALOGUE: readonly ChartNode[] = Array.from({ length: 40 }, (_, index) => ({ label: `kind-${String(index + 1)}`, value: 40 - index }));
const BARS = [{ label: 'components', value: 3210 }, { label: 'sections', value: 1840 }, { label: 'templates', value: 912 }, { label: 'views', value: 640 }, { label: 'styles', value: 388 }];
const HEATMAP_VALUES = [[6, 8, 3, 9, 5], [4, 7, 9, 2, 8], [5, 3, 6, 7, 4], [9, 2, 4, 8, 6], [3, 6, 8, 5, 7], [1, 2, 1, 3, 2], [0, 1, 2, 1, 0]];
const STACKED_VALUES = [[42, 51, 38, 60, 47], [3, 1, 5, 2, 4], [6, 4, 2, 5, 3]];
const SPARK = [3, 5, 4, 8, 6, 9, 7, 11, 10, 12, 9, 14];
/** Ninety days of fills ending on a fixed day, so the calendar reads the same every run. */
const DAYS: readonly ChartDay[] = Array.from({ length: 90 }, (_, index) => {
  const at = new Date(Date.UTC(2026, 7, 17 + index));
  return { date: at.toISOString().slice(0, 10), count: (index * 7 + (index % 5) * 3) % 13 };
});
const EMPTY_TREE: readonly ChartNode[] = [{ label: 'nothing yet' }];
/** The aggregate a section's `bars`, `treemap` or `timeline` display draws: a label, its value and where it leads. */
const FACT_ROWS = [{ label: 'components', value: 42 }, { label: 'sections', value: 27 }, { label: 'templates', value: 18 }, { label: 'views', value: 9 }];

/** Fold a hierarchy's children to a budget: the biggest stay, the rest become one entry named by the caller. */
function folded(nodes: readonly ChartNode[], budget: number, label: (count: number) => string): ChartNode[] {
  const sorted = [...nodes].sort((left, right) => (right.value ?? 0) - (left.value ?? 0));
  if (sorted.length <= budget) return sorted;
  const kept = sorted.slice(0, budget - 1);
  const rest = sorted.slice(budget - 1);
  return [...kept, { label: label(rest.length), value: rest.reduce((sum, node) => sum + (node.value ?? 0), 0), color: 'var(--surface-soft)', textColor: 'var(--text)' }];
}

/** The five sample days, named by the reader's locale. */
function groupsOf(language: string): string[] {
  return Array.from({ length: 5 }, (_, at) => new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 11 + at))));
}

/** The seven weekday names, born on Monday 2026-01-05, in the reader's locale. */
function weekdaysOf(language: string): string[] {
  return Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 5 + day))));
}

export function KitPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const weekdays = weekdaysOf(language);
  const groups = groupsOf(language);
  const stacked = [t('knowledge.fillRun.state.published'), t('knowledge.fillRun.state.failed'), t('knowledge.fillRun.state.blocked')].map((name, at) => ({ name, data: STACKED_VALUES[at]! }));
  const heatmap = { rows: weekdays, cols: ['W45', 'W46', 'W47', 'W48', 'W49'], values: HEATMAP_VALUES };
  const state = (key: string): string => t(`kit.${key}`);
  const [choice, setChoice] = useState('one');
  const [segment, setSegment] = useState('one');
  const [toggled, setToggled] = useState(false);
  const [logFilters, setLogFilters] = useState<LogViewerFilters>({ source: '', level: '', run: '', from: '', to: '', query: '' });
  const [logLive, setLogLive] = useState(false);
  const [, setMenuChoice] = useState('all');
  const [moment, setMoment] = useState('2026-11-15T12:22:19.850Z');
  const dateTimeLabels: DateTimeLabels = {
    none: t('logs.dateTime.none'), title: t('logs.dateTime.title'), clear: t('logs.dateTime.clear'), done: t('logs.dateTime.done'),
    hour: t('logs.dateTime.hour'), minute: t('logs.dateTime.minute'), second: t('logs.dateTime.second'),
    previous: t('logs.dateTime.previous'), next: t('logs.dateTime.next'), close: t('logs.dateTime.close'),
  };
  const logLabels: LogViewerLabels = {
    source: t('logs.filters.source'), level: t('logs.filters.level'), run: t('logs.filters.run'),
    from: t('logs.filters.from'), to: t('logs.filters.to'), search: t('logs.filters.search'), all: t('logs.filters.all'),
    older: t('logs.filters.older'), empty: t('logs.empty'), loading: t('logs.loading'),
    follow: t('logs.filters.follow'), pause: t('logs.filters.pause'), copy: t('logs.filters.copy'), copied: t('logs.filters.copied'),
    context: t('logs.filters.context'), details: t('logs.filters.details'), quoted: t('logs.quoted'),
    dateTime: dateTimeLabels,
    levels: { debug: t('logs.level.debug'), info: t('logs.level.info'), warn: t('logs.level.warn'), error: t('logs.level.error') },
  };

  return (
    <KitPageLayout title={state('title')} description={state('intro')}>
      <Alert><AlertTitle>{state('approvalTitle')}</AlertTitle><AlertDescription>{state('approval')}</AlertDescription></Alert>

      <KitSection title={state('componentTypography')}>
        <KitState label={state('typography')}>
          <PageArticle>
            <PageHeader><PageTitle>{state('sample')}</PageTitle><Metadata>{state('description')}</Metadata></PageHeader>
            <PageSection><SectionTitle>{state('content')}</SectionTitle><Paragraph>{state('sample')}</Paragraph></PageSection>
            <BulletList><ListItem>{state('sample')}</ListItem></BulletList>
            <OrderedList><ListItem>{state('sample')}</ListItem></OrderedList>
            <PlainList><ListItem>{state('sample')}</ListItem></PlainList>
            <SmallTitle>{state('sample')}</SmallTitle>
            <DefinitionList columns><DefinitionTerm>{state('name')}</DefinitionTerm><DefinitionValue>{state('sample')}</DefinitionValue></DefinitionList>
            <InlineGroup><Badge>{state('sample')}</Badge><TextLink href="/">{state('home')}</TextLink></InlineGroup>
            <MetadataLine label={state('name')}>{state('sample')}</MetadataLine>
            <Text>{state('sample')}</Text>
          </PageArticle>
        </KitState>
      </KitSection>

      <KitSection title={state('componentButton')}>
        <KitState label={state('default')}><Button variant="default" size="default">{state('action')}</Button></KitState>
        <KitState label={state('ghost')}><Button size="default">{state('action')}</Button></KitState>
        <KitState label={state('disabled')}><Button variant="default" size="default" disabled>{state('action')}</Button></KitState>
        <KitState label={state('componentIcon')}><ShellIconLink href="/" aria-label={state('hint')}><CircleHelpIcon aria-hidden="true" size={18} /></ShellIconLink></KitState>
      </KitSection>

      <KitSection title={state('componentInputTextarea')}>
        <KitState label={state('default')}><Input aria-label={state('name')} placeholder={state('name')} /><Textarea aria-label={state('description')} placeholder={state('description')} /></KitState>
        <KitState label={state('disabled')}><Input aria-label={state('name')} defaultValue={state('sample')} disabled /><Textarea aria-label={state('description')} defaultValue={state('sample')} disabled /></KitState>
        <KitState label={state('error')}><Input aria-label={state('name')} aria-invalid="true" aria-describedby="kit-input-error" /><Alert variant="problem" id="kit-input-error"><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
        <KitState label={state('fieldLabel')}><Form><FieldLabel>{state('name')}<Input aria-label={state('name')} /></FieldLabel></Form></KitState>
      </KitSection>

      <KitSection title={state('componentCheckboxRadioSwitchToggle')}>
        <KitState label={`${state('componentCheckbox')} — ${state('default')}`}><Checkbox aria-label={state('name')} /></KitState>
        <KitState label={`${state('componentCheckbox')} — ${state('selected')}`}><Checkbox aria-label={state('name')} defaultChecked /></KitState>
        <KitState label={`${state('componentCheckbox')} — ${state('indeterminate')}`}><Checkbox aria-label={state('name')} checked="indeterminate" /></KitState>
        <KitState label={`${state('componentCheckbox')} — ${state('disabled')}`}><Checkbox aria-label={state('name')} disabled defaultChecked /></KitState>
        <KitState label={state('componentRadiogroup')}>
          <RadioGroup defaultValue="one" aria-label={state('name')}><RadioGroupItem value="one" aria-label={state('selected')} /><RadioGroupItem value="two" aria-label={state('default')} /></RadioGroup>
        </KitState>
        <KitState label={state('componentChoice')}>
          <RadioGroup value={choice} onValueChange={setChoice} aria-label={state('name')}>
            {['one', 'two'].map((value) => (
              <ChoiceCard key={value}><RadioGroupItem value={value} /><ChoiceDescription>{state('sample')}</ChoiceDescription></ChoiceCard>
            ))}
          </RadioGroup>
        </KitState>
        <KitState label={state('componentSwitch')}><Stack className="flex flex-wrap items-center gap-3"><Switch aria-label={state('action')} /><Switch defaultChecked aria-label={state('selected')} /><Switch disabled aria-label={state('disabled')} /></Stack></KitState>
        <KitState label={state('componentToggle')}><Toggle aria-label={state('action')} pressed={toggled} onPressedChange={setToggled}>{state('action')}</Toggle></KitState>
        <KitState label={state('componentProgress')}><Stack className="grid w-80 max-w-full gap-3"><Progress value={45} aria-label={state('loading')} className="h-2.5" /><Progress value={null} aria-label={state('indeterminate')} className="h-2.5" /></Stack></KitState>
      </KitSection>

      <KitSection title={state('componentBadgeAlertCardSkeleton')}>
        <KitState label={state('default')}><Badge>{state('sample')}</Badge><Badge variant="outline">{state('outline')}</Badge><Badge variant="solid">{state('selected')}</Badge></KitState>
        <KitState label={state('error')}><Alert variant="problem"><AlertTitle>{state('error')}</AlertTitle><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
        <KitState label={state('componentCard')}><Card><CardHeader><CardTitle>{state('sample')}</CardTitle><CardDescription>{state('description')}</CardDescription></CardHeader><CardContent>{state('content')}</CardContent></Card></KitState>
        <KitState label={state('loading')}><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-64" /></KitState>
        <KitState label={state('componentConfirmation')}><ConfirmationPanel>{state('content')}</ConfirmationPanel></KitState>
      </KitSection>

      <KitSection title={state('componentTable')}>
        <Table>
          <TableColumns><TableColumn width={EXAMPLE_GEOMETRY.columnWidth} /></TableColumns>
          <TableHeader><TableRow><TableHead>{state('name')}</TableHead><TableHead>{state('description')}</TableHead></TableRow></TableHeader>
          <TableBody><TableRow><TableCell>{state('sample')}</TableCell><TableCell>{state('content')}</TableCell></TableRow></TableBody>
        </Table>
        <KitState label={`FactChart — ${state('bar')}`}><FactChart display="bar" rows={FACT_ROWS} labelTitle={state('name')} valueTitle={state('description')} note={state('noData')} /></KitState>
        <KitState label={`FactChart — ${state('treemap')}`}><FactChart display="treemap" rows={FACT_ROWS} labelTitle={state('name')} valueTitle={state('description')} note={state('noData')} /></KitState>
        <KitState label={`FactChart — ${state('timeline')}`}><FactChart display="timeline" rows={FACT_ROWS} labelTitle={state('name')} valueTitle={state('description')} note={state('noData')} /></KitState>
        <KitState label={`FactChart — ${state('empty')}`}><FactChart display="bar" rows={[]} labelTitle={state('name')} valueTitle={state('description')} note={state('noData')} /></KitState>
      </KitSection>

      <KitSection title={state('componentFilterbar')}>
        <FilterResults>
          <FilterBar><FilterField>{state('name')}<Input aria-label={state('name')} /></FilterField><Button variant="default" size="sm">{state('action')}</Button></FilterBar>
        </FilterResults>
        <PaginationBar><PaginationSummary>1–2 / 2</PaginationSummary><Button size="icon-sm" aria-label={state('next')}><ArrowRightIcon aria-hidden="true" size={14} /></Button></PaginationBar>
      </KitSection>

      <KitSection title={state('choiceMenuTitle')}>
        <KitState label={state('closed')}>
          <ChoiceMenu label={t('logs.filters.source')} value="" options={[{ value: '', label: t('logs.filters.all') }, { value: 'fill', label: t('logs.source.fill') }]} onChange={setMenuChoice} testId="kit-choice-menu" />
        </KitState>
        <KitState label={state('chosen')}>
          <ChoiceMenu label={t('logs.filters.source')} value="fill" options={[{ value: '', label: t('logs.filters.all') }, { value: 'fill', label: t('logs.source.fill') }]} onChange={setMenuChoice} testId="kit-choice-chosen" />
        </KitState>
        <KitState label={state('open')}>
          {/* The open state is a picture of the menu inside its own sample: the kit's menu itself opens over the page. */}
          <Stack className="w-56 rounded-lg border border-line bg-page p-1 text-ink shadow" data-testid="kit-choice-open" aria-hidden="true">
            <Metadata>{t('logs.filters.source')}</Metadata>
            <Stack className="rounded bg-chrome px-2 py-1.5 text-small">{t('logs.filters.all')}</Stack>
            <Stack className="px-2 py-1.5 text-small">{t('logs.source.fill')}</Stack>
          </Stack>
        </KitState>
        <KitState label={state('closed')}>
          <DateTimeField label={t('logs.filters.from')} value={moment} onChange={setMoment} locale={language} labels={dateTimeLabels} testId="kit-moment" />
        </KitState>
        <KitState label={state('empty')}>
          <DateTimeField label={t('logs.filters.from')} value="" onChange={setMoment} locale={language} labels={dateTimeLabels} testId="kit-moment-empty" />
        </KitState>
        <KitState label={state('open')}>
          <DialogPreview title={t('logs.filters.from')} description={t('logs.dateTime.title')}>
            <DateTimePanel value={moment} locale={language} labels={dateTimeLabels} onCommit={setMoment} onClear={() => { setMoment(''); }} />
          </DialogPreview>
        </KitState>
      </KitSection>

      <KitSection title={state('componentTabs')}>
        <Tabs defaultValue={EXAMPLE_GEOMETRY.firstChoice}>
          <TabsList aria-label={state('tabs')}><TabsTrigger value="one">{state('sample')}</TabsTrigger><TabsTrigger value="two">{state('content')}</TabsTrigger></TabsList>
          <TabsContent value="one">{state('sample')}</TabsContent>
          <TabsContent value="two">{state('content')}</TabsContent>
        </Tabs>
        <ShellTabs aria-label={state('tabs')}>
          <ShellTab active><ShellTabTrigger>{state('sample')}</ShellTabTrigger><ShellTabClose aria-label={state('close')}>{t('common.closeSymbol')}</ShellTabClose></ShellTab>
          <ShellTab active={false}><ShellTabTrigger>{state('content')}</ShellTabTrigger></ShellTab>
        </ShellTabs>
      </KitSection>

      <KitSection title={state('componentDialog')} description={state('overlayHint')}>
        <KitState label={state('open')}>
          <DialogPreview title={state('notice')} description={state('description')} footer={<Button size="default" disabled>{state('disabled')}</Button>}>
            <Alert variant="problem"><AlertDescription>{state('required')}</AlertDescription></Alert>
          </DialogPreview>
        </KitState>
        <Dialog>
          <DialogTrigger asChild><Button variant="default" size="default">{state('open')}</Button></DialogTrigger>
          <DialogContent closeLabel={state('close')}>
            <DialogHeader><DialogTitle>{state('notice')}</DialogTitle><DialogDescription>{state('description')}</DialogDescription></DialogHeader>
            <DialogBody><Paragraph>{state('content')}</Paragraph></DialogBody>
            <DialogFooter><DialogClose asChild><Button size="default">{state('close')}</Button></DialogClose></DialogFooter>
          </DialogContent>
        </Dialog>
      </KitSection>

      <KitSection title={state('componentMenus')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="default" size="default">{state('open')}</Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{state('name')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value="one"><DropdownMenuRadioItem value="one">{state('selected')}</DropdownMenuRadioItem><DropdownMenuRadioItem value="two">{state('default')}</DropdownMenuRadioItem></DropdownMenuRadioGroup>
            <DropdownMenuItem>{state('action')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild><Button variant="default" size="default">{state('hint')}</Button></TooltipTrigger>
          <TooltipContent>{state('description')}</TooltipContent>
        </Tooltip>
      </KitSection>

      <KitSection title={state('componentNavigation')}>
        <NavigationGroup>
          <NavigationGroupTrigger icon={CircleHelpIcon} open empty={false}><NavigationLabel>{state('sample')}</NavigationLabel><NavigationCount>2</NavigationCount></NavigationGroupTrigger>
          <NavigationSubheading icon={CircleHelpIcon}><NavigationLabel>{state('content')}</NavigationLabel></NavigationSubheading>
          <NavigationLink icon={CircleHelpIcon} href="/#kit-forms" active={false}><NavigationLabel>{state('sample')}</NavigationLabel><NavigationPending>+1</NavigationPending></NavigationLink>
        </NavigationGroup>
        <NavigationLink icon={CircleHelpIcon} href="/#kit-intro"><NavigationLabel>{state('home')}</NavigationLabel></NavigationLink>
        <ShellBreadcrumb>{state('breadcrumb')}<ShellBreadcrumbSeparator />{state('content')}</ShellBreadcrumb>
        <ShellAnswersLink href="/#kit-intro"><ShellAnswersWords>{state('notice')}</ShellAnswersWords><ShellAnswersCount>2</ShellAnswersCount></ShellAnswersLink>
        <Breadcrumb aria-label={state('breadcrumb')}>
          <BreadcrumbList>
            <BreadcrumbItem><BreadcrumbLink href="/">{state('home')}</BreadcrumbLink></BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbEllipsis /></BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>{state('sample')}</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </KitSection>

      <KitSection title={state('componentDisclosureFigureContents')}>
        <Disclosure><DisclosureSummary>{state('content')}</DisclosureSummary><Paragraph>{state('sample')}</Paragraph></Disclosure>
        <Figure><DrawingSurface width={120} height={40}><Drawing width={120} height={40}><DrawingGroup><DrawingRect x={0} y={0} width={120} height={40} /><DrawingPath d={EXAMPLE_GEOMETRY.drawingPath} /><DrawingText x={4} y={16}>{state('sample')}</DrawingText></DrawingGroup></Drawing></DrawingSurface><FigureCaption>{state('description')}</FigureCaption></Figure>
        <ColourSwatch background={EXAMPLE_GEOMETRY.swatchBackground} />
        <TableOfContents title={state('content')} items={CONTENTS} activeId={EXAMPLE_GEOMETRY.contentsStart} />
        <ContentsSidebar><ResponsiveContents title={state('content')} items={CONTENTS} /></ContentsSidebar>
      </KitSection>

      <KitSection title={state('componentReading')}>
        <KitState label={state('componentInline')}><InlineCode>const value = 1;</InlineCode><Strong>{state('sample')}</Strong></KitState>
        <KitState label={state('componentCode')}><CodeFrame><Preformatted><SyntaxToken colors={{ color: 'var(--text)' }}>const value = 1;</SyntaxToken></Preformatted></CodeFrame></KitState>
        <KitState label={state('componentText')}><TechnicalText>{state('sample')}</TechnicalText><ClippedLabel>{state('description')}</ClippedLabel><FileTitle>example.ts</FileTitle></KitState>
        <KitState label={state('componentQuote')}><ReadingContent compact><Blockquote>{state('sample')}</Blockquote></ReadingContent></KitState>
        <KitState label={state('componentSegmented')}><SegmentedChoice label={state('name')} testId={EXAMPLE_GEOMETRY.segmentedTestId} value={segment} options={[{ value: 'one', label: state('sample'), testId: 'kit-seg-1' }, { value: 'two', label: state('content'), testId: 'kit-seg-2' }]} onChange={setSegment} /></KitState>
      </KitSection>

      <KitSection title={state('componentSearch')}>
        <SearchContainer><Input aria-label={state('name')} placeholder={state('name')} /></SearchContainer>
        <SearchResults>
          <SearchGroupTitle>{state('name')}</SearchGroupTitle>
          <SearchResultLink active href="/#kit-intro">{state('sample')}</SearchResultLink>
          <SearchResultLink active={false} href="/#kit-forms">{state('content')}</SearchResultLink>
        </SearchResults>
      </KitSection>

      <KitSection title={state('logsTitle')} description={t('logs.intro')}>
        <KitState label={state('default')}>
          <LogViewer entries={logSample(t)} filters={logFilters} onFilters={setLogFilters} sources={[{ value: 'fill', label: t('logs.source.fill') }, { value: 'plugin', label: t('logs.source.plugin') }, { value: 'agent', label: t('logs.source.agent') }, { value: 'store', label: t('logs.source.store') }]} runs={[{ value: 'fill-sample', label: 'fill-sample' }]} labels={logLabels} live={logLive} onLive={setLogLive} summary={t('logs.summary', { shown: 5, scanned: 5 })} locale={language} />
        </KitState>
        <KitState label={state('error')}>
          <LogViewer entries={logSample(t)} filters={{ ...logFilters, level: 'error', query: 'pinned' }} onFilters={setLogFilters} sources={[]} runs={[]} labels={logLabels} live={false} onLive={setLogLive} initialSelectedId="sample-3" summary={t('logs.summary', { shown: 1, scanned: 5 })} locale={language} />
        </KitState>
        <KitState label={state('empty')}>
          <LogViewer entries={[]} filters={logFilters} onFilters={setLogFilters} sources={[]} runs={[]} labels={logLabels} live={false} onLive={setLogLive} locale={language} />
        </KitState>
        <KitState label={state('loading')}>
          <LogViewer entries={[]} loading filters={logFilters} onFilters={setLogFilters} sources={[]} runs={[]} labels={logLabels} live={false} onLive={setLogLive} locale={language} />
        </KitState>
        <KitState label={state('logsLive')}>
          <LogViewer entries={logSample(t).slice(-2)} filters={logFilters} onFilters={setLogFilters} sources={[]} runs={[]} labels={logLabels} live onLive={setLogLive} locale={language} />
        </KitState>
      </KitSection>

      <KitSection title={state('charts')} description={state('chartsNote')}>
        <KitState label={`${state('treemap')} — ${state('data')}`}>
          <ChartTreemap title={state('treeTitle')} nodes={REPOSITORY} width={640} height={240} note={state('noData')} />
        </KitState>
        <KitState label={`${state('treemap')} — ${state('folded')}`}>
          <ChartTreemap title={state('foldedTitle')} nodes={folded(CATALOGUE, 6, (count) => t('kit.foldedCount', { count }))} width={640} height={240} note={state('noData')} />
        </KitState>
        <KitState label={`${state('treemap')} — ${state('empty')}`}>
          <ChartTreemap title={state('treeTitle')} nodes={EMPTY_TREE} width={640} height={240} note={state('noData')} />
        </KitState>
        <KitState label={`${state('sunburst')} — ${state('data')}`}>
          <ChartSunburst title={state('sunburstTitle')} nodes={REPOSITORY} width={360} height={360} note={state('noData')} />
        </KitState>
        <KitState label={`${state('sunburst')} — ${state('empty')}`}>
          <ChartSunburst title={state('sunburstTitle')} nodes={EMPTY_TREE} width={360} height={360} note={state('noData')} />
        </KitState>
        <KitState label={`${state('bar')} — ${state('data')}`}>
          <ChartBar title={state('barTitle')} rows={BARS} width={520} height={220} note={state('noData')} />
        </KitState>
        <KitState label={`${state('bar')} — ${state('empty')}`}>
          <ChartBar title={state('barTitle')} rows={[]} width={520} height={220} note={state('noData')} />
        </KitState>
        <KitState label={`${state('stackedBar')} — ${state('data')}`}>
          <ChartStackedBar title={state('stackedTitle')} groups={groups} series={stacked} width={520} height={240} note={state('noData')} />
        </KitState>
        <KitState label={`${state('stackedBar')} — ${state('empty')}`}>
          <ChartStackedBar title={state('stackedTitle')} groups={[]} series={[]} width={520} height={240} note={state('noData')} />
        </KitState>
        <KitState label={`${state('heatmap')} — ${state('data')}`}>
          <ChartHeatmap title={state('heatmapTitle')} matrix={heatmap} width={560} height={260} printValues note={state('noData')} />
        </KitState>
        <KitState label={`${state('heatmap')} — ${state('empty')}`}>
          <ChartHeatmap title={state('heatmapTitle')} matrix={{ rows: weekdays, cols: [], values: [] }} width={560} height={260} note={state('noData')} />
        </KitState>
        <KitState label={`${state('sparkline')} — ${state('data')}`}>
          <ChartSparkline title={state('sparklineTitle')} values={SPARK} width={240} height={48} note={state('noData')} />
        </KitState>
        <KitState label={`${state('sparkline')} — ${state('empty')}`}>
          <ChartSparkline title={state('sparklineTitle')} values={[]} note={state('noData')} />
        </KitState>
        <KitState label={`${state('calendar')} — ${state('data')}`}>
          <ChartCalendar title={state('calendarTitle')} days={DAYS} width={640} height={140} note={state('noData')} />
        </KitState>
        <KitState label={`${state('calendar')} — ${state('empty')}`}>
          <ChartCalendar title={state('calendarTitle')} days={[]} width={640} height={140} note={state('noData')} />
        </KitState>
        <KitFigureState label={`${state('activity')} — ${state('data')}`}>
          <ActivityCalendar title={state('activityTitle')} days={DAYS} note={state('noData')} />
        </KitFigureState>
        <KitFigureState label={`${state('activity')} — ${state('empty')}`}>
          <ActivityCalendar title={state('activityTitle')} days={[]} note={state('noData')} />
        </KitFigureState>
        <KitFigureState label={state('narrow')}>
          <KitNarrow>
            <ChartTreemap title={state('treeTitle')} nodes={REPOSITORY} width={390} height={180} note={state('noData')} />
            <ChartBar title={state('barTitle')} rows={BARS.slice(0, 3)} width={390} height={180} note={state('noData')} />
            <ChartCalendar title={state('calendarTitle')} days={DAYS} width={390} height={110} note={state('noData')} />
            <ActivityCalendar title={state('activityTitle')} days={DAYS} note={state('noData')} />
          </KitNarrow>
        </KitFigureState>
        <KitFigureState label={state('darkCharts')}>
          <ChartHeatmap title={state('heatmapTitle')} matrix={heatmap} width={560} height={260} note={state('noData')} />
        </KitFigureState>
      </KitSection>

      <KitSection title={state('componentEmbedded')}>
        <EmbeddedFrame title={state('sample')} src="about:blank" width="100%" height={120} />
        <Stack className="mt-2"><Text>{state('description')}</Text></Stack>
      </KitSection>
    </KitPageLayout>
  );
}

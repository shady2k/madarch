/**
 * The kit's review surface (the owner's approval of the shadcn-shaped kit, decision 0020): every component the app may
 * compose, in its states, drawn from the kit and nothing else. New components still require the owner's approval, so the
 * page is the whole kit's one list: a component that is not here is not the kit's.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, CircleHelpIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import {
  Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from './components/ui/breadcrumb.js';
import { Button } from './components/ui/button.js';
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
import {
  GraphBox, GraphCanvas, GraphEdge, GraphEdges, GraphMetadata, GraphViewport, graphLinkClass,
} from './components/ui/graph.js';
import { InlineCode, Strong } from './components/ui/inline-content.js';
import { Input } from './components/ui/input.js';
import { KitPageLayout, KitSection, KitState } from './components/ui/kit-preview.js';
import { MetadataLine } from './components/ui/metadata-line.js';
import {
  NavigationCount, NavigationGroup, NavigationGroupTrigger, NavigationLabel, NavigationLink, NavigationPending,
  NavigationSubheading,
} from './components/ui/navigation.js';
import { OrderedList } from './components/ui/ordered-list.js';
import { Progress } from './components/ui/progress.js';
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.js';
import { RadioInput } from './components/ui/radio-input.js';
import { Blockquote, ReadingContent } from './components/ui/reading-content.js';
import {
  SearchContainer, SearchGroupTitle, SearchResultLink, SearchResults,
} from './components/ui/search-results.js';
import { SegmentedChoice } from './components/ui/segmented-choice.js';
import { Select } from './components/ui/select.js';
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

const CONTENTS = [{ id: 'kit-intro', label: 'UI kit' }, { id: 'kit-forms', label: 'Forms' }];

export function KitPage(): ReactElement {
  const { t } = useTranslation();
  const state = (key: string): string => t(`kit.${key}`);
  const [choice, setChoice] = useState('one');
  const [segment, setSegment] = useState('one');
  const [toggled, setToggled] = useState(false);
  return (
    <KitPageLayout title={state('title')} description={state('intro')}>
      <Alert><AlertTitle>{state('approvalTitle')}</AlertTitle><AlertDescription>{state('approval')}</AlertDescription></Alert>

      <KitSection title="Typography">
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

      <KitSection title="Button">
        <KitState label={state('default')}><Button variant="default" size="default">{state('action')}</Button></KitState>
        <KitState label={state('ghost')}><Button size="default">{state('action')}</Button></KitState>
        <KitState label={state('disabled')}><Button variant="default" size="default" disabled>{state('action')}</Button></KitState>
        <KitState label="Icon"><ShellIconLink href="/" aria-label={state('hint')}><CircleHelpIcon aria-hidden="true" size={18} /></ShellIconLink></KitState>
      </KitSection>

      <KitSection title="Input / Textarea">
        <KitState label={state('default')}><Input aria-label={state('name')} placeholder={state('name')} /><Textarea aria-label={state('description')} placeholder={state('description')} /></KitState>
        <KitState label={state('disabled')}><Input aria-label={state('name')} defaultValue={state('sample')} disabled /><Textarea aria-label={state('description')} defaultValue={state('sample')} disabled /></KitState>
        <KitState label={state('error')}><Input aria-label={state('name')} aria-invalid="true" aria-describedby="kit-input-error" /><Alert variant="problem" id="kit-input-error"><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
        <KitState label={state('name')}><Form><FieldLabel>{state('name')}<Input aria-label={state('name')} /></FieldLabel><Select aria-label={state('name')} options={[{ value: 'one', label: state('sample') }, { value: 'two', label: state('description') }]} /></Form></KitState>
      </KitSection>

      <KitSection title="Checkbox / Radio / Switch / Toggle">
        <KitState label="Checkbox"><Checkbox aria-label={state('name')} defaultChecked /></KitState>
        <KitState label="RadioGroup">
          <RadioGroup defaultValue="one" aria-label={state('name')}><RadioGroupItem value="one" aria-label={state('selected')} /><RadioGroupItem value="two" aria-label={state('default')} /></RadioGroup>
        </KitState>
        <KitState label="Choice">
          <RadioGroup value={choice} onValueChange={setChoice} aria-label={state('name')}>
            {['one', 'two'].map((value) => (
              <ChoiceCard key={value}><RadioInput name="kit-choice" value={value} checked={choice === value} onChange={() => { setChoice(value); }} /><ChoiceDescription>{state('sample')}</ChoiceDescription></ChoiceCard>
            ))}
          </RadioGroup>
        </KitState>
        <KitState label="Switch"><Switch aria-label={state('action')} /><Switch defaultChecked aria-label={state('selected')} /><Switch disabled aria-label={state('disabled')} /></KitState>
        <KitState label="Toggle"><Toggle aria-label={state('action')} pressed={toggled} onPressedChange={setToggled}>{state('action')}</Toggle></KitState>
        <KitState label="Progress"><Progress value={45} aria-label={state('loading')} className="w-48" /><Progress value={null} aria-label={state('indeterminate')} className="w-48" /></KitState>
      </KitSection>

      <KitSection title="Badge / Alert / Card / Skeleton">
        <KitState label={state('default')}><Badge>{state('sample')}</Badge><Badge variant="outline">{state('outline')}</Badge><Badge variant="solid">{state('selected')}</Badge></KitState>
        <KitState label={state('error')}><Alert variant="problem"><AlertTitle>{state('error')}</AlertTitle><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
        <KitState label="Card"><Card><CardHeader><CardTitle>{state('sample')}</CardTitle><CardDescription>{state('description')}</CardDescription></CardHeader><CardContent>{state('content')}</CardContent></Card></KitState>
        <KitState label={state('loading')}><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-64" /></KitState>
        <KitState label="Confirmation"><ConfirmationPanel>{state('content')}</ConfirmationPanel></KitState>
      </KitSection>

      <KitSection title="Table">
        <Table>
          <TableColumns><TableColumn width="lg" /></TableColumns>
          <TableHeader><TableRow><TableHead>{state('name')}</TableHead><TableHead>{state('description')}</TableHead></TableRow></TableHeader>
          <TableBody><TableRow><TableCell>{state('sample')}</TableCell><TableCell>{state('content')}</TableCell></TableRow></TableBody>
        </Table>
        <FactChart display="bar" rows={[{ label: state('sample'), value: 3 }, { label: state('content'), value: 7 }]} labelTitle={state('name')} valueTitle={state('description')} />
      </KitSection>

      <KitSection title="FilterBar">
        <FilterResults>
          <FilterBar><FilterField>{state('name')}<Input aria-label={state('name')} /></FilterField><Button variant="default" size="sm">{state('action')}</Button></FilterBar>
        </FilterResults>
        <PaginationBar><PaginationSummary>1–2 / 2</PaginationSummary><Button size="icon-sm" aria-label="next"><ArrowRightIcon aria-hidden="true" size={14} /></Button></PaginationBar>
      </KitSection>

      <KitSection title="Tabs">
        <Tabs defaultValue="one">
          <TabsList aria-label={state('tabs')}><TabsTrigger value="one">{state('sample')}</TabsTrigger><TabsTrigger value="two">{state('content')}</TabsTrigger></TabsList>
          <TabsContent value="one">{state('sample')}</TabsContent>
          <TabsContent value="two">{state('content')}</TabsContent>
        </Tabs>
        <ShellTabs aria-label={state('tabs')}>
          <ShellTab active><ShellTabTrigger>{state('sample')}</ShellTabTrigger><ShellTabClose aria-label={state('close')}>×</ShellTabClose></ShellTab>
          <ShellTab active={false}><ShellTabTrigger>{state('content')}</ShellTabTrigger></ShellTab>
        </ShellTabs>
      </KitSection>

      <KitSection title="Dialog" description={state('overlayHint')}>
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

      <KitSection title="Menus">
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

      <KitSection title="Navigation">
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

      <KitSection title="Disclosure / Figure / Contents">
        <Disclosure><DisclosureSummary>{state('content')}</DisclosureSummary><Paragraph>{state('sample')}</Paragraph></Disclosure>
        <Figure><DrawingSurface width={120} height={40}><Drawing width={120} height={40}><DrawingGroup><DrawingRect x={0} y={0} width={120} height={40} /><DrawingPath d="M0 40 L120 0" /><DrawingText x={4} y={16}>{state('sample')}</DrawingText></DrawingGroup></Drawing></DrawingSurface><FigureCaption>{state('description')}</FigureCaption></Figure>
        <ColourSwatch background="var(--text)" />
        <TableOfContents title={state('content')} items={CONTENTS} activeId="kit-intro" />
        <ContentsSidebar><ResponsiveContents title={state('content')} items={CONTENTS} /></ContentsSidebar>
      </KitSection>

      <KitSection title="Graph">
        <GraphViewport>
          <GraphCanvas width={240} height={120}>
            <GraphEdges><GraphEdge active d="M20 20 L180 80" /></GraphEdges>
            <GraphBox x={10} y={10} width={100} height={40} active><Text className={graphLinkClass}>{state('sample')}</Text><GraphMetadata>{state('name')}</GraphMetadata></GraphBox>
          </GraphCanvas>
        </GraphViewport>
      </KitSection>

      <KitSection title="Reading">
        <KitState label="Inline"><InlineCode>const value = 1;</InlineCode><Strong>{state('sample')}</Strong></KitState>
        <KitState label="Code"><CodeFrame><Preformatted><SyntaxToken colors={{ color: 'var(--text)' }}>const value = 1;</SyntaxToken></Preformatted></CodeFrame></KitState>
        <KitState label="Text"><TechnicalText>{state('sample')}</TechnicalText><ClippedLabel>{state('description')}</ClippedLabel><FileTitle>example.ts</FileTitle></KitState>
        <KitState label="Quote"><ReadingContent compact><Blockquote>{state('sample')}</Blockquote></ReadingContent></KitState>
        <KitState label="Segmented"><SegmentedChoice label={state('name')} testId="kit-segmented" value={segment} options={[{ value: 'one', label: state('sample'), testId: 'kit-seg-1' }, { value: 'two', label: state('content'), testId: 'kit-seg-2' }]} onChange={setSegment} /></KitState>
      </KitSection>

      <KitSection title="Search">
        <SearchContainer><Input aria-label={state('name')} placeholder={state('name')} /></SearchContainer>
        <SearchResults>
          <SearchGroupTitle>{state('name')}</SearchGroupTitle>
          <SearchResultLink active href="/#kit-intro">{state('sample')}</SearchResultLink>
          <SearchResultLink active={false} href="/#kit-forms">{state('content')}</SearchResultLink>
        </SearchResults>
      </KitSection>

      <KitSection title="Embedded">
        <EmbeddedFrame title={state('sample')} src="about:blank" width="100%" height={120} />
        <Stack className="mt-2"><Text>{state('description')}</Text></Stack>
      </KitSection>
    </KitPageLayout>
  );
}

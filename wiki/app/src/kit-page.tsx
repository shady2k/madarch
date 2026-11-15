/**
 * The kit's review surface (the owner's approval of the shadcn-shaped kit, decision 0020; one component per job,
 * madarch-64o5.130): every component the app may compose, once, in its states, drawn from the kit and nothing else.
 * A component that is not here is not the kit's.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, CircleHelpIcon, HomeIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import {
  Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
  PageBreadcrumb,
} from './components/ui/breadcrumb.js';
import { Button, IconButton } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Checkbox } from './components/ui/checkbox.js';
import { ChoiceCard, ChoiceDescription } from './components/ui/choice-card.js';
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPreview,
  DialogTitle, DialogTrigger,
} from './components/ui/dialog.js';
import { Disclosure, DisclosureSummary } from './components/ui/disclosure.js';
import {
  ColourSwatch, DiagramScaled, DiagramZoomBar, DiagramZoomBox, Drawing, DrawingGroup, DrawingPath, DrawingRect,
  DrawingSurface, DrawingText, EmbeddedFrame,
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
import { KitFrame, KitPageLayout, KitSection, KitState } from './components/ui/kit-preview.js';
import {
  BrandLink, NavigationCount, NavigationFooter, NavigationGroup, NavigationGroupTrigger, NavigationHeading,
  NavigationLabel, NavigationLink, NavigationPending, NavigationScroll, NavigationSection, NavigationSubheading,
  ProductButton,
} from './components/ui/navigation.js';
import { Progress } from './components/ui/progress.js';
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.js';
import { Blockquote, ReadingContent } from './components/ui/reading-content.js';
import {
  SearchContainer, SearchGroupTitle, SearchResultLink, SearchResults,
} from './components/ui/search-results.js';
import { SegmentedChoice } from './components/ui/segmented-choice.js';
import { Select } from './components/ui/select.js';
import {
  Sheet, SheetContent, SheetTrigger,
} from './components/ui/sheet.js';
import {
  ShellActions, ShellBrandMark, ShellDocument, ShellError, ShellFixed, ShellMain, ShellNavigationLoading,
  ShellNavigationSheet, ShellPhoneOnly, ShellProductLink, ShellProductMenu, ShellRoleLabel, ShellRow, ShellScroll,
  ShellSidebar, ShellToolbar, ShellToolbarLoading,
} from './components/ui/shell.js';
import { Skeleton } from './components/ui/skeleton.js';
import { SyntaxToken } from './components/ui/syntax-token.js';
import {
  Table, TableBody, TableCell, TableColumn, TableHead, TableHeader, TableRow,
} from './components/ui/table.js';
import { TableColumns } from './components/ui/table-columns.js';
import { ResponsiveContents, TableOfContents } from './components/ui/table-of-contents.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs.js';
import { Textarea } from './components/ui/textarea.js';
import { Toggle } from './components/ui/toggle.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip.js';
import {
  BulletList, CodeFrame, ContentsSidebar, DefinitionList, DefinitionTerm, DefinitionValue, FieldLabel, Form,
  InlineGroup, ListItem, Metadata, OrderedList, PageArticle, PageHeader, PageSection, PageTitle, Paragraph, PlainList,
  Preformatted, SectionTitle, SmallTitle, Stack, Text, TextLink,
} from './components/ui/typography.js';

const CONTENTS = [{ id: 'kit-intro', label: 'UI kit' }, { id: 'kit-presses', label: 'Presses' }];

export function KitPage(): ReactElement {
  const { t } = useTranslation();
  const state = (key: string): string => t(`kit.${key}`);
  const [choice, setChoice] = useState('one');
  const [segment, setSegment] = useState('one');
  const [tab, setTab] = useState('one');
  return (
    <KitPageLayout title={state('title')} description={state('intro')}>
      <Alert id="kit-intro"><AlertTitle>{state('approvalTitle')}</AlertTitle><AlertDescription>{state('approval')}</AlertDescription></Alert>
      <Alert><AlertDescription>{state('onePerJob')}</AlertDescription></Alert>

      <KitSection title={state('page')} description={state('pageHint')}>
        <KitState label={state('default')}>
          <PageArticle>
            <PageHeader><PageTitle data-testid="kit-page-title">{state('sample')}</PageTitle><Metadata>{state('description')}</Metadata></PageHeader>
            <PageSection><SectionTitle>{state('content')}</SectionTitle><Paragraph>{state('sample')}</Paragraph></PageSection>
          </PageArticle>
        </KitState>
        <KitState label={state('withPath')}>
          <PageArticle><PageHeader><PageTitle path="src/index.ts">{state('name')}</PageTitle></PageHeader></PageArticle>
        </KitState>
        <KitState label={state('text')}>
          <Stack className="grid gap-1"><Text>{state('sample')}</Text><Metadata>{state('description')}</Metadata><SmallTitle>{state('content')}</SmallTitle><InlineGroup><InlineCode>const value = 1;</InlineCode><Strong>{state('sample')}</Strong><TextLink href="#kit-intro">{state('home')}</TextLink></InlineGroup></Stack>
        </KitState>
      </KitSection>

      <KitSection title={state('lists')} description={state('listsHint')}>
        <KitState label={state('default')}>
          <Stack className="grid gap-2">
            <BulletList><ListItem>{state('sample')}</ListItem><ListItem>{state('content')}</ListItem></BulletList>
            <OrderedList><ListItem>{state('sample')}</ListItem><ListItem>{state('content')}</ListItem></OrderedList>
            <PlainList><ListItem>{state('sample')}</ListItem></PlainList>
            <DefinitionList columns><DefinitionTerm>{state('name')}</DefinitionTerm><DefinitionValue>{state('sample')}</DefinitionValue></DefinitionList>
          </Stack>
        </KitState>
      </KitSection>

      <KitSection title={state('panels')} description={state('panelsHint')}>
        <KitState label={state('default')}>
          <Card><CardHeader><CardTitle>{state('sample')}</CardTitle><CardDescription>{state('description')}</CardDescription></CardHeader><CardContent>{state('content')}</CardContent></Card>
        </KitState>
        <KitState label={state('notice')}><Alert><AlertTitle>{state('notice')}</AlertTitle><AlertDescription>{state('description')}</AlertDescription></Alert></KitState>
        <KitState label={state('error')}><Alert variant="problem"><AlertTitle>{state('error')}</AlertTitle><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
        <KitState label={state('badges')}><InlineGroup><Badge variant="outline">{state('outline')}</Badge><Badge variant="solid">{state('selected')}</Badge></InlineGroup></KitState>
        <KitState label={state('loading')}><Stack className="grid gap-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-64" /></Stack></KitState>
        <KitState label={state('closed')}><Disclosure><DisclosureSummary>{state('content')}</DisclosureSummary><Paragraph className="m-0">{state('sample')}</Paragraph></Disclosure></KitState>
        <KitState label={state('figure')}>
          <Figure><DrawingSurface width={120} height={40}><Drawing width={120} height={40}><DrawingGroup><DrawingRect x={0} y={0} width={120} height={40} /><DrawingPath d="M0 40 L120 0" /><DrawingText x={4} y={16}>{state('sample')}</DrawingText></DrawingGroup></Drawing></DrawingSurface><FigureCaption>{state('description')}</FigureCaption></Figure>
        </KitState>
        <KitState label={state('progress')}><Stack className="grid gap-2"><Progress value={45} aria-label={state('loading')} /><Progress value={null} aria-label={state('indeterminate')} /></Stack></KitState>
      </KitSection>

      <KitSection title={state('presses')} description={state('buttonsHint')}>
        <KitState label={state('default')}><Button data-testid="kit-button-default">{state('action')}</Button></KitState>
        <KitState label={state('hover')}><Button data-testid="kit-button-hover">{state('action')}</Button></KitState>
        <KitState label={state('focus')}><Button data-testid="kit-button-focus">{state('action')}</Button></KitState>
        <KitState label={state('disabled')}><Button data-testid="kit-button-disabled" disabled disabledReason={state('disabledReason')}>{state('action')}</Button></KitState>
        <KitState label={state('iconButton')}><IconButton label={state('hint')} data-testid="kit-icon-default"><CircleHelpIcon aria-hidden="true" size={18} /></IconButton></KitState>
        <KitState label={state('iconHover')}><IconButton label={state('hint')} data-testid="kit-icon-hover"><CircleHelpIcon aria-hidden="true" size={18} /></IconButton></KitState>
        <KitState label={state('iconFocus')}><IconButton label={state('hint')} data-testid="kit-icon-focus"><CircleHelpIcon aria-hidden="true" size={18} /></IconButton></KitState>
        <KitState label={state('iconDisabled')}><IconButton label={state('hint')} data-testid="kit-icon-disabled" disabled disabledReason={state('disabledReason')}><CircleHelpIcon aria-hidden="true" size={18} /></IconButton></KitState>
        <KitState label={state('toggleOff')}><Toggle pressed={false} onPressedChange={() => undefined} data-testid="kit-toggle-off">{state('action')}</Toggle></KitState>
        <KitState label={state('toggleOn')}><Toggle pressed onPressedChange={() => undefined} data-testid="kit-toggle-on">{state('selected')}</Toggle></KitState>
        <KitState label={state('toggleHover')}><Toggle pressed={false} onPressedChange={() => undefined} data-testid="kit-toggle-hover">{state('action')}</Toggle></KitState>
        <KitState label={state('toggleFocus')}><Toggle pressed={false} onPressedChange={() => undefined} data-testid="kit-toggle-focus">{state('action')}</Toggle></KitState>
        <KitState label={state('toggleDisabled')}><Toggle pressed={false} onPressedChange={() => undefined} disabled disabledReason={state('disabledReason')} data-testid="kit-toggle-disabled">{state('action')}</Toggle></KitState>
        <KitState label={state('choiceGroup')}>
          <SegmentedChoice label={state('name')} testId="kit-segmented" value={segment} options={[{ value: 'one', label: state('sample'), testId: 'kit-seg-1' }, { value: 'two', label: state('content'), testId: 'kit-seg-2' }]} onChange={setSegment} />
        </KitState>
        <KitState label={state('choiceGroupDisabled')}>
          <SegmentedChoice label={state('name')} testId="kit-segmented-disabled" value="one" options={[{ value: 'one', label: state('sample'), testId: 'kit-seg-disabled-1' }]} onChange={() => undefined} disabled disabledReason={state('disabledReason')} />
        </KitState>
      </KitSection>

      <KitSection title={state('forms')} description={state('formsHint')}>
        <KitState label={state('default')}>
          <Form>
            <FieldLabel>{state('name')}<Input aria-label={state('name')} placeholder={state('name')} /></FieldLabel>
            <FieldLabel>{state('description')}<Textarea aria-label={state('description')} placeholder={state('description')} /></FieldLabel>
            <FieldLabel>{state('select')}<Select aria-label={state('select')} options={[{ value: 'one', label: state('sample') }, { value: 'two', label: state('description') }]} /></FieldLabel>
          </Form>
        </KitState>
        <KitState label={state('disabled')}>
          <Form>
            <FieldLabel>{state('name')}<Input aria-label={state('name')} defaultValue={state('sample')} disabled /></FieldLabel>
            <FieldLabel>{state('description')}<Textarea aria-label={state('description')} defaultValue={state('sample')} disabled /></FieldLabel>
          </Form>
        </KitState>
        <KitState label={state('error')}><Input aria-label={state('name')} aria-invalid="true" aria-describedby="kit-input-error" /><Alert variant="problem" id="kit-input-error"><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
        <KitState label={state('checkbox')}><Checkbox aria-label={state('name')} defaultChecked /></KitState>
        <KitState label={state('radioGroup')}>
          <RadioGroup value={choice} onValueChange={setChoice} aria-label={state('name')}>
            {['one', 'two'].map((value) => (<ChoiceCard key={value}><RadioGroupItem value={value} aria-label={value} /><ChoiceDescription>{state('sample')}</ChoiceDescription></ChoiceCard>))}
          </RadioGroup>
        </KitState>
      </KitSection>

      <KitSection title={state('tables')} description={state('tablesHint')}>
        <KitState label={state('default')}>
          <Table>
            <TableColumns><TableColumn width="lg" /><TableColumn width="sm" /></TableColumns>
            <TableHeader><TableRow><TableHead>{state('name')}</TableHead><TableHead>{state('description')}</TableHead></TableRow></TableHeader>
            <TableBody><TableRow><TableCell>{state('sample')}</TableCell><TableCell>{state('content')}</TableCell></TableRow></TableBody>
          </Table>
        </KitState>
        <KitState label={state('facts')}><FactChart display="bar" rows={[{ label: state('sample'), value: 3 }, { label: state('content'), value: 7 }]} labelTitle={state('name')} valueTitle={state('description')} /></KitState>
        <KitState label={state('filters')}>
          <FilterResults>
            <FilterBar><FilterField>{state('name')}<Input aria-label={state('name')} /></FilterField><Button>{state('action')}</Button></FilterBar>
          </FilterResults>
          <PaginationBar><PaginationSummary>1–2 / 2</PaginationSummary><IconButton label={state('next')}><ArrowRightIcon aria-hidden="true" size={16} /></IconButton></PaginationBar>
        </KitState>
      </KitSection>

      <KitSection title={state('tabs')} description={state('tabsHint')}>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label={state('tabs')}><TabsTrigger value="one">{state('sample')}</TabsTrigger><TabsTrigger value="two">{state('content')}</TabsTrigger></TabsList>
          <TabsContent value="one">{state('sample')}</TabsContent>
          <TabsContent value="two">{state('content')}</TabsContent>
        </Tabs>
      </KitSection>

      <KitSection title={state('dialog')} description={state('overlayHint')}>
        <KitState label={state('closed')}>
          <DialogPreview title={state('notice')} description={state('description')} footer={<Button disabled disabledReason={state('disabledReason')}>{state('disabled')}</Button>}>
            <Alert variant="problem"><AlertDescription>{state('required')}</AlertDescription></Alert>
          </DialogPreview>
        </KitState>
        <KitState label={state('open')}>
          <Dialog>
            <DialogTrigger asChild><Button>{state('open')}</Button></DialogTrigger>
            <DialogContent closeLabel={state('close')}>
              <DialogHeader><DialogTitle>{state('notice')}</DialogTitle><DialogDescription>{state('description')}</DialogDescription></DialogHeader>
              <DialogBody><Paragraph className="m-0">{state('content')}</Paragraph></DialogBody>
              <DialogFooter><DialogClose asChild><Button>{state('close')}</Button></DialogClose></DialogFooter>
            </DialogContent>
          </Dialog>
        </KitState>
      </KitSection>

      <KitSection title={state('sheet')} description={state('sheetHint')}>
        <KitState label={state('open')}>
          <Sheet>
            <SheetTrigger asChild><Button>{state('open')}</Button></SheetTrigger>
            <SheetContent title={state('sheetTitle')} closeLabel={state('close')}><Paragraph className="m-0">{state('content')}</Paragraph></SheetContent>
          </Sheet>
        </KitState>
      </KitSection>

      <KitSection title={state('menus')} description={state('menusHint')}>
        <KitState label={state('default')}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button>{state('open')}</Button></DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>{state('name')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value="one"><DropdownMenuRadioItem value="one">{state('selected')}</DropdownMenuRadioItem><DropdownMenuRadioItem value="two">{state('default')}</DropdownMenuRadioItem></DropdownMenuRadioGroup>
              <DropdownMenuItem>{state('action')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </KitState>
        <KitState label={state('productMenu')}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button>{state('open')}</Button></DropdownMenuTrigger>
            <ShellProductMenu>
              <DropdownMenuLabel>{state('name')}</DropdownMenuLabel>
              <DropdownMenuItem asChild><ShellProductLink href="#kit-intro" onClick={(event) => { event.preventDefault(); }}><NavigationLabel>{state('home')}</NavigationLabel></ShellProductLink></DropdownMenuItem>
            </ShellProductMenu>
          </DropdownMenu>
        </KitState>
        <KitState label={state('tooltip')}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild><Button>{state('hint')}</Button></TooltipTrigger>
              <TooltipContent>{state('description')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </KitState>
      </KitSection>

      <KitSection title={state('navigation')} description={state('navigationHint')}>
        <KitState label={state('default')}>
          <NavigationScroll>
            <NavigationSection>
              <NavigationHeading>{state('sample')}</NavigationHeading>
              <NavigationGroup>
                <NavigationGroupTrigger icon={CircleHelpIcon} open empty={false}><NavigationLabel>{state('sample')}</NavigationLabel><NavigationCount>2</NavigationCount></NavigationGroupTrigger>
                <NavigationSubheading icon={CircleHelpIcon}><NavigationLabel>{state('content')}</NavigationLabel></NavigationSubheading>
                <NavigationLink icon={HomeIcon} href="#kit-intro" active><NavigationLabel>{state('home')}</NavigationLabel><NavigationPending>+1</NavigationPending></NavigationLink>
                <NavigationLink icon={CircleHelpIcon} href="#kit-presses"><NavigationLabel>{state('content')}</NavigationLabel></NavigationLink>
              </NavigationGroup>
            </NavigationSection>
            <NavigationFooter><NavigationLink icon={CircleHelpIcon} href="#kit-intro"><NavigationLabel>{state('home')}</NavigationLabel></NavigationLink></NavigationFooter>
          </NavigationScroll>
        </KitState>
        <KitState label={state('brand')}><BrandLink href="#kit-intro" onClick={(event) => { event.preventDefault(); }} concept={state('sample')}><ShellBrandMark /><Strong>madarch</Strong></BrandLink></KitState>
        <KitState label={state('product')}><ProductButton name={state('sample')} description={state('description')} aria-label={state('sample')} /></KitState>
        <KitState label={state('role')}><Button aria-label={state('roleTitle')} title={state('roleTitle')}><CircleHelpIcon aria-hidden="true" size={18} /><ShellRoleLabel>{state('sample')}</ShellRoleLabel></Button></KitState>
      </KitSection>

      <KitSection title={state('breadcrumb')} description={state('breadcrumbHint')}>
        <KitState label={state('default')}>
          <Breadcrumb aria-label={state('breadcrumb')}>
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink href="#kit-intro">{state('home')}</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbEllipsis /></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>{state('sample')}</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </KitState>
        <KitState label={state('trail')}>
          <PageBreadcrumb label={state('breadcrumb')} items={[{ label: state('home'), href: '#kit-intro' }, { label: state('content'), href: '#kit-presses' }, { label: state('sample') }]} />
        </KitState>
      </KitSection>

      <KitSection title={state('search')} description={state('searchHint')}>
        <KitState label={state('default')}><SearchContainer><Input aria-label={state('name')} placeholder={state('name')} /></SearchContainer></KitState>
        <KitState label={state('results')}>
          <SearchResults>
            <SearchGroupTitle>{state('name')}</SearchGroupTitle>
            <SearchResultLink active href="#kit-intro">{state('sample')}</SearchResultLink>
            <SearchResultLink active={false} href="#kit-presses">{state('content')}</SearchResultLink>
          </SearchResults>
        </KitState>
      </KitSection>

      <KitSection title={state('contents')} description={state('contentsHint')}>
        <KitState label={state('default')}>
          <TableOfContents title={state('content')} items={CONTENTS} activeId="kit-intro" />
        </KitState>
        <KitState label={state('responsive')}>
          <ContentsSidebar><ResponsiveContents title={state('content')} items={CONTENTS} /></ContentsSidebar>
        </KitState>
      </KitSection>

      <KitSection title={state('drawing')} description={state('drawingHint')}>
        <KitState label={state('default')}>
          <DrawingSurface width={160} height={60}><Drawing width={160} height={60} viewBox="0 0 160 60"><DrawingGroup><DrawingRect x={2} y={2} width={156} height={56} /><DrawingPath d="M10 50 L150 10" /><DrawingText x={12} y={24}>{state('sample')}</DrawingText></DrawingGroup></Drawing></DrawingSurface>
        </KitState>
        <KitState label={state('swatch')}><ColourSwatch background="var(--ink)" /></KitState>
        <KitState label={state('zoom')}>
          <Stack className="grid gap-1">
            <DiagramZoomBar><IconButton label={state('zoomOut')} onClick={() => undefined}>−</IconButton><IconButton label={state('zoomIn')} onClick={() => undefined}>+</IconButton><Button onClick={() => undefined}>{state('fit')}</Button></DiagramZoomBar>
            <DiagramZoomBox><DiagramScaled zoom={1} html={`<span>${state('sample')}</span>`} /></DiagramZoomBox>
          </Stack>
        </KitState>
        <KitState label={state('embedded')}><EmbeddedFrame title={state('sample')} src="about:blank" width="100%" height={120} /></KitState>
      </KitSection>

      <KitSection title={state('reading')} description={state('readingHint')}>
        <KitState label={state('code')}><CodeFrame><Preformatted><SyntaxToken colors={{ color: 'var(--text)' }}>const value = 1;</SyntaxToken></Preformatted></CodeFrame></KitState>
        <KitState label={state('quote')}><ReadingContent compact><Blockquote>{state('sample')}</Blockquote></ReadingContent></KitState>
      </KitSection>

      <KitSection title={state('shell')} description={state('shellHint')}>
        <KitState label={state('shellFrame')}>
          <KitFrame height="tall">
            <Stack className="flex h-full">
              <ShellSidebar loading aria-hidden="true"><ShellNavigationLoading /></ShellSidebar>
              <ShellMain>
                <ShellToolbar><ShellActions><IconButton label={state('hint')}><CircleHelpIcon aria-hidden="true" size={18} /></IconButton></ShellActions><ShellRoleLabel>{state('sample')}</ShellRoleLabel></ShellToolbar>
                <ShellFixed><Metadata>{state('fixed')}</Metadata></ShellFixed>
                <ShellRow><ShellScroll><ShellDocument><Paragraph className="m-0">{state('document')}</Paragraph></ShellDocument></ShellScroll></ShellRow>
              </ShellMain>
            </Stack>
          </KitFrame>
        </KitState>
        <KitState label={state('toolbarLoading')}><KitFrame height="short"><ShellToolbarLoading /></KitFrame></KitState>
        <KitState label={state('phone')}><ShellPhoneOnly><Paragraph className="m-0">{state('phoneOnly')}</Paragraph></ShellPhoneOnly></KitState>
        <KitState label={state('navigationSheet')}>
          <Sheet>
            <SheetTrigger asChild><Button>{state('open')}</Button></SheetTrigger>
            <ShellNavigationSheet title={state('sheetTitle')} closeLabel={state('close')}><Paragraph className="m-0">{state('content')}</Paragraph></ShellNavigationSheet>
          </Sheet>
        </KitState>
        <KitState label={state('errorScreen')}><KitFrame height="short"><ShellError><Paragraph className="m-0" role="alert">{state('error')}</Paragraph></ShellError></KitFrame></KitState>
      </KitSection>
    </KitPageLayout>
  );
}

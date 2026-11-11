/** The agreed kit's review surface. New components still require owner approval. */
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Toggle } from '@/components/ui/toggle.js';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { Sheet, SheetTrigger, SheetContent } from '@/components/ui/sheet.js';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem } from '@/components/ui/dropdown-menu.js';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip.js';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table.js';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose, DialogPreview } from '@/components/ui/dialog.js';
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, BreadcrumbEllipsis } from '@/components/ui/breadcrumb.js';
import { Progress } from '@/components/ui/progress.js';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group.js';
import { Switch } from '@/components/ui/switch.js';
import { KitPageLayout, KitSection, KitState } from '@/components/ui/kit-preview.js';
import { PageSection, PageHeader, PageTitle, SectionTitle, Paragraph, BulletList, ListItem, Metadata, InlineGroup, CodeFrame, FileTitle, TextLink } from '@/components/ui/typography.js';
import { appPath } from '../app-base.js';

export function KitPage() {
  const { t } = useTranslation();
  const state = (key: string) => t(`kit.${key}`);
  return <TooltipProvider>
    <KitPageLayout title={state('title')} description={state('intro')}>
      <Alert><AlertTitle>{state('approvalTitle')}</AlertTitle><AlertDescription>{state('approval')}</AlertDescription></Alert>
      <KitSection title="Button">
        <KitState label={state('default')}><Button variant="default" size="default">{state('action')}</Button></KitState>
        <KitState label={state('ghost')}><Button size="default">{state('action')}</Button></KitState>
        <KitState label={state('disabled')}><Button variant="default" size="default" disabled>{state('action')}</Button></KitState>
      </KitSection>
      <KitSection title="Input / Textarea">
        <KitState label={state('default')}><Input aria-label={state('name')} placeholder={state('name')} /><Textarea aria-label={state('description')} placeholder={state('description')} /></KitState>
        <KitState label={state('disabled')}><Input aria-label={state('name')} defaultValue={state('sample')} disabled /><Textarea aria-label={state('description')} defaultValue={state('sample')} disabled /></KitState>
        <KitState label={state('error')}><Input aria-label={state('name')} aria-invalid="true" aria-describedby="kit-input-error" /><Textarea aria-label={state('description')} aria-invalid="true" aria-describedby="kit-input-error" /><Alert variant="problem" id="kit-input-error"><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
      </KitSection>
      <KitSection title="Badge">
        <KitState label={state('default')}><Badge>{state('sample')}</Badge></KitState>
        <KitState label={state('outline')}><Badge variant="outline">{state('sample')}</Badge></KitState>
        <KitState label={state('selected')}><Badge variant="solid">{state('selected')}</Badge></KitState>
      </KitSection>
      <KitSection title="Toggle">
        <KitState label={state('default')}><Toggle aria-label={state('action')} className="px-3 py-2">{state('action')}</Toggle></KitState>
        <KitState label={state('selected')}><Toggle defaultPressed aria-label={state('action')} className="px-3 py-2">{state('action')}</Toggle></KitState>
        <KitState label={state('disabled')}><Toggle disabled aria-label={state('action')} className="px-3 py-2">{state('action')}</Toggle></KitState>
      </KitSection>
      <KitSection title="Alert">
        <KitState label={state('default')}><Alert><AlertTitle>{state('notice')}</AlertTitle><AlertDescription>{state('sample')}</AlertDescription></Alert></KitState>
        <KitState label={state('error')}><Alert variant="problem"><AlertTitle>{state('error')}</AlertTitle><AlertDescription>{state('required')}</AlertDescription></Alert></KitState>
      </KitSection>
      <KitSection title="Card">
        <Card><CardHeader><CardTitle>{state('sample')}</CardTitle><CardDescription>{state('description')}</CardDescription></CardHeader><CardContent>{state('content')}</CardContent></Card>
      </KitSection>
      <KitSection title="Table">
        <Table><TableHeader><TableRow><TableHead>{state('name')}</TableHead><TableHead>{state('description')}</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>{state('sample')}</TableCell><TableCell>{state('content')}</TableCell></TableRow><TableRow aria-selected="true"><TableCell>{state('selected')}</TableCell><TableCell>{state('sample')}</TableCell></TableRow></TableBody></Table>
      </KitSection>
      <KitSection title="Skeleton" description={state('loading')}>
        <Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-64" />
      </KitSection>
      <KitSection title="Dialog" description={state('overlayHint')}>
        <KitState label={state('open')}><DialogPreview title={state('notice')} description={state('description')}><Alert variant="problem"><AlertDescription>{state('required')}</AlertDescription></Alert><Button size="default" disabled>{state('disabled')}</Button></DialogPreview></KitState>
        <Dialog><DialogTrigger asChild><Button variant="default" size="default">{state('open')}</Button></DialogTrigger><DialogContent closeLabel={state('close')}><DialogHeader><DialogTitle>{state('notice')}</DialogTitle><DialogDescription>{state('description')}</DialogDescription></DialogHeader><Alert variant="problem"><AlertDescription>{state('required')}</AlertDescription></Alert><DialogFooter><DialogClose asChild><Button size="default">{state('close')}</Button></DialogClose><Button size="default" disabled>{state('disabled')}</Button></DialogFooter></DialogContent></Dialog>
        <Dialog><DialogTrigger asChild><Button size="default" disabled>{state('disabled')}</Button></DialogTrigger></Dialog>
      </KitSection>
      <KitSection title="Sheet" description={state('overlayHint')}>
        <Sheet><SheetTrigger asChild><Button variant="default" size="default">{state('open')}</Button></SheetTrigger><SheetContent title={state('notice')} closeLabel={state('close')}><Paragraph>{state('content')}</Paragraph></SheetContent></Sheet>
        <Sheet><SheetTrigger asChild><Button size="default" disabled>{state('disabled')}</Button></SheetTrigger></Sheet>
      </KitSection>
      <KitSection title="DropdownMenu">
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="default" size="default">{state('open')}</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuLabel>{state('name')}</DropdownMenuLabel><DropdownMenuItem>{state('action')}</DropdownMenuItem><DropdownMenuItem disabled>{state('disabled')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </KitSection>
      <KitSection title="Tooltip">
        <Tooltip><TooltipTrigger asChild><Button variant="default" size="default">{state('hint')}</Button></TooltipTrigger><TooltipContent>{state('description')}</TooltipContent></Tooltip>
      </KitSection>
      <KitSection title="Breadcrumb">
        <Breadcrumb aria-label={state('breadcrumb')}><BreadcrumbList><BreadcrumbItem><BreadcrumbLink href={appPath('/')}>{state('home')}</BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbEllipsis /></BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>{state('title')}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
      </KitSection>
      <KitSection title="Progress">
        <KitState label={state('empty')}><Progress value={0} aria-label={state('loading')} className="w-48" /></KitState>
        <KitState label={state('loading')}><Progress value={45} aria-label={state('loading')} className="w-48" /></KitState>
        <KitState label={state('complete')}><Progress value={100} aria-label={state('loading')} className="w-48" /></KitState>
        <KitState label={state('indeterminate')}><Progress value={null} aria-label={state('loading')} className="w-48" /></KitState>
      </KitSection>
      <KitSection title="RadioGroup">
        <RadioGroup defaultValue="one" aria-label={state('name')}><RadioGroupItem value="one" aria-label={state('selected')} /><RadioGroupItem value="two" aria-label={state('default')} /><RadioGroupItem value="three" disabled aria-label={state('disabled')} /></RadioGroup>
        <KitState label={state('error')}><RadioGroup aria-invalid="true" aria-label={state('required')}><RadioGroupItem value="one" aria-label={state('sample')} /></RadioGroup></KitState>
      </KitSection>
      <KitSection title="Switch">
        <KitState label={state('default')}><Switch aria-label={state('action')} /></KitState>
        <KitState label={state('selected')}><Switch defaultChecked aria-label={state('action')} /></KitState>
        <KitState label={state('disabled')}><Switch disabled aria-label={state('action')} /><Switch disabled defaultChecked aria-label={state('selected')} /></KitState>
        <KitState label={state('error')}><Switch aria-invalid="true" aria-label={state('required')} /></KitState>
      </KitSection>
      <KitSection title={state('typography')}>
        <PageSection><PageHeader><PageTitle>{state('sample')}</PageTitle><Metadata>{state('description')}</Metadata></PageHeader><SectionTitle>{state('content')}</SectionTitle><Paragraph>{state('sample')}</Paragraph><BulletList><ListItem>{state('sample')}</ListItem></BulletList><InlineGroup><Badge>{state('sample')}</Badge></InlineGroup><TextLink href={appPath('/')}>{state('home')}</TextLink><FileTitle>example.ts</FileTitle><CodeFrame><Paragraph>const example = true;</Paragraph></CodeFrame></PageSection>
      </KitSection>
    </KitPageLayout>
  </TooltipProvider>;
}

/**
 * One template's manifest, read the way the wiki reads it (madarch-64o5.3): the files the template writes into a
 * temporary product, the kinds the manifest declares, and every finding except the documents' own expectations and the
 * workflow check's (a product made a minute ago holds no documents, and workflows have a check of their own).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds } from '../src/product/manifest/kinds.js';
import { seedStarterSet, starterPageKindNames } from '../src/knowledge/seed.js';
import type { StarterTemplate } from '../src/knowledge/starter-templates.js';

export interface TemplateCheck {
  /** Whether the template's product reads a manifest with no finding and exactly the kinds it names. */
  readonly ok: boolean;
  /** Every problem, each naming the file and the line or the kind that is wrong. */
  readonly problems: readonly string[];
  /** The kinds the template's manifest shows, in code point order. */
  readonly kinds: readonly string[];
}

export function checkStarterTemplate(template: StarterTemplate): TemplateCheck {
  const folder = mkdtempSync(join(tmpdir(), `madarch-template-${template.id}-`));
  const problems: string[] = [];
  try {
    seedStarterSet(folder, template.id, [template]);
    const read = readKinds(folder);
    if (template.kinds === 'none') {
      if (read.present) problems.push(`${read.manifest.file}:1: the template ${template.id} declares no kinds and the product it made holds a manifest`);
      return { ok: problems.length === 0, problems, kinds: [] };
    }
    if (!read.present) {
      problems.push(`${join(folder, 'madarch', 'kinds.yaml')}:1: the template ${template.id} wrote no manifest`);
      return { ok: false, problems, kinds: [] };
    }
    const wanted = [...starterPageKindNames(template)].sort();
    const held = [...read.manifest.kinds.keys()].sort();
    if (JSON.stringify(held) !== JSON.stringify(wanted)) problems.push(`${read.manifest.file}:1: the template ${template.id} declares ${held.join(', ')}, and its kinds are ${wanted.join(', ')}`);
    for (const finding of read.manifest.findings) {
      if (finding.message.startsWith('"documents.expect" names the kind')) continue;
      if (read.manifest.workflows?.file === finding.file) continue;
      problems.push(`${finding.file}:${finding.line}: ${finding.message}`);
    }
    return { ok: problems.length === 0, problems, kinds: held };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

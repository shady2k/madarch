import {expect, test} from 'bun:test';
import {extractFiles} from '../src/extract/driver/files.js';
test('file-declares-document-sections: headings have precise UTF-8 spans and code fence headings are not declarations', () => {
 const text = '# Overview\nТекст\n## Details\nBody\n```md\n# Not a heading\n```\n# Next\n';
 const bytes = new TextEncoder().encode(text);
 const ex = extractFiles({paths: ['docs/guide.md'], read: () => bytes});
 const sections = ex.nodes.filter((node) => node.kind === 'code.document-section');
 expect(sections.map((node) => node.properties.heading)).toEqual(['Overview', 'Details', 'Next']);
 expect(sections.map((node) => node.span?.lineStart)).toEqual([1, 3, 8]);
 expect(new TextDecoder().decode(bytes.slice(sections[1]?.span?.byteStart, sections[1]?.span?.byteEnd))).toBe('## Details\nBody\n```md\n# Not a heading\n```\n');
 for (const section of sections) expect(ex.edges.some((edge) => edge.from === 'code.file:docs/guide.md' && edge.to === section.key)).toBe(true);
});

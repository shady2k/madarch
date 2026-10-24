
import { LikeC4 } from 'likec4';
const variants: [string, string][] = [
  ['relationship style', ['specification {','  element domain','  element service','}','','model {','  a = domain "A"','  b = service "B"','  a -> b "uses" {','    style {','      line dashed','    }','  }','}','','views {','  view index {','    title "T"','    include *','  }','}',''].join('\n')],
  ['nested include', ['specification {','  element domain','  element service','}','','model {','  a = domain "A" {','    b = service "B"','  }','}','','views {','  view index {','    title "T"','    include *','    include **','  }','}',''].join('\n')],
];
for (const [name, text] of variants) {
  try {
    const c4 = await LikeC4.fromSource(text, { logger: false, printErrors: false, throwIfInvalid: true });
    const views = await c4.diagrams();
    console.log('OK', name, views.length);
    await c4[Symbol.asyncDispose]?.();
  } catch (error) {
    console.log('FAIL', name, String(error instanceof Error ? error.message : error).split('\n').slice(0, 3).join(' | '));
  }
}

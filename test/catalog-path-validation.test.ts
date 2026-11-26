import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {fitsValueSchema,type ValueTypes} from '../src/graph/value-types.js';

const catalogue=parse(readFileSync(new URL('../catalog/catalog.yaml',import.meta.url),'utf8')) as {valueTypes?:ValueTypes;'value-types'?:ValueTypes};
const types=catalogue.valueTypes ?? catalogue['value-types']!;
test('catalogue paths accept POSIX whitespace without accepting NUL or non-path values',()=>{
 for(const path of ['with space.txt','with space and\nnewline.txt','with\rcarriage.txt','with\ttab.txt','docs/quoted"and\\backslash.md']) expect(fitsValueSchema(types.path!.schema,types,path)).toBe(true);
 for(const invalid of ['', 'nul\0path',42,null,{},['file']]) expect(fitsValueSchema(types.path!.schema,types,invalid)).toBe(false);
});

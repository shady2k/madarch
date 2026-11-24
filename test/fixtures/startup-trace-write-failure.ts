import { mock } from 'bun:test';
import * as fs from 'node:fs';
const original={...fs};
mock.module('node:fs',()=>({...original,writeSync:()=>{throw new Error('sentinel evidence sink failure');}}));
const {startupEntry,startupBegin}=await import('../../src/obs/log.js');
startupEntry('fixture');const end=startupBegin('fixture');console.log('UNCHANGED-PRODUCT-OUTPUT');end('ok');end('error');

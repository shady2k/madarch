import {expect,test} from 'bun:test';
import {graphContractVersion,EMPTY_CONTRACT} from '../src/graph/contract.js';
import {preparePublicationContract} from '../src/graph/write.js';

test('publication preparation is shared only by contract object identity',()=>{
 const declared=structuredClone(EMPTY_CONTRACT);
 const prepared=preparePublicationContract(declared);
 expect(preparePublicationContract(declared)).toBe(prepared);
 expect(preparePublicationContract(prepared.contract)).toBe(prepared);
 expect(preparePublicationContract(structuredClone(declared))).not.toBe(prepared);
 expect(Object.isFrozen(prepared.contract)).toBe(true);
 expect(prepared.contract.vertex.length).toBeGreaterThan(0);
 expect(prepared.version).toBe(graphContractVersion(prepared.contract));
});

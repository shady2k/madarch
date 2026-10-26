import { expect, test } from 'bun:test';
import { guidePacketPolicy, type GuidePreparedEvidence } from '../src/writer/guides/writer.js';
import { guideDigest } from '../src/writer/guides/digest.js';

test('configuration and host-known literal values are withheld with explicit policy provenance',()=>{
 const context={valid:'2026-01-01T00:00:00Z',known:'2026-01-02T00:00:00Z',state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]};
 const ground={repository:'sample',commit:'a'.repeat(40),path:'deployment.yaml',line:1,endLine:2};
 const text='value: private-config-value';
 const evidence:GuidePreparedEvidence={context,facts:[{id:'1',kind:'code.env-definition',properties:{value:'private-config-value'}},{id:'2',kind:'code.route',label:'status'}],spans:[{ground,text,digest:guideDigest({ground,text})}],gaps:[],policy:{version:'withhold-config-values@1',withheldValues:1,classifiedSources:['sample/deployment.yaml']},configValues:['private-config-value']};
 const result=guidePacketPolicy(evidence,['host-private-value']);
 expect(JSON.stringify(result.evidence)).not.toContain('private-config-value');expect(JSON.stringify(result.evidence)).not.toContain('host-private-value');expect(result.evidence.configValues).toBeUndefined();
 expect(result.evidence.spans).toEqual([]);expect(result.evidence.gaps.join(' ')).toContain('1 source spans');expect(result.evidence.policy.classifiedSources).toContain('sample/deployment.yaml');expect(result.evidence.facts).toContainEqual({id:'2',kind:'code.route',label:'status'});
});

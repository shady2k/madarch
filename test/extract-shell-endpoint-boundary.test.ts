import {expect,test} from 'bun:test';
import {endpointTarget} from '../src/extract/endpoint-target.js';
import {endpointRelations} from '../src/extract/driver/relationships.js';
import {literalShellArgv,shellCommandSyntax} from '../src/extract/shell-command.js';
import {validateShellCommandModels,shellCommandModels} from '../src/extract/library-models/shell-command-models.js';
import type {ExtractedNode,Extraction} from '../src/extract/records.js';
const url='http://localhost:8080/healthz';
const probe=(test: string|readonly string[]):ExtractedNode=>({key:'code.healthcheck:api',kind:'code.healthcheck',label:'Readiness',properties:{service:'api',test:[...(typeof test==='string'?['CMD-SHELL',test]:test)]},span:{path:'compose.yaml',byteStart:0,byteEnd:1,lineStart:1,lineEnd:1}});
test('Bash argv retains quoting, concatenation and escaped spaces without executing code',()=>{
 expect(literalShellArgv(`curl -X 'POST' ${url}`)).toEqual(['curl','-X','POST',url]);
 expect(literalShellArgv(`curl --request="PO"'ST' '${url}'`)).toEqual(['curl','--request=POST',url]);
 expect(literalShellArgv('curl -H X-Name:some\\ value '+url)).toEqual(['curl','-H','X-Name:some value',url]);
 expect(literalShellArgv('curl --data-raw={} '+url),shellCommandSyntax('curl --data-raw={} '+url)).toEqual(['curl','--data-raw={}',url]);
 expect(literalShellArgv('curl {one,two}')).toBeUndefined();
 expect(literalShellArgv('curl {1..3}')).toBeUndefined();
 for(const shell of [`curl -X "$METHOD" ${url}`,`curl $(echo ${url})`,`curl ${url} && echo ready`,`echo curl -X POST ${url}`,`curl ${url} | cat`,`curl '${url}`]) {
  expect(endpointTarget(probe(shell)),shell).toBeUndefined();
 }
});
test('curl methods and option arity come from closed command data for shell and exec forms',()=>{
 for(const [options,method] of [["-X 'POST'",'POST'],['--request="PATCH"','PATCH'],['-XDELETE','DELETE'],['-I','HEAD'],['--head','HEAD'],['-d "{}"','POST'],['--data-raw={} ','POST'],['--json "{}"','POST'],['-T payload','PUT'],['-fsS','GET'],['-G -d value','GET'],['-X POST -I','POST']] as const){
  expect(endpointTarget(probe(`curl ${options} ${url}`))?.method,options).toBe(method);
 }
 expect(endpointTarget(probe(['CMD','curl','-X','POST',url]))?.method).toBe('POST');
 expect(endpointTarget(probe(['CMD','curl','--url',url]))?.method).toBe('GET');
 for(const args of [['CMD','curl','--unknown',url],['CMD','curl','-X'],['CMD','curl',url,url],['CMD','curl','http://outside.example:8080/healthz'],['CMD-SHELL',`curl ${url}`,'ignored']]) expect(endpointTarget(probe(args))).toBeUndefined();
 expect(endpointTarget(probe(`curl -X post ${url}`))?.method).toBe('post');
});
test('quoted POST does not attach a healthcheck to GET and unresolved commands leave located gaps',()=>{
 const get:ExtractedNode={key:'code.route:get',kind:'code.route',label:'Read',properties:{service:'api',path:'/healthz',method:'GET',ports:['8080']}};
 const post:ExtractedNode={...get,key:'code.route:post',properties:{...get.properties,method:'POST'}};
 const extraction=(nodes:ExtractedNode[]):Extraction=>({producer:'code.extract.operations',nodes,edges:[],gaps:[]});
 expect(endpointRelations([extraction([probe(`curl -X 'POST' ${url}`),get])])[0]!.edges).toEqual([]);
 expect(endpointRelations([extraction([probe(`curl -X 'POST' ${url}`),get,post])])[0]!.edges[0]?.to).toBe(post.key);
 const unresolved=endpointRelations([extraction([probe(`curl -X "$METHOD" ${url}`),get])])[0]!;
 expect(unresolved.edges).toEqual([]);expect(unresolved.gaps).toEqual([{path:'compose.yaml',reason:'line 1: healthcheck command target is unresolved (code.healthcheck:api)'}]);
});
test('command model validator rejects arbitrary rules, duplicate aliases and invalid effects',()=>{
 expect(Object.isFrozen(shellCommandModels)).toBe(true);expect(Object.isFrozen(shellCommandModels[0]!.options)).toBe(true);
 const registry={schemaVersion:1,models:[shellCommandModels[0]]};
 expect(()=>validateShellCommandModels({...registry,extra:true})).toThrow('unknown field');
 expect(()=>validateShellCommandModels({schemaVersion:1,models:[{...shellCommandModels[0],options:[...shellCommandModels[0]!.options,shellCommandModels[0]!.options[0]]}]})).toThrow('duplicate');
 expect(()=>validateShellCommandModels({schemaVersion:1,models:[{...shellCommandModels[0],options:[{names:['-x'],argument:'none',effect:'execute'}]}]})).toThrow('effect');
});

test('the quoting kind decides what a word holds, and a quote of the other kind is text inside it',()=>{
 // A raw (single-quoted) word is literal as written: a backslash in it is that byte, so the word
 // needs no escape scanning and the grammar's token kind alone answers it.
 expect(literalShellArgv(`curl -H 'X-Name:some\\ value' ${url}`)).toEqual(['curl','-H','X-Name:some\\ value',url]);
 // An interpreted (double-quoted) word holds the content tokens the grammar gave it, and nothing else.
 expect(literalShellArgv(`curl --request="PATCH" ${url}`)).toEqual(['curl','--request=PATCH',url]);
 // Decoys: a double-quoted shape written inside a raw word, and a single-quoted shape written
 // inside an interpreted one, are plain text of that word, and neither makes the word unresolved.
 expect(literalShellArgv(`curl -H 'X-Name: "a b"' ${url}`)).toEqual(['curl','-H','X-Name: "a b"',url]);
 expect(literalShellArgv(`curl -H "X-Name: a'b" ${url}`)).toEqual(['curl','-H',"X-Name: a'b",url]);
 // Parts of another kind stay unresolved, as before: an expansion, a substitution in the command
 // itself, a substitution inside an interpreted word, and an unterminated word.
 expect(literalShellArgv(`curl -H "$HEADER" ${url}`)).toBeUndefined();
 expect(literalShellArgv(`curl $(echo ${url})`)).toBeUndefined();
 expect(literalShellArgv(`curl -H "$(cat token)" ${url}`)).toBeUndefined();
 expect(literalShellArgv(`curl '${url}`)).toBeUndefined();
});

test('Bash reads a backslash by its quoting, so a continued line joins the word and what it cannot decode stays a gap',()=>{
 // A backslash before a newline is a line continuation in an unquoted and in a double-quoted word:
 // it contributes nothing, so heal + a newline + thz is one word, healthz.
 expect(literalShellArgv('curl "http://localhost:8080/heal\\\nthz"')).toEqual(['curl','http://localhost:8080/healthz']);
 expect(endpointTarget(probe('curl "http://localhost:8080/heal\\\nthz"'))?.path).toBe('/healthz');
 // Inside double quotes only \$ \` \" \\ are escapes: an escaped quote stays inside the word, and
 // a backslash before an ordinary character keeps both of its characters.
 expect(literalShellArgv('curl -H "X-Name: \\"quoted value\\"" '+url)).toEqual(['curl','-H','X-Name: "quoted value"',url]);
 expect(literalShellArgv('curl -H "X-Name:a\\ b" '+url)).toEqual(['curl','-H','X-Name:a\\ b',url]);
 // Outside quotes a backslash before a character gives that character.
 expect(literalShellArgv('curl http://localhost:8080/heal\\thz')).toEqual(['curl','http://localhost:8080/healthz']);
 // Single quotes make nothing an escape: the backslash and the character after it stay as written.
 expect(literalShellArgv(`curl -H 'X-Name:a\\ b' ${url}`)).toEqual(['curl','-H','X-Name:a\\ b',url]);
 // A word that expands, that uses an ANSI-C quote, or that has no closing quote is a located gap.
 for(const shell of ['curl "http://localhost:8080/${PORT}/healthz"','curl "http://localhost:8080/healthz',"curl -H $'X-Name:a\\tb' "+url,'curl -H "X-Name:\\']){
  expect(literalShellArgv(shell),shell).toBeUndefined();
 }
});

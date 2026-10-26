/** Literal argv from the real Bash grammar; expansions and control flow stay unresolved. */
import bashGrammar from 'tree-sitter-wasms/out/tree-sitter-bash.wasm' with {type:'file'};
import runtime from 'web-tree-sitter/tree-sitter.wasm' with {type:'file'};
import {Language,Parser,type Node} from 'web-tree-sitter';
// Loading the grammar at module initialization keeps the existing synchronous extractor API.
// A runtime/grammar failure is an unresolved command, never a guessed GET request.
const language=await (async()=>{try{await Parser.init({locateFile:()=>runtime});return await Language.load(bashGrammar);}catch{return undefined;}})();
function word(node:Node|null):string|undefined {
 if(node===null)return undefined;
 if(node.hasError||node.isMissing)return undefined;
 if(node.type==='raw_string')return node.text.slice(1,-1);
 if(node.type==='string_content')return node.text.includes('\\')?undefined:node.text;
 if(node.type==='concatenation'){
  // Bash emits literal braces as separate word tokens. Decode only the empty
  // brace pair; a comma/range expansion or any other unquoted brace is unknown.
  const children=node.namedChildren;const parts:string[]=[];
  for(let at=0;at<children.length;at++){
   const child=children[at];if(child===null||child===undefined)return undefined;
   if(child.type==='word'&&child.text==='{'){
    const closing=children[++at];if(closing?.type!=='word'||closing.text!=='}'||child.endIndex!==closing.startIndex)return undefined;
    parts.push('{}');continue;
   }
   const value=word(child);if(value===undefined)return undefined;parts.push(value);
  }
  return parts.join('');
 }
 if(node.type==='string'||node.type==='command_name'){
  const parts=node.namedChildren.map(word);return parts.some(p=>p===undefined)?undefined:parts.join('');
 }
 if(node.type!=='word'||node.namedChildCount!==0)return undefined;
 let value='';const raw=node.text;
 for(let i=0;i<raw.length;i++){
  const c=raw[i]!;
  if(c==='\\'){if(i+1===raw.length)return undefined;const next=raw[++i]!;if(next!=='\n')value+=next;}
  else if(c==='{'){if(raw[i+1]!=='}')return undefined;value+='{}';i++;}
  else {if('*?[]~}'.includes(c))return undefined;value+=c;}
 }
 return value;
}
/** Parser-only diagnostic for an unresolved command; it never executes input. */
export function shellCommandSyntax(command:string):string|undefined {
 if(language===undefined)return undefined;
 const parser=new Parser();let tree:ReturnType<Parser['parse']>|undefined;
 try{parser.setLanguage(language);tree=parser.parse(command);return tree?.rootNode.toString();}finally{tree?.delete();parser.delete();}
}
export function literalShellArgv(command:string):readonly string[]|undefined {
 if(language===undefined)return undefined;
 const parser=new Parser();let tree:ReturnType<Parser['parse']>|undefined;
 try{
  parser.setLanguage(language);tree=parser.parse(command);if(tree===null||tree.rootNode.hasError)return undefined;
  const roots=tree.rootNode.namedChildren;if(roots.length!==1||roots[0]!.type!=='command')return undefined;
  const node=roots[0]!;const name=node.childForFieldName('name');if(name===null)return undefined;
  const args=node.childrenForFieldName('argument').filter((arg):arg is Node=>arg!==null);
  const allowed=new Set([name.id,...args.map(arg=>arg.id)]);
  if(node.namedChildren.some(child=>child===null||!allowed.has(child.id)))return undefined;
  if(tree.rootNode.children.some(child=>child!==null&&child.type==='&')||node.children.some(child=>child!==null&&child.type==='&'))return undefined;
  const argv=[name,...args].map(word);return argv.some(p=>p===undefined)?undefined:argv as string[];
 }catch{return undefined;}finally{tree?.delete();parser.delete();}
}

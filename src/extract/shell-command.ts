/** Literal argv from the real Bash grammar; expansions and control flow stay unresolved. */
import bashGrammar from 'tree-sitter-wasms/out/tree-sitter-bash.wasm' with {type:'file'};
import runtime from 'web-tree-sitter/tree-sitter.wasm' with {type:'file'};
import {Language,Parser,type Node} from 'web-tree-sitter';
// Loading the grammar at module initialization keeps the existing synchronous extractor API.
// A runtime/grammar failure is an unresolved command, never a guessed GET request.
const language=await (async()=>{try{await Parser.init({locateFile:()=>runtime});return await Language.load(bashGrammar);}catch{return undefined;}})();
type Quoting='unquoted'|'double'|'single';
// Inside double quotes a backslash escapes only these characters and a newline.
const escapedInDoubleQuotes='$`"\\';
/**
 * Decode the source text of one token by the quoting its node kind states. Bash decides an escape
 * by the quoting around it, not by where a token ends, so the text is decoded and not re-tokenised:
 * - in single quotes nothing is an escape, so a backslash is that byte and the one after it;
 * - in double quotes only \$ \` \" \\ are escapes, a backslash before a newline contributes nothing,
 *   and a backslash before any other character keeps both characters;
 * - unquoted, a backslash before a newline is a line continuation that contributes nothing, and a
 *   backslash before any other character contributes that character.
 * A construct the decoder cannot account for is undefined - an escape with no character after it,
 * an expansion or a substitution that reached it as text, an unquoted glob, a brace pair that is
 * not empty - so the command stays unresolved instead of becoming a guessed argv.
 */
function decode(raw:string,quoting:Quoting):string|undefined {
 let value='';
 for(let i=0;i<raw.length;i++){
  const c=raw[i]!;
  if(quoting==='single'){value+=c;continue;}
  if(c==='\\'){
   const next=raw[i+1];if(next===undefined)return undefined;
   i++;
   if(next==='\n')continue;
   value+=quoting==='double'&&!escapedInDoubleQuotes.includes(next)?'\\'+next:next;
   continue;
  }
  // An expansion or a substitution that reached the decoder as text was not decoded as one, and a
  // guessed argv is not accepted in its place.
  if(quoting==='double'){if(c==='$'||c==='`')return undefined;value+=c;continue;}
  // An unquoted word carries no expansion, no substitution and no quote of its own in a literal argv.
  if(c==='$'||c==='`'||c==='"'||c==="'")return undefined;
  // Only the empty brace pair is literal; any other unquoted brace is unknown.
  if(c==='{'){if(raw[i+1]!=='}')return undefined;value+='{}';i++;continue;}
  if('*?[]~}'.includes(c))return undefined;
  value+=c;
 }
 return value;
}
/** The text between the quotes of a raw (single-quoted) or interpreted (double-quoted) string. */
function interior(node:Node,quote:'"'|"'"):string|undefined {
 const text=node.text;
 if(text.length<2||text[0]!==quote||text[text.length-1]!==quote)return undefined;
 return text.slice(1,-1);
}
function word(node:Node|null):string|undefined {
 if(node===null)return undefined;
 if(node.hasError||node.isMissing)return undefined;
 // The quoting decides, and the grammar states it: a raw (single-quoted) string is literal as
 // written, and `string_content` is the content token of an interpreted (double-quoted) string.
 if(node.type==='raw_string'){const raw=interior(node,"'");return raw===undefined?undefined:decode(raw,'single');}
 if(node.type==='string_content')return decode(node.text,'double');
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
 if(node.type==='string'){
  // An interpreted string is literal only as the content the grammar gave it: an expansion, a
  // substitution or any part of another kind is not decoded here, and the word is unresolved.
  for(const part of node.namedChildren){if(part===null||part.type!=='string_content')return undefined;}
  const raw=interior(node,'"');return raw===undefined?undefined:decode(raw,'double');
 }
 if(node.type==='command_name'){
  const parts=node.namedChildren.map(word);return parts.some(p=>p===undefined)?undefined:parts.join('');
 }
 if(node.type!=='word'||node.namedChildCount!==0)return undefined;
 return decode(node.text,'unquoted');
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

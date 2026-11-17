/** Bounded committed records; each transaction owns only the records it touches. */
export class CommittedLookups<T> {
 private readonly records=new Map<string,{value:T;bytes:number}>();
 private bytes=0;
 constructor(private readonly entries:number,private readonly byteLimit:number){}
 get size():number{return this.records.size;}
 get(key:string):T|undefined{
  const held=this.records.get(key);if(held===undefined)return undefined;
  this.records.delete(key);this.records.set(key,held);return held.value;
 }
 set(key:string,value:T):void{
  const bytes=Buffer.byteLength(JSON.stringify(value),'utf8');
  if(bytes>this.byteLimit)return;
  const old=this.records.get(key);if(old!==undefined){this.bytes-=old.bytes;this.records.delete(key);}
  this.records.set(key,{value,bytes});this.bytes+=bytes;
  while(this.records.size>this.entries||this.bytes>this.byteLimit){const first=this.records.keys().next().value!;this.bytes-=this.records.get(first)!.bytes;this.records.delete(first);}
 }
}
export class TransactionLookups<T> {
 private readonly local=new Map<string,T>();
 constructor(private readonly shared:CommittedLookups<T>){}
 get(key:string):T|undefined{
  if(this.local.has(key))return this.local.get(key);
  const held=this.shared.get(key);if(held===undefined)return undefined;
  const value=structuredClone(held);this.local.set(key,value);return value;
 }
 has(key:string):boolean{return this.get(key)!==undefined;}
 set(key:string,value:T):void{if(this.local.get(key)!==value)this.local.set(key,structuredClone(value));}
 publish():void{for(const [key,value] of this.local)this.shared.set(key,value);}
}

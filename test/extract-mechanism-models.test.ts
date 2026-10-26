import {expect,test} from 'bun:test';
import {messagingTypes,validateMessagingModels,messagingModelDigest} from '../src/extract/library-models/messaging-models.js';
import {shellCommandModels,validateShellCommandModels,shellCommandModelDigest} from '../src/extract/library-models/shell-command-models.js';
test('new mechanism data is closed, frozen and included in canonical interpretation digests',()=>{
 for(const [models,validate,digest] of [[messagingTypes,validateMessagingModels,messagingModelDigest],[shellCommandModels,validateShellCommandModels,shellCommandModelDigest]] as const){
  expect(Object.isFrozen(models)).toBe(true);expect(digest).toHaveLength(64);
  expect(()=>validate({schemaVersion:1,models:[{...models[0],execute:'arbitrary'}]})).toThrow('unknown field');
  expect(()=>validate({schemaVersion:1,models:[models[0],models[0]]})).toThrow('duplicate');
  expect(()=>validate({schemaVersion:2,models})).toThrow();
 }
 expect(messagingTypes.every(model=>Object.isFrozen(model.exportedPath))).toBe(true);
});

test('external producer type identities keep exact type/pointer selectors, not names of local writers',()=>{
 expect(messagingTypes.map(model=>({ecosystem:model.ecosystem,exportedPath:[...model.exportedPath],pointer:model.pointer}))).toEqual([
  {ecosystem:'node',exportedPath:['Producer'],pointer:false},
  {ecosystem:'go',exportedPath:['Writer'],pointer:true},
 ]);
 expect(()=>validateMessagingModels({schemaVersion:1,models:[{...messagingTypes[0],pointer:'yes'}]})).toThrow('invalid type');
 expect(()=>validateMessagingModels({schemaVersion:1,models:[{...messagingTypes[0],exportedPath:[]}]})).toThrow('invalid type');
});

test('documented Go package names are closed identity data, never a module basename guess', () => {
  const go = messagingTypes.find(model => model.ecosystem === 'go');
  expect(go?.packageName).toBe('kafka');
  expect(() => validateMessagingModels({schemaVersion: 1, models: [{...go, packageName: 'not-a-Go-identifier'}]})).toThrow('declared package name');
  expect(() => validateMessagingModels({schemaVersion: 1, models: [{...messagingTypes[0], packageName: 'producer'}]})).toThrow('declared package name');
});

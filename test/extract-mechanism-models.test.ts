import {expect,test} from 'bun:test';
import libraryModelData from '../src/extract/library-models/models.json';
import {canonicalLibraryModels,libraryModelDigest,libraryRegistry,libraryRegistryDigest,validateLibraryRegistry} from '../src/extract/library-models/validate.js';
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


test('default metric namespaces select exported validated package data without changing runtime models or cache identity', () => {
  const sources = libraryModelData.models.filter(model => 'metricRegistry' in model && model.metricRegistry !== undefined && 'defaultNamespaceFrom' in model.metricRegistry);
  expect(sources).toHaveLength(13);
  const legacy = {...libraryModelData, models: libraryModelData.models.map(model => {
    if (!('metricRegistry' in model) || model.metricRegistry === undefined || !('defaultNamespaceFrom' in model.metricRegistry)) return model;
    const {defaultNamespaceFrom, ...metadata} = model.metricRegistry;
    const anchor = libraryRegistry.models.find(entry => entry.id === defaultNamespaceFrom)!;
    const runtime = libraryRegistry.models.find(entry => entry.id === model.id)!;
    expect(runtime.metricRegistry).toEqual({...metadata, defaultNamespace: anchor.package});
    expect(Object.isFrozen(runtime.metricRegistry)).toBe(true);
    expect(runtime.metricRegistry).not.toHaveProperty('defaultNamespaceFrom');
    expect(model.metricRegistry).not.toHaveProperty('defaultNamespace');
    return {...model, metricRegistry: {...metadata, defaultNamespace: anchor.package}};
  })};
  expect(validateLibraryRegistry(libraryModelData)).toEqual(validateLibraryRegistry(legacy));
  expect(canonicalLibraryModels(libraryModelData)).toBe(canonicalLibraryModels(legacy));
  expect(libraryRegistryDigest(libraryModelData)).toBe(libraryModelDigest);
  expect(libraryRegistryDigest(libraryRegistry)).toBe(libraryModelDigest);
  // Fingerprint of the full normalized registry before replacing the 13 literal selectors.
  expect(libraryModelDigest).toBe('6d72125b9ce1d5cd2a37549125a103601f8786344b15d28021c6bf031743d56d');

  const anchor = libraryModelData.models.find(model => model.id === 'prom-client.register')!;
  const counter = libraryModelData.models.find(model => model.id === 'prom-client.Counter')!;
  const changed = {schemaVersion: 1, models: [counter, {...anchor, package: 'example-metrics'}]};
  const changedRegistry = validateLibraryRegistry(changed);
  expect(changedRegistry.models.every(model => model.metricRegistry?.defaultNamespace === 'example-metrics')).toBe(true);
  expect(libraryRegistryDigest(changed)).not.toBe(libraryRegistryDigest({schemaVersion: 1, models: [counter, anchor]}));
  expect(validateLibraryRegistry({schemaVersion: 1, models: [{...anchor, metricRegistry: {defaultRegistry: true}}]}).models[0]?.metricRegistry)
    .toEqual({defaultRegistry: true});
});

test('metric namespace selectors reject dangling, cyclic, malformed and non-registry references', () => {
  const anchor = libraryModelData.models.find(model => model.id === 'prom-client.register')!;
  const counter = libraryModelData.models.find(model => model.id === 'prom-client.Counter')!;
  const goAnchor = libraryModelData.models.find(model => model.id === 'prometheus.MustRegister')!;
  const withCounterMetadata = (metricRegistry: unknown) => ({schemaVersion: 1, models: [anchor, {...counter, metricRegistry}]});
  expect(() => validateLibraryRegistry(withCounterMetadata({defaultMember: true, defaultNamespaceFrom: 'missing-registry'}))).toThrow('dangling registry reference');
  expect(() => validateLibraryRegistry(withCounterMetadata({defaultMember: true, defaultNamespaceFrom: counter.id}))).toThrow('not a default registry anchor');
  expect(() => validateLibraryRegistry(withCounterMetadata({defaultMember: true, defaultNamespaceFrom: {id: anchor.id}}))).toThrow('expected nonempty exact string');
  expect(() => validateLibraryRegistry(withCounterMetadata({defaultMember: true, defaultNamespaceFrom: anchor.id, defaultNamespace: anchor.package}))).toThrow('conflicting namespace selectors');
  expect(() => validateLibraryRegistry({schemaVersion: 1, models: [
    {...anchor, metricRegistry: {defaultRegistry: true, defaultNamespaceFrom: counter.id}}, counter,
  ]})).toThrow('cyclic registry reference');
  expect(() => validateLibraryRegistry({schemaVersion: 1, models: [
    goAnchor, {...counter, metricRegistry: {defaultMember: true, defaultNamespaceFrom: goAnchor.id}},
  ]})).toThrow('registry ecosystem disagrees');
  expect(() => validateLibraryRegistry({schemaVersion: 1, models: [
    {...anchor, metricRegistry: {defaultRegistry: true}}, counter,
  ]})).toThrow('direct default registry anchor');
  expect(() => validateLibraryRegistry(withCounterMetadata({defaultMember: true, defaultNamespaceFrom: anchor.id, execute: 'arbitrary'}))).toThrow('unknown field');
});

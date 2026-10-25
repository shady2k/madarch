import {expect,test} from 'bun:test';
import {fillWords} from './fill-words.js';
import en from '../locales/en.json';
import ru from '../locales/ru.json';
test('extractor rebuild progress has exact bilingual reason and keeps current phase',()=>{
 for(const language of [en,ru]) {
  const translate=(key:string)=>key.split('.').reduce<unknown>((value,part)=>(value as Record<string,unknown>)[part],language) as string;
  const message=fillWords({state:'running',rebuilt:'extractors-changed',phase:'code'},translate);
  expect(message).toContain(language.knowledge.fillRebuiltExtractors);expect(message).toContain(language.knowledge.fillPhaseCode);
 }
 expect(en.knowledge.fillRebuiltExtractors).toBe('Graph rebuilt: extractors changed');expect(ru.knowledge.fillRebuiltExtractors).toBe('Граф перестроен: экстракторы изменились');
});

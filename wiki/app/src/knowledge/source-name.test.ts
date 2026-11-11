import { expect, test } from 'bun:test';
import { sourceName } from './source-name.js';

test('standard names stay readable while unknown addresses stay exact', () => {
  expect(sourceName('https://c4model.com/abstractions')).toBe('C4 model');
  expect(sourceName('https://pubs.opengroup.org/architecture/archimate32-doc/')).toBe('ArchiMate');
  expect(sourceName('https://backstage.io/docs/features/software-catalog/system-model')).toBe('Backstage');
  expect(sourceName('https://spdx.github.io/spdx-spec/v3.0.1/model/Software/Classes/File/')).toBe('SPDX');
  expect(sourceName('https://www.rfc-editor.org/rfc/rfc9110.html')).toBe('RFC 9110');
  expect(sourceName('https://standards.ieee.org/ieee/29148/6937/')).toBe('ISO/IEC/IEEE 29148');
  expect(sourceName('https://www.omg.org/spec/BPMN/2.0.2/')).toBe('OMG BPMN');
  expect(sourceName('https://example.test/a-specific-standard#section')).toBe('https://example.test/a-specific-standard#section');
  expect(sourceName('not a URL')).toBe('not a URL');
});

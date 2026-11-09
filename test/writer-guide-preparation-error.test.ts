import { describe, expect, test } from 'bun:test';
import { formatGuidePreparationError, GuidePreparationError, GUIDE_PREPARATION_CODES, GUIDE_PREPARATION_STAGES, type GuidePreparationDetail } from '../src/writer/guides/preparation-error.js';

const fallback = { file: '/product/docs/guides/user.md', stage: 'preparation' as const };
const privateMarker = 'PRIVATE_fixture_value_8675309';

describe('safe guide preparation diagnostics', () => {
  test('reports finite actionable phase, reason and engine coordinate with an opaque graph fact', () => {
    const failure = new GuidePreparationError({ stage: 'graph-membership', code: 'bound', file: 'src/writer/guides/writer.ts', line: 93, fact: '1201' });
    const refusal = formatGuidePreparationError(failure, fallback);
    expect(refusal.line).toBe(1);
    expect(refusal.rule).toBe('guide-preparation');
    expect(refusal.message).toContain('/product/docs/guides/user.md:1: $.guide:');
    expect(refusal.message).toContain('stage=graph-membership; reason=bound');
    expect(refusal.message).toContain('engine=src/writer/guides/writer.ts:93; fact=1201');
    expect(refusal.message).toContain('read complete graph membership');
    expect(refusal.message).toContain('split the supported input rather than truncate it');
    expect(refusal.message).toContain('nothing was certified');
  });

  test('unknown exceptions never expose messages, causes, stacks, authored keys or conversions', () => {
    const poisoned = { get message(): never { throw new Error(privateMarker); }, get stack(): never { throw new Error(privateMarker); }, toString(): never { throw new Error(privateMarker); } };
    for (const failure of [new Error(privateMarker, { cause: privateMarker }), privateMarker, { [privateMarker]: privateMarker }, poisoned, null, undefined]) {
      const refusal = formatGuidePreparationError(failure, { ...fallback, stage: 'context-packets' });
      expect(refusal.message).toContain('stage=context-packets; reason=failed');
      expect(refusal.message).toContain('build the complete prepared-context packets');
      expect(refusal.message).not.toContain(privateMarker);
      expect(refusal.message).not.toContain('engine=');
      expect(refusal.message).not.toContain('fact=');
    }
  });

  test('malformed constructor fields cannot become diagnostic text', () => {
    const poisoned = { stage: privateMarker, code: privateMarker, file: `/source/${privateMarker}`, line: privateMarker, fact: `node:${privateMarker}` } as unknown as GuidePreparationDetail;
    for (const detail of [poisoned, null as unknown as GuidePreparationDetail, undefined as unknown as GuidePreparationDetail]) {
      const refusal = formatGuidePreparationError(new GuidePreparationError(detail), fallback);
      expect(refusal.message).toContain('stage=preparation; reason=failed');
      expect(refusal.message).not.toContain(privateMarker);
      expect(refusal.message).not.toContain('engine=');
      expect(refusal.message).not.toContain('fact=');
    }
  });

  test('constructor accessors and revoked proxies are never evaluated for safe fields', () => {
    let reads = 0;
    const accessor = Object.fromEntries(['stage', 'code', 'file', 'line', 'fact'].map((key) => [key, undefined]));
    for (const key of Object.keys(accessor)) Object.defineProperty(accessor, key, { get() { reads++; throw new Error(privateMarker); } });
    const proxy = Proxy.revocable({}, {}); proxy.revoke();
    for (const detail of [accessor, proxy.proxy]) {
      const refusal = formatGuidePreparationError(new GuidePreparationError(detail as unknown as GuidePreparationDetail), fallback);
      expect(refusal.message).toContain('stage=preparation; reason=failed');
      expect(refusal.message).not.toContain(privateMarker);
    }
    expect(reads).toBe(0);
  });

  test('invalid positions and non-graph identities are omitted rather than echoed', () => {
    for (const fact of ['', '0', '-1', '01', '1.2', '9223372036854775808', privateMarker, '12\n34']) {
      const refusal = formatGuidePreparationError(new GuidePreparationError({ stage: 'source-evidence', code: 'unavailable', file: 'src/writer/guides/writer.ts', line: Number.NaN, fact }), fallback);
      expect(refusal.message).toContain('engine=src/writer/guides/writer.ts:1');
      expect(refusal.message).not.toContain('fact=');
      expect(refusal.message).not.toContain(privateMarker);
    }
  });

  test('private branding rejects forged errors and ignores mutation after construction', () => {
    const failure = new GuidePreparationError({ stage: 'context', code: 'changed', file: 'src/writer/guides/writer.ts', line: 63, fact: '42' });
    Object.assign(failure, { message: privateMarker, stage: privateMarker, code: privateMarker, file: privateMarker, line: privateMarker, fact: privateMarker });
    expect(formatGuidePreparationError(failure, fallback).message).toContain('stage=context; reason=changed; engine=src/writer/guides/writer.ts:63; fact=42');
    expect(formatGuidePreparationError(failure, fallback).message).not.toContain(privateMarker);
    const forged = Object.assign(Object.create(GuidePreparationError.prototype), { stage: 'context', code: 'changed', file: privateMarker });
    expect(formatGuidePreparationError(forged, fallback).message).toContain('stage=preparation; reason=failed');
    expect(formatGuidePreparationError(forged, fallback).message).not.toContain(privateMarker);
  });

  test('every approved stage and reason produces actionable fixed text', () => {
    for (const stage of GUIDE_PREPARATION_STAGES) for (const code of GUIDE_PREPARATION_CODES) {
      const refusal = formatGuidePreparationError(new GuidePreparationError({ stage, code }), fallback);
      expect(refusal.message).toContain(`stage=${stage}; reason=${code}`);
      expect(refusal.message).toContain('could not ');
      expect(refusal.message).toContain('nothing was certified');
      expect(refusal.message).not.toContain('undefined');
    }
  });
});

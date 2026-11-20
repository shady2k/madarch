import { expect, test } from 'bun:test';
import { assertionSelectionSql } from '../src/graph/assertion-read.js';
import { createTestDatabaseOwner } from './test-database.js';

test('assertion selection diagnostics distinguish context, recorded time and validity without changing selection', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    await owner.transaction('snapshot', async tx => {
      const raw = `SELECT 0 AS request_index,1 AS subject_id,1 AS original_subject_id,'existence'::text AS id,
        '$exists'::text AS property,NULL::text AS language,'fixture'::text AS source,'assert'::text AS operation,
        1 AS context_id,'2025-01-01'::timestamptz AS valid_from,NULL::timestamptz AS valid_to,
        '2025-01-01'::timestamptz AS recorded_at,1::bigint AS recorded_sequence`;
      const select = async (validAt: string, recordedAt: string, contexts = [1]) => (await tx.query<{
        selected: boolean; diagnostic_context: boolean; diagnostic_recorded: boolean; diagnostic_valid: boolean; diagnostic_eligible: boolean; diagnostic_stream: boolean;
      }>(assertionSelectionSql(raw, { validAt, recordedAt, contexts, diagnostics: true }))).rows[0]!;
      const current = await select('2026-01-01', '2026-01-01');
      expect(current.selected).toBe(true);
      expect(current.diagnostic_eligible).toBe(true);
      expect(current.diagnostic_stream).toBe(true);
      const beforeValid = await select('2024-01-01', '2026-01-01');
      expect(beforeValid.selected).toBe(false);
      expect(beforeValid.diagnostic_valid).toBe(false);
      expect(beforeValid.diagnostic_recorded).toBe(true);
      expect(beforeValid.diagnostic_eligible).toBe(true);
      const beforeRecorded = await select('2026-01-01', '2024-01-01');
      expect(beforeRecorded.selected).toBe(false);
      expect(beforeRecorded.diagnostic_recorded).toBe(false);
      expect(beforeRecorded.diagnostic_valid).toBe(true);
      const wrongContext = await select('2026-01-01', '2026-01-01', [999999]);
      expect(wrongContext.selected).toBe(false);
      expect(wrongContext.diagnostic_context).toBe(false);
    });
  } finally { await owner.close(); }
});

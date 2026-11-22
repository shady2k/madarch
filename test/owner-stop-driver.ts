/** A connect-only API process for the stop/connection regression (madarch-64o5.74). */
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
const store = process.argv[2]!;
process.env.MADARCH_ROLE = 'api';
const owner = await createDatabaseOwner({ store, connectOnly: true });
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
  try {
    const result = await owner.run(async sql => await sql.query("SELECT pg_backend_pid() AS pid, current_setting('application_name') AS role"));
    return Response.json(result.rows[0]);
  } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
} });
console.log(server.url.toString());
process.once('SIGTERM', () => { void owner.close().then(() => { server.stop(true); process.exit(0); }); });

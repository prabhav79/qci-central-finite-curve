/**
 * CFC collaboration server — Hocuspocus over Postgres.
 *
 * Sprint 5 scaffold: this stands up a working Yjs sync backend. Wiring the
 * SuperDoc client-side provider is deferred to Sprint 5.5 because the shape
 * of SuperDoc's Yjs binding is version-fragile; wait until the SuperDoc doc
 * we ship on production is a version whose collab API is documented.
 *
 * Env:
 *   COLLAB_PORT     default 8200
 *   DATABASE_URL    Postgres connection (matches apps/api). If unset, uses
 *                   in-memory storage (Yjs docs vanish on restart).
 *   COLLAB_TOKEN    optional shared secret; when set, clients must connect
 *                   with `?token=…` matching this value.
 */
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { Logger } from "@hocuspocus/extension-logger";
import pg from "pg";

const PORT = Number(process.env.COLLAB_PORT || 8200);
const DB_URL = process.env.DATABASE_URL || "";
const TOKEN = process.env.COLLAB_TOKEN || "";

const extensions = [
  new Logger({
    onLoadDocument: false,
    onChange: false,
    onDisconnect: true,
    onUpgrade: true,
  }),
];

if (DB_URL) {
  const pool = new pg.Pool({ connectionString: DB_URL });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collab_documents (
      name TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  extensions.push(
    new Database({
      fetch: async ({ documentName }: { documentName: string }): Promise<Uint8Array | null> => {
        const r = await pool.query<{ data: Buffer }>(
          "SELECT data FROM collab_documents WHERE name = $1",
          [documentName],
        );
        return r.rows[0] ? new Uint8Array(r.rows[0].data) : null;
      },
      store: async ({
        documentName,
        state,
      }: {
        documentName: string;
        state: Uint8Array;
      }): Promise<void> => {
        await pool.query(
          `INSERT INTO collab_documents (name, data, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [documentName, Buffer.from(state)],
        );
      },
    }),
  );
  console.log(`[cfc-collab] persistence: postgres`);
} else {
  console.log(`[cfc-collab] persistence: in-memory (DATABASE_URL not set)`);
}

const server = new Server({
  name: "cfc-collab",
  port: PORT,
  address: "127.0.0.1",
  extensions,
  async onAuthenticate({ token }: { token: string }): Promise<void> {
    if (!TOKEN) return; // dev: no token required
    if (token !== TOKEN) throw new Error("Invalid COLLAB_TOKEN");
  },
});

await server.listen();
console.log(`[cfc-collab] listening on ws://127.0.0.1:${PORT}`);

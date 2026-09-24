import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSuperDocClient } from "@superdoc-dev/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const TEMPLATE = path.join(ROOT, "packages/doc-fixtures/templates/WO_EXTENSION.docx");
const OUT_DIR = path.join(ROOT, "storage/dev/doc-worker");

const app = express();
app.use(
  cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
  }),
);
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "cfc-doc-worker",
    templateExists: true, // checked async below on seed
  });
});

type SeedBody = {
  find?: string;
  replace?: string;
  titleHint?: string;
  tracked?: boolean;
  sourcePath?: string;
};

/**
 * Headless DOCX seed:
 * open template (or sourcePath), optional text replace, save to storage/dev/doc-worker.
 */
app.post("/internal/docx/seed", async (req, res) => {
  const body = (req.body || {}) as SeedBody;
  const findText = String(body.find ?? "Quality Council of India");
  const replaceText = String(
    body.replace ?? "Quality Council of India (CFC Generated Draft)",
  );
  const tracked = body.tracked !== false;
  const sourcePath = body.sourcePath
    ? path.isAbsolute(body.sourcePath)
      ? body.sourcePath
      : path.join(ROOT, body.sourcePath)
    : TEMPLATE;
  const outName = `seed-${Date.now()}.docx`;
  const outPath = path.join(OUT_DIR, outName);

  let client: ReturnType<typeof createSuperDocClient> | null = null;

  try {
    await fs.access(sourcePath);
    await fs.mkdir(OUT_DIR, { recursive: true });

    client = createSuperDocClient({
      user: { name: "CFC Doc Worker", email: "doc-worker@cfc.local" },
      defaultChangeMode: tracked ? "tracked" : "direct",
    });
    await client.connect();

    const doc = await client.open({ doc: sourcePath });

    let replaced = false;
    let matchCount = 0;
    try {
      const match = await (doc as any).query.match({
        select: { type: "text", pattern: findText },
        require: "first",
      });
      matchCount = Array.isArray(match?.items) ? match.items.length : 0;
      const target = match?.items?.[0]?.target;
      const ref = match?.items?.[0]?.handle?.ref;

      if (target && typeof (doc as any).replace === "function") {
        await (doc as any).replace({ target, text: replaceText });
        replaced = true;
      } else if (ref && (doc as any).mutations?.apply) {
        await (doc as any).mutations.apply({
          expectedRevision: match.evaluatedRevision,
          atomic: true,
          steps: [
            {
              id: "cfc-seed-replace",
              op: "text.rewrite",
              where: { by: "ref", ref },
              args: { replacement: { text: replaceText } },
            },
          ],
        });
        replaced = true;
      }
    } catch (matchErr) {
      // continue — still save a copy of the source
      console.warn("[doc-worker] match/replace skipped:", matchErr);
    }

    // Prefer explicit out path
    let saved = false;
    try {
      await doc.save({ out: outPath, force: true });
      saved = true;
    } catch {
      try {
        await doc.save({ out: outPath });
        saved = true;
      } catch {
        // fall through
      }
    }

    await doc.close().catch(() => undefined);
    await client.dispose().catch(() => undefined);
    client = null;

    if (!saved) {
      await fs.copyFile(sourcePath, outPath);
    }

    const stat = await fs.stat(outPath);
    res.json({
      ok: true,
      replaced,
      matchCount,
      findText,
      replaceText,
      tracked,
      bytes: stat.size,
      output: path.relative(ROOT, outPath).split(path.sep).join("/"),
      absolute: outPath,
      titleHint: body.titleHint || "Worker-seeded draft",
    });
  } catch (error) {
    if (client) {
      await client.dispose().catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.copyFile(sourcePath, outPath);
      const stat = await fs.stat(outPath);
      res.status(200).json({
        ok: true,
        replaced: false,
        fallback: true,
        warning: message,
        bytes: stat.size,
        output: path.relative(ROOT, outPath).split(path.sep).join("/"),
        absolute: outPath,
      });
    } catch (copyErr) {
      res.status(500).json({
        ok: false,
        error: message,
        copyError: copyErr instanceof Error ? copyErr.message : String(copyErr),
      });
    }
  }
});

// -------------------- generalized mutation endpoint --------------------

type MutateOp =
  | { kind: "replace_first"; find: string; replace: string }
  | { kind: "insert_end"; text: string }
  | { kind: "insert_after_match"; find: string; text: string };

type MutateBody = {
  sourcePath: string;
  outputPath?: string; // absolute or repo-relative; else temp under storage/dev/doc-worker
  tracked?: boolean;
  ops: MutateOp[];
  actorName?: string;
  actorEmail?: string;
};

function resolveRepoPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

app.post("/internal/docx/mutate", async (req, res) => {
  const body = (req.body || {}) as MutateBody;
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const tracked = body.tracked !== false;

  if (!body.sourcePath) {
    res.status(400).json({ ok: false, error: "sourcePath is required" });
    return;
  }
  if (!ops.length) {
    res.status(400).json({ ok: false, error: "ops must be a non-empty array" });
    return;
  }

  const sourcePath = resolveRepoPath(body.sourcePath);
  const outPath = body.outputPath
    ? resolveRepoPath(body.outputPath)
    : path.join(OUT_DIR, `mutate-${Date.now()}.docx`);

  let client: ReturnType<typeof createSuperDocClient> | null = null;
  const applied: Array<{ op: MutateOp; ok: boolean; note?: string }> = [];

  try {
    await fs.access(sourcePath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });

    client = createSuperDocClient({
      user: {
        name: body.actorName || "CFC Agent",
        email: body.actorEmail || "agent@cfc.local",
      },
      defaultChangeMode: tracked ? "tracked" : "direct",
    });
    await client.connect();
    const doc = await client.open({ doc: sourcePath });

    for (const op of ops) {
      let ok = false;
      let note = "";
      try {
        if (op.kind === "replace_first") {
          const match = await (doc as any).query.match({
            select: { type: "text", pattern: op.find },
            require: "first",
          });
          const target = match?.items?.[0]?.target;
          const ref = match?.items?.[0]?.handle?.ref;
          if (target && typeof (doc as any).replace === "function") {
            await (doc as any).replace({ target, text: op.replace });
            ok = true;
          } else if (ref && (doc as any).mutations?.apply) {
            await (doc as any).mutations.apply({
              expectedRevision: match.evaluatedRevision,
              atomic: true,
              steps: [
                {
                  id: `cfc-replace-${Date.now()}`,
                  op: "text.rewrite",
                  where: { by: "ref", ref },
                  args: { replacement: { text: op.replace } },
                },
              ],
            });
            ok = true;
          } else {
            note = "no match for pattern";
          }
        } else if (op.kind === "insert_end") {
          // The SDK's doc.insert() requires target.kind (not target.type).
          // We try a few shapes to be robust across minor SDK versions.
          const insertAttempts: Array<() => Promise<unknown>> = [
            () => (doc as any).insert({ target: { kind: "body-end" }, content: { text: op.text } }),
            () => (doc as any).insert({ target: { kind: "document-end" }, content: op.text }),
            () => (doc as any).insert({ target: { kind: "end" }, content: op.text }),
            () =>
              (doc as any).mutations.apply({
                atomic: true,
                steps: [
                  {
                    id: `cfc-insert-end-${Date.now()}`,
                    op: "text.insert",
                    where: { by: "position", position: "end" },
                    args: { content: { text: op.text } },
                  },
                ],
              }),
          ];
          let lastErr = "";
          for (const attempt of insertAttempts) {
            try {
              await attempt();
              ok = true;
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e.message : String(e);
            }
          }
          if (!ok) note = `all insert shapes failed: ${lastErr}`;
        } else if (op.kind === "insert_after_match") {
          const match = await (doc as any).query.match({
            select: { type: "text", pattern: op.find },
            require: "first",
          });
          const ref = match?.items?.[0]?.handle?.ref;
          const target = match?.items?.[0]?.target;
          const afterAttempts: Array<() => Promise<unknown>> = [
            () => target && (doc as any).insertAfter({ target, content: { text: op.text } }),
            () => target && (doc as any).insertAfter({ target, content: op.text }),
            () =>
              ref &&
              (doc as any).mutations.apply({
                expectedRevision: match.evaluatedRevision,
                atomic: true,
                steps: [
                  {
                    id: `cfc-insert-after-${Date.now()}`,
                    op: "text.insert",
                    where: { by: "ref", ref, side: "after" },
                    args: { content: { text: op.text } },
                  },
                ],
              }),
          ];
          let lastErr = "";
          for (const attempt of afterAttempts) {
            try {
              const r = await attempt();
              if (r === undefined && !target && !ref) continue;
              ok = true;
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e.message : String(e);
            }
          }
          if (!ok) note = `all insert_after shapes failed: ${lastErr || "no anchor"}`;
        } else {
          note = `unknown op kind: ${(op as any).kind}`;
        }
      } catch (opErr) {
        note = opErr instanceof Error ? opErr.message : String(opErr);
      }
      applied.push({ op, ok, note });
    }

    // Save; try force overwrite first
    let saved = false;
    try {
      await doc.save({ out: outPath, force: true });
      saved = true;
    } catch {
      try {
        await doc.save({ out: outPath });
        saved = true;
      } catch {
        // fall through
      }
    }

    await doc.close().catch(() => undefined);
    await client.dispose().catch(() => undefined);
    client = null;

    if (!saved) {
      // Preserve source so caller still has a usable file
      await fs.copyFile(sourcePath, outPath);
    }

    const stat = await fs.stat(outPath);
    res.json({
      ok: true,
      output: path.relative(ROOT, outPath).split(path.sep).join("/"),
      absolute: outPath,
      bytes: stat.size,
      tracked,
      applied,
      fallbackSaved: !saved,
    });
  } catch (error) {
    if (client) await client.dispose().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message, applied });
  }
});

// Back-compat alias
app.post("/internal/docx/apply-demo", async (req, res) => {
  try {
    const port = Number(process.env.DOC_WORKER_PORT || 8100);
    const r = await fetch(`http://127.0.0.1:${port}/internal/docx/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});


app.get("/internal/docx/file", async (req, res) => {
  const rel = String(req.query.path || "");
  if (!rel || rel.includes("..")) {
    res.status(400).json({ error: "invalid path" });
    return;
  }
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(path.join(ROOT, "storage"))) {
    res.status(403).json({ error: "path outside storage" });
    return;
  }
  try {
    await fs.access(abs);
    res.download(abs);
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

const port = Number(process.env.DOC_WORKER_PORT || 8100);
app.listen(port, () => {
  console.log(`[cfc-doc-worker] listening on http://127.0.0.1:${port}`);
});
/**
 * DOCX round-trip fixture suite.
 *
 * For each fixture: create a fresh draft, load it in the Studio, wait for
 * onReady, click Save, then assert the fetched bytes back from the API are
 * a valid OOXML container. Regressions in SuperDoc (a rendering error, a
 * crash on complex tables, a broken export) trip immediately.
 *
 * Fixtures live under packages/doc-fixtures/samples/. Add more real WOs
 * from `Work Orders/shortlisted_project/` there as coverage expands.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const API_BASE = process.env.CFC_API_BASE || "http://127.0.0.1:8000";
const FIXTURES_DIR = path.join(REPO_ROOT, "packages/doc-fixtures/samples");

function readFixtures(): { name: string; path: string; bytes: number }[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$"))
    .map((f) => {
      const abs = path.join(FIXTURES_DIR, f);
      return { name: f, path: abs, bytes: fs.statSync(abs).size };
    });
}

async function createDraftWithFixture(fixturePath: string): Promise<string> {
  // Create a draft, then overwrite v1 with the fixture bytes via PUT.
  const create = await fetch(`${API_BASE}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: JSON.stringify({ title: `RT: ${path.basename(fixturePath)}` }),
  });
  if (!create.ok) throw new Error(`create ${create.status} ${await create.text()}`);
  const { draft } = (await create.json()) as { draft: { id: string } };
  const buf = fs.readFileSync(fixturePath);
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(buf)], path.basename(fixturePath), {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );
  const put = await fetch(`${API_BASE}/drafts/${draft.id}/file`, {
    method: "PUT",
    headers: { "X-CFC-User": "6281", "X-CFC-Save-Trigger": "fixture_load" },
    body: form,
  });
  if (!put.ok) throw new Error(`put ${put.status} ${await put.text()}`);
  return draft.id;
}

const fixtures = readFixtures();

test.describe("SuperDoc DOCX round-trip", () => {
  test.beforeAll(async () => {
    const health = await fetch(`${API_BASE}/health`);
    if (!health.ok) throw new Error(`CFC API not responding at ${API_BASE}`);
    expect(fixtures.length, "add at least one .docx to packages/doc-fixtures/samples/").toBeGreaterThan(0);
  });

  for (const fx of fixtures) {
    test(`round-trip ${fx.name}`, async ({ page }) => {
      const draftId = await createDraftWithFixture(fx.path);

      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
      });

      await page.goto(`/studio?draft=${draftId}&persona=arpit`);
      // Editor reports readiness by flipping the "Editor" workflow row to "ready".
      await expect(page.getByText(/Editor\s+ready/i)).toBeVisible({ timeout: 60_000 });

      // Trigger export → PUT → assert the bytes coming back are a valid docx zip.
      const beforeVersions = await (
        await fetch(`${API_BASE}/drafts/${draftId}/versions`, {
          headers: { "X-CFC-User": "6281" },
        })
      ).json();
      const v0 = beforeVersions.current_version as number;

      await page.getByRole("button", { name: /^Save DOCX$/ }).click();
      await expect(page.getByText(/Saved v\d+/)).toBeVisible({ timeout: 30_000 });

      const afterVersions = await (
        await fetch(`${API_BASE}/drafts/${draftId}/versions`, {
          headers: { "X-CFC-User": "6281" },
        })
      ).json();
      expect(afterVersions.current_version).toBeGreaterThan(v0);

      const file = await fetch(`${API_BASE}/drafts/${draftId}/file`);
      expect(file.ok).toBe(true);
      const bytes = new Uint8Array(await file.arrayBuffer());
      // DOCX is a ZIP: first four bytes are `PK\x03\x04`
      expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      expect(bytes.length).toBeGreaterThan(1_000);

      // A sane DOCX always contains word/document.xml (or word/document2.xml for split docs)
      const zipText = new TextDecoder("latin1").decode(bytes);
      expect(zipText.includes("word/document")).toBe(true);

      // No console errors during load/save (SuperDoc/RangeError sink)
      const criticalErrors = errors.filter((e) => !/browser worker/i.test(e));
      expect(criticalErrors, criticalErrors.join("\n")).toEqual([]);
    });
  }
});

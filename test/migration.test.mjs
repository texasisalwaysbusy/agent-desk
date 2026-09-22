import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const migrationScript = fileURLToPath(new URL("../scripts/migrate-local-data.mjs", import.meta.url));
const migrationSource = await readFile(migrationScript, "utf8");

test("Windows migration ACLs protect the root and reset descendants to inherited access", () => {
  assert.match(migrationSource, /await readdir\(directory, \{ withFileTypes: true \}\)/);
  assert.match(migrationSource, /"\/reset",\s*"\/t",\s*"\/c"/);
  assert.doesNotMatch(
    migrationSource,
    /"\*S-1-5-32-544:\(OI\)\(CI\)F",\s*"\/t"/,
  );
});

test("local migration backs up a read-only source, archives Workflow data, and verifies the copy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-migration-"));
  const sourcePath = path.join(directory, "old.sqlite");
  const destinationRoot = path.join(directory, "new-root");
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO workflows VALUES ('workflow-1', 'Legacy workflow');
  `);
  source.close();

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      migrationScript,
      "--source", sourcePath,
      "--destination-root", destinationRoot,
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: "test",
        CODEX_TASKBOARD_MIGRATION_TEST_SKIP_ACL: "1",
      },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.manifest.sourcePreserved, true);
    assert.equal(result.manifest.integrityCheck, "ok");
    assert.equal(result.manifest.foreignKeyViolations, 0);
    const archive = JSON.parse(await readFile(path.join(result.stagingRoot, "legacy-workflows.json"), "utf8"));
    assert.deepEqual(archive.tables.workflows, [{ id: "workflow-1", name: "Legacy workflow" }]);
    const original = new DatabaseSync(sourcePath, { readOnly: true });
    assert.equal(original.prepare("SELECT COUNT(*) AS count FROM workflows").get().count, 1);
    original.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

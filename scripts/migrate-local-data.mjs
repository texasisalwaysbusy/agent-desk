#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { backup, DatabaseSync } from "node:sqlite";

import { TaskboardDatabase } from "../server/database.mjs";

const execFileAsync = promisify(execFile);
const COUNT_TABLES = [
  "projects",
  "tasks",
  "comments",
  "task_activities",
  "task_relations",
  "attachments",
];

function parseArgs(argv) {
  const options = { source: null, destinationRoot: null, attachments: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source") options.source = path.resolve(argv[++index]);
    else if (value === "--destination-root") options.destinationRoot = path.resolve(argv[++index]);
    else if (value === "--attachments") options.attachments = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.source || !options.destinationRoot) {
    throw new Error("Usage: migrate-local-data.mjs --source <sqlite> --destination-root <directory> [--attachments <directory>]");
  }
  return options;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(database, table) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function countSnapshot(database) {
  const counts = {};
  for (const table of COUNT_TABLES) {
    counts[table] = tableExists(database, table)
      ? database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count
      : 0;
  }
  counts.statuses = tableExists(database, "tasks")
    ? database.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status").all()
    : [];
  return counts;
}

function workflowArchive(database) {
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) LIKE '%workflow%' ORDER BY name",
  ).all().map((row) => row.name);
  return Object.fromEntries(tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all(),
  ]));
}

async function applyWindowsAcl(directory) {
  if (process.platform !== "win32") return;
  if (
    process.env.NODE_ENV === "test"
    && process.env.CODEX_TASKBOARD_MIGRATION_TEST_SKIP_ACL === "1"
  ) return;
  const username = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");
  if (!username) throw new Error("Cannot resolve the current Windows user for data ACLs");
  await execFileAsync("icacls.exe", [
    directory,
    "/inheritance:r",
    "/grant:r",
    `${username}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
    "/c",
  ], { windowsHide: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    await execFileAsync("icacls.exe", [
      path.join(directory, entry.name),
      "/reset",
      "/t",
      "/c",
    ], { windowsHide: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!(await stat(options.source)).isFile()) throw new Error("Source database is not a file");

  const migrationId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const stagingRoot = path.join(options.destinationRoot, "migration-staging", migrationId);
  const dataRoot = path.join(stagingRoot, "data");
  const destinationDatabase = path.join(dataRoot, "taskboard.sqlite");
  await mkdir(dataRoot, { recursive: true });

  const source = new DatabaseSync(options.source, { readOnly: true });
  const before = countSnapshot(source);
  const workflows = workflowArchive(source);
  await writeFile(
    path.join(stagingRoot, "legacy-workflows.json"),
    `${JSON.stringify({ exportedAt: new Date().toISOString(), tables: workflows }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await backup(source, destinationDatabase);
  source.close();

  if (options.attachments) {
    try {
      if ((await stat(options.attachments)).isDirectory()) {
        await cp(options.attachments, path.join(dataRoot, "attachments"), {
          recursive: true,
          errorOnExist: true,
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const migrated = new TaskboardDatabase(destinationDatabase);
  migrated.close();
  const verified = new DatabaseSync(destinationDatabase, { readOnly: true });
  const integrity = verified.prepare("PRAGMA integrity_check").all();
  const foreignKeys = verified.prepare("PRAGMA foreign_key_check").all();
  const after = countSnapshot(verified);
  verified.close();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error(`Migrated database failed integrity_check: ${JSON.stringify(integrity)}`);
  }
  if (foreignKeys.length > 0) {
    throw new Error(`Migrated database failed foreign_key_check: ${JSON.stringify(foreignKeys)}`);
  }

  const manifest = {
    schemaVersion: 1,
    migrationId,
    createdAt: new Date().toISOString(),
    sourceDatabase: options.source,
    sourceDatabaseBytes: (await stat(options.source)).size,
    destinationDatabase,
    before,
    after,
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    workflowArchive: "legacy-workflows.json",
    sourcePreserved: true,
  };
  await writeFile(
    path.join(stagingRoot, "migration-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await applyWindowsAcl(stagingRoot);
  console.log(JSON.stringify({ stagingRoot, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

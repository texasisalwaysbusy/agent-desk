import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApprovalArchive } from "../scripts/approval-archive.mjs";
import { validApprovalRequest } from "../scripts/handoff-approval.mjs";

const id = "11111111-1111-1111-1111-111111111111";
test("archive classifies terminal records and preserves authority, supports durable reversible old pending cleanup", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "agent-desk-archive-"));
  try {
    const file = path.join(folder, "approval-archive.json");
    const store = createApprovalArchive(file);
    const items = [{ id, state: "pending", approved_at: null }, { id: "22222222-2222-2222-2222-222222222222", state: "invalid" }];
    const initial = await store.decorate(items);
    assert.equal(initial[1].archived, true);
    assert.equal(initial[0].archived, false);
    assert.equal((await store.set(id, true, items)).executed, false);
    assert.equal((await createApprovalArchive(file).decorate(items))[0].archived, true);
    assert.equal(items[0].state, "pending");
    assert.equal(items[0].approved_at, null);
    await Promise.all([store.set(id, false, items), store.set(items[1].id, false, items)]);
    assert.ok((await store.decorate(items)).every((item) => item.archived === false));
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort(), ["entries", "version"]);
    await assert.rejects(store.set("33333333-3333-3333-3333-333333333333", true, items), /当前可核验列表/);
    await assert.rejects(store.set(id, true, [{ id, state: "running" }]), /执行中/);
    await writeFile(file, '{"version":1,"entries":[{"id":"bad","archived":true}]}');
    await assert.rejects(store.decorate(items), /无法核验/);
    await assert.rejects(store.set(id, true, items), /无法核验/);
    assert.match(await readFile(file, "utf8"), /"bad"/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test("archive request cannot carry decisions, commands or file paths", () => {
  assert.equal(validApprovalRequest({ operation: "archive", messageId: id }), true);
  assert.equal(validApprovalRequest({ operation: "unarchive", messageId: id }), true);
  for (const key of ["decision", "revision", "project", "argv", "path", "approved"]) {
    assert.equal(validApprovalRequest({ operation: "archive", messageId: id, [key]: "fixture" }), false);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { resolveDataRoot } from "../shared/product-identity.mjs";
test("new and legacy data stores are selected without silently splitting or merging data", () => {
  const base = path.resolve("fixture");
  const current = path.join(base, "AgentDesk"); const legacy = path.join(base, "DashiTaskboard");
  assert.equal(resolveDataRoot(base, () => false), current);
  assert.equal(resolveDataRoot(base, p => p === current), current);
  assert.equal(resolveDataRoot(base, p => p === legacy), legacy);
  assert.throws(() => resolveDataRoot(base, () => true), /Both/);
  assert.throws(() => resolveDataRoot("relative"), /absolute/);
});
test("release metadata consistently identifies Agent Desk", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "agent-desk"); assert.equal(lock.name, pkg.name); assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(config.productName, "Agent Desk"); assert.equal(config.identifier, "app.agentdesk.desktop"); assert.equal(config.version, pkg.version);
});

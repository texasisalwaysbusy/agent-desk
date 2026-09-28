#!/usr/bin/env node
import path from "node:path";
import { main } from "./taskctl.mjs";
import { resolveDataRoot } from "../shared/product-identity.mjs";
import { runStartupDiagnostics } from "../shared/startup-diagnostics.mjs";
try {
  if (process.argv[2] === "diagnostics") {
    process.exitCode = await runStartupDiagnostics(process.argv.slice(3));
  } else {
    if (!process.env.CODEX_TASKBOARD_RUNTIME_FILE && process.platform === "win32") {
      const root = resolveDataRoot(process.env.LOCALAPPDATA);
      process.env.CODEX_TASKBOARD_RUNTIME_FILE = path.join(root, "runtime", "launcher-runtime.json");
    }
    process.exitCode = await main();
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}

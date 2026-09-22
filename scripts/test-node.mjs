import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? collect(path) : entry.isFile() && entry.name.endsWith(".test.mjs") ? [path] : [];
  });
}
// Keep generated source snapshots outside test discovery.
const tests = collect(resolve(root, "test")).sort();
if (!tests.length) throw new Error("No Node tests found in test/");
const result = spawnSync(process.execPath, ["--test", ...tests], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

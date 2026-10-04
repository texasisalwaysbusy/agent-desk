import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { activateRegisteredCodex } from "../scripts/codex-cdp-loopback-candidate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

// Compilation prepares inert OS-boundary fixtures; stripped child environments
// belong to the activation matrix, not to the compiler setup.
function compileFixture(powershell, source, assembly, outputType) {
  const environment = Object.fromEntries([
    "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "SystemDrive", "PATH",
    "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "CommonProgramFiles",
  ].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const start = Date.now();
  const command = `[Console]::Error.WriteLine('fixture-compile-entered'); Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(assembly)}${outputType ? ` -OutputType ${outputType}` : ""}; [Console]::Error.WriteLine('fixture-compile-finished')`;
  try {
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: environment, encoding: "utf8", windowsHide: true, timeout: 60000,
    });
    console.error(JSON.stringify({ kind: "fixture-compile", outputType: outputType ?? "Library", elapsedMs: Date.now() - start, outcome: "passed" }));
  } catch (error) {
    console.error(JSON.stringify({ kind: "fixture-compile", outputType: outputType ?? "Library", elapsedMs: Date.now() - start, outcome: "failed",
      entered: String(error.stderr ?? "").includes("fixture-compile-entered"), finished: String(error.stderr ?? "").includes("fixture-compile-finished"), code: error.code ?? null }));
    throw error;
  }
}

test("complete registered helper and Node boundary reject unsafe states across child environments", {
  skip: process.platform !== "win32", timeout: 1500000,
}, async () => {
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const folder = await mkdtemp(path.join(os.tmpdir(), "agent-desk-activation-fixture-"));
  const assembly = path.join(folder, "activation-fixture.dll");
  const helper = path.join(root, "scripts/codex-registered-activation.ps1");
  const helpers = [{ version: "source", file: helper }];
  if (process.env.AGENT_DESK_MATRIX_COMPARE_INSTALLED === "1") {
    const installed = path.join(process.env.LOCALAPPDATA, "Agent Desk/app/scripts/codex-registered-activation.ps1");
    const manifest = JSON.parse(await readFile(path.join(root,
      "dist/maintenance/20260929-approval-console-fix/expected-installed-files.json"), "utf8"));
    assert.equal(createHash("sha256").update(await readFile(installed)).digest("hex"),
      manifest.find((entry) => entry.path === "app/scripts/codex-registered-activation.ps1").sha256);
    helpers.push({ version: "installed-v2", file: installed });
  }
  const fixture = path.join(root, "test/helpers/registered-activation-fixture.ps1");
  const previous = process.env.AGENT_DESK_WINDOWS_TRANSPORT;
  const minimal = Object.fromEntries(["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const profiles = {
    "receiver-minimal": { ...minimal },
    "probe-explicit": { ...minimal, SystemDrive: path.parse(process.env.SystemRoot).root.replace(/\\$/, ""),
      LOCALAPPDATA: process.env.LOCALAPPDATA, PATHEXT: ".EXE" },
  };
  const cases = [
    ["ready", null, null, 1], ["listener-delayed", null, null, 1],
    ["process-path-delayed", null, null, 1],
    ["process-path-delayed-mismatch", "path-mismatch", "process-validation", 1],
    ["codex-running", "codex-running", "selection", 0],
    ["package-missing", "package-not-found", "package", 0],
    ["identity-mismatch", "package-identity-mismatch", "package", 0],
    ["signature-invalid", "signature-invalid", "package", 0],
    ["port-taken", "port-taken", "activation-preparation", 0],
    ["activation-error", "helper-error", "activation-call", 1],
    ["process-not-visible", "process-not-visible", "process-validation", 1],
    ["process-path-unavailable", "process-path-unavailable", "process-validation", 1],
    ["process-read-error", "helper-error", "process-validation", 1],
    ["path-mismatch", "path-mismatch", "process-validation", 1],
    ["listener-owner", "listener-misowned", "listener-validation", 1],
    ["listener-address", "listener-misowned", "listener-validation", 1],
    ["listener-multiple", "listener-misowned", "listener-validation", 1],
    ["listener-timeout", "listener-timeout", "listener-validation", 1],
  ];
  const rows = [];
  try {
    // Compile an inert activation type once with a complete non-secret OS env.
    // Per-case helpers only load it; the original COM source is never compiled.
    const stub = `public static class AgentDeskRegisteredActivation {
      public static bool Fail;
      public static uint Activate(string id, string args) {
        System.Console.Error.WriteLine("fixture-activation");
        if (Fail) throw new System.Exception("private-fixture-exception");
        return 4242;
      }
    }`;
    compileFixture(powershell, stub, assembly);
    process.env.AGENT_DESK_WINDOWS_TRANSPORT = "registered-loopback";
    for (const { version, file: helperFile } of helpers) {
    for (const [profile, environment] of Object.entries(profiles)) {
      for (const [scenario, reason, stage, activationCount] of cases) {
        let capture;
        let outcome;
        try {
          const value = activateRegisteredCodex({ port: 23456, appPath: "fixture", mode: "launcher" }, {
            run(program, args, options) {
              assert.equal(program, "powershell.exe");
              assert.equal(options.windowsHide, true);
              assert.equal(options.timeout, 35000);
              assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
              assert.equal(args.at(-1), "launcher");
              const caseStart = Date.now();
              capture = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", fixture,
                "-HelperFile", helperFile, "-StubAssembly", assembly, "-Scenario", scenario], {
                ...options, env: { ...environment, AGENT_DESK_WINDOWS_TRANSPORT: "registered-loopback" },
              });
              console.error(JSON.stringify({ kind: "fixture-case", profile, scenario, elapsedMs: Date.now() - caseStart, status: capture.status, code: capture.error?.code ?? null }));
              if (capture.error) throw capture.error;
              if (capture.status !== 0) throw Object.assign(new Error("child failed"), { stdout: capture.stdout });
              return capture.stdout;
            },
          });
          assert.equal(reason, null, `${profile}/${scenario} unexpectedly succeeded`);
          assert.equal(value.pid, 4242);
          assert.equal(value.listenerOwned, true);
          outcome = "verified";
        } catch (error) {
          if (!reason) throw error;
          assert.equal(error.activationReason, version === "source" ? reason
            : scenario === "codex-running" ? reason : undefined, `${version}/${profile}/${scenario}: ${capture?.stdout}`);
          assert.equal(error.activationStage, version === "source" ? stage : undefined);
          assert.doesNotMatch(error.message, /private-fixture/);
          outcome = error.activationReason ?? error.diagnosticReason;
        }
        assert.equal(capture.status, reason ? 1 : 0);
        assert.equal((capture.stderr.match(/^fixture-activation$/gm) ?? []).length, activationCount);
        if (scenario === "process-not-visible") {
          assert.equal((capture.stderr.match(/^fixture-process-read$/gm) ?? []).length, 1,
            "An exited/missing activated PID is not retried");
        }
        if (scenario === "process-path-unavailable") {
          assert.equal((capture.stderr.match(/^fixture-process-read$/gm) ?? []).length, version === "source" ? 80 : 1,
            "Missing path stays fail-closed within the original 20 second budget");
        }
        if (version === "source" && scenario.startsWith("process-path-delayed")) {
          assert.equal((capture.stderr.match(/^fixture-process-read$/gm) ?? []).length, 4,
            "Only the activated PID is inspected before connecting; activation remains once");
        }
        rows.push({ version, profile, scenario, status: capture.status, outcome,
          stage: version === "source" ? stage : null, activationCount });
      }
    }
    }
    if (process.env.AGENT_DESK_MATRIX_REPORT) {
      const reportPath = path.resolve(process.env.AGENT_DESK_MATRIX_REPORT);
      assert.ok(reportPath.startsWith(path.join(root, "dist", "maintenance") + path.sep));
      await writeFile(reportPath, JSON.stringify({ kind: "OS-boundary-fixtures", realActivation: false,
        nodeVersion: process.version, helpers: await Promise.all(helpers.map(async ({ version, file }) => ({ version,
          sha256: createHash("sha256").update(await readFile(file)).digest("hex") }))), rows }, null, 2) + "\n");
    }
    assert.equal(rows.length, cases.length * Object.keys(profiles).length * helpers.length);
  } finally {
    if (previous === undefined) delete process.env.AGENT_DESK_WINDOWS_TRANSPORT;
    else process.env.AGENT_DESK_WINDOWS_TRANSPORT = previous;
    assert.ok(folder.startsWith(path.join(os.tmpdir(), "agent-desk-activation-fixture-")));
    await rm(folder, { recursive: true, force: true });
  }
});

test("GUI and console parent subsystems preserve the hidden Node-to-PowerShell activation boundary", {
  skip: process.platform !== "win32", timeout: 240000,
}, async () => {
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const folder = await mkdtemp(path.join(os.tmpdir(), "agent-desk-parent-fixture-"));
  const assembly = path.join(folder, "activation-fixture.dll");
  const child = path.join(folder, "child.mjs");
  const output = path.join(folder, "result.json");
  const helper = path.join(root, "scripts/codex-registered-activation.ps1");
  const fixture = path.join(root, "test/helpers/registered-activation-fixture.ps1");
  const moduleUrl = new URL("../scripts/codex-cdp-loopback-candidate.mjs", import.meta.url).href;
  const base = Object.fromEntries(["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const complete = { ...base, SystemDrive: path.parse(process.env.SystemRoot).root.replace(/\\$/, ""),
    LOCALAPPDATA: process.env.LOCALAPPDATA, PATHEXT: ".EXE", AGENT_DESK_WINDOWS_TRANSPORT: "registered-loopback" };
  const rows = [];
  try {
    compileFixture(powershell,
      'public static class AgentDeskRegisteredActivation { public static bool Fail; public static uint Activate(string id,string args) { return 4242; } }', assembly);
    await writeFile(child, `import { execFileSync } from 'node:child_process';
      import { activateRegisteredCodex } from ${JSON.stringify(moduleUrl)};
      const [ps, fixture, helper, stub, scenario] = process.argv.slice(2);
      try {
        activateRegisteredCodex({port:23456, appPath:'fixture',mode:'launcher'}, {
          run(_p,_args,options) { return execFileSync(ps,['-NoProfile','-NonInteractive','-File',fixture,
            '-HelperFile',helper,'-StubAssembly',stub,'-Scenario',scenario],options); }
        });
        console.log(JSON.stringify({verified:true}));
      } catch(error) {
        console.log(JSON.stringify({verified:false,reason:error.activationReason,stage:error.activationStage}));
        process.exitCode=1;
      }\n`);
    const driver = `using System; using System.Diagnostics; using System.IO;
      public static class FixtureParent {
        public static int Main(string[] a) {
          var s = new ProcessStartInfo(a[0]);
          for(int i=1;i<7;i++) s.Arguments += "\\\"" + a[i] + "\\\" ";
          s.UseShellExecute=false; s.CreateNoWindow=true;
          s.RedirectStandardInput=true; s.RedirectStandardOutput=true; s.RedirectStandardError=true;
          using(var p=Process.Start(s)) {
            p.StandardInput.Close();
            var o=p.StandardOutput.ReadToEndAsync(); var e=p.StandardError.ReadToEndAsync();
            if(!p.WaitForExit(40000)) { p.Kill(); return 8; }
            File.WriteAllText(a[7],o.Result); var ignored=e.Result; return p.ExitCode;
          }
        }
      }`;
    for (const type of ["ConsoleApplication", "WindowsApplication"]) {
      const parent = path.join(folder, `${type}.exe`);
      compileFixture(powershell, driver, parent, type);
      const pe = await readFile(parent);
      assert.equal(pe.readUInt16LE(pe.readUInt32LE(0x3c) + 24 + 68), type === "WindowsApplication" ? 2 : 3);
      for (const [profile, env] of Object.entries({ "receiver-minimal": { ...base,
        AGENT_DESK_WINDOWS_TRANSPORT: "registered-loopback" }, "probe-explicit": complete })) {
        for (const scenario of ["ready", "process-not-visible"]) {
          const result = spawnSync(parent, [process.execPath, child, powershell, fixture, helper, assembly, scenario, output], {
            env, windowsHide: true, timeout: 45000, encoding: "utf8",
          });
          if (result.error) throw result.error;
          console.error(JSON.stringify({ kind: "fixture-parent", type, profile, scenario, status: result.status }));
          assert.equal(result.status, scenario === "ready" ? 0 : 1, `${type}/${profile}/${scenario}`);
          const evidence = JSON.parse(await readFile(output, "utf8"));
          assert.deepEqual(evidence, scenario === "ready" ? { verified: true }
            : { verified: false, reason: "process-not-visible", stage: "process-validation" });
          rows.push({ parentSubsystem: type === "WindowsApplication" ? 2 : 3, profile, scenario, ...evidence });
        }
      }
    }
    if (process.env.AGENT_DESK_MATRIX_REPORT) {
      const reportPath = path.resolve(process.env.AGENT_DESK_MATRIX_REPORT);
      assert.ok(reportPath.startsWith(path.join(root, "dist", "maintenance") + path.sep));
      await writeFile(reportPath.replace(/\.json$/, "-parent.json"), JSON.stringify({
        kind: "native-parent-OS-boundary-fixtures", realActivation: false, nodeVersion: process.version, rows,
      }, null, 2) + "\n");
    }
    assert.equal(rows.length, 8);
  } finally {
    assert.ok(folder.startsWith(path.join(os.tmpdir(), "agent-desk-parent-fixture-")));
    await rm(folder, { recursive: true, force: true });
  }
});

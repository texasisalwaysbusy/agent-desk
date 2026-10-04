import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(new URL("../../scripts/codex-injector.mjs", import.meta.url), "utf8");
export function loader({ html="<html></html>", compatible=true, setTimer=setTimeout, clearTimer=clearTimeout, restoreOnly=false }={}) {
  const functions = source.slice(source.indexOf("async function loadTaskboardFrameViaCdp"), source.indexOf("async function openWithDefaultApplication"));
  return vm.runInNewContext(`${functions}\n${restoreOnly ? "restoreOwnedFrameCsp" : "loadTaskboardFrameViaCdp"}`, {
    verifiedTaskboardDocument: async()=>html,
    probeRendererContract: async()=>({compatible,capabilities:{fullPanel:compatible}}),
    findFrameByName: (tree,name)=>tree.childFrames?.find(f=>f.frame.name===name)?.frame,
    Date, Promise, setTimeout:setTimer, clearTimeout:clearTimer,
    logLaunchDiagnostic() {},
  });
}

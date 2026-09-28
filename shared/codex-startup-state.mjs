export function managedCodexExitAction(exitCode, injectedOnce) {
  return exitCode === 0 && injectedOnce === true ? "idle" : "stop";
}

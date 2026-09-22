import { existsSync } from "node:fs";
import path from "node:path";
export const PRODUCT_NAME = "Agent Desk";
export const DATA_DIRECTORY_NAME = "AgentDesk";
export const LEGACY_DATA_DIRECTORY_NAME = "DashiTaskboard";
// Select one existing store without copying, merging, or silently creating a second one.
export function resolveDataRoot(localAppData, exists = existsSync) {
  if (!localAppData || !path.isAbsolute(localAppData)) throw new Error("LOCALAPPDATA must be absolute");
  const current = path.join(localAppData, DATA_DIRECTORY_NAME);
  const legacy = path.join(localAppData, LEGACY_DATA_DIRECTORY_NAME);
  if (exists(current) && exists(legacy)) throw new Error("Both AgentDesk and DashiTaskboard data roots exist; resolve the conflict before starting Agent Desk");
  return exists(legacy) ? legacy : current;
}

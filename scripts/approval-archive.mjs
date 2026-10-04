import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

const automaticStates = new Set(["revoked", "outdated", "invalid", "expired", "cancelled"]);
const messageId = /^[a-f0-9-]{36}$/i;

// Application-owned presentation metadata only. Never alter the mailbox,
// receiver ledger, approval status or execution history.
export function createApprovalArchive(file) {
  let pending = Promise.resolve();
  async function read() {
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    if (Buffer.byteLength(text) > 1_000_000) throw new Error("审批归档记录过大，请保留文件并检查");
    const data = JSON.parse(text);
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 5000
      || data.entries.some((entry) => !entry || !messageId.test(entry.id) || typeof entry.archived !== "boolean"
        || Object.keys(entry).some((key) => !["id", "archived"].includes(key)))) {
      throw new Error("审批归档记录无法核验，请保留文件并检查");
    }
    return Object.fromEntries(data.entries.map((entry) => [entry.id, entry.archived]));
  }
  return {
    async decorate(items) {
      await pending;
      const overrides = await read();
      return items.map((item) => ({ ...item,
        archived: overrides[item.id] ?? automaticStates.has(item.state),
        archiveAutomatic: overrides[item.id] === undefined && automaticStates.has(item.state),
      }));
    },
    async set(id, archived, items) {
      // Binding comes from a fresh allowed-project list, never from a supplied path.
      if (!messageId.test(id) || !items.some((item) => item.id === id)) throw new Error("归档申请不在当前可核验列表中，请刷新");
      if (items.find((item) => item.id === id).state === "running") throw new Error("执行中的申请不能归档，请等待执行结束");
      const operation = pending.then(async () => {
        const entries = await read();
        entries[id] = archived;
        if (Object.keys(entries).length > 5000) throw new Error("审批归档记录已满，请保留历史并检查");
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1,
            entries: Object.entries(entries).map(([id, archived]) => ({ id, archived })) }) + "\n", { flag: "wx", mode: 0o600 });
          await rename(temp, file);
        } finally { await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
        return { archived, executed: false, note: "仅整理显示；原申请、审批与执行记录保留，不改变授权或终止进程。" };
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}

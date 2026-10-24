import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { dirname } from "node:path";
import type { WithingsTokenSet } from "../types.js";
import { decodeTokens, encodeTokens, tokenKey } from "./token-codec.js";

const LOCK_RETRY_MS = 250;
const LOCK_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokenStore {
  private readonly key?: Buffer;
  constructor(private readonly tokenPath: string, encryptionKey?: string) { this.key = tokenKey(encryptionKey); }

  private get lockPath(): string {
    return `${this.tokenPath}.lock.sqlite`;
  }

  async read(): Promise<WithingsTokenSet | null> {
    try {
      const text = await fs.readFile(this.tokenPath, "utf8");
      return decodeTokens(text, this.key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(tokens: WithingsTokenSet): Promise<void> {
    await fs.mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.tokenPath}.tmp-${randomUUID()}`;
    try {
      const handle = await fs.open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(encodeTokens(tokens, this.key));
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(tmp, this.tokenPath);
      // Persist the rename before a new access token can invalidate its predecessor.
      if (process.platform !== "win32") {
        const directory = await fs.open(dirname(this.tokenPath), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await fs.unlink(tmp).catch(() => undefined); }
  }

  async clear(): Promise<void> {
    await fs.unlink(this.tokenPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    // Reuse our existing SQLite dependency for an OS-held cross-process lock.
    // A killed process releases it immediately; never unlink a live lock inode.
    // No credentials or measurements are stored in this empty lock database.
    const lock = new Database(this.lockPath, { timeout: 0 });
    const start = Date.now();
    try {
      await fs.chmod(this.lockPath, 0o600);
      while (true) {
        try { lock.exec("BEGIN IMMEDIATE"); break; } catch (error) {
          if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
          if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("Timed out waiting for Withings token lock.");
          await sleep(LOCK_RETRY_MS);
        }
      }
      return await fn();
    } finally {
      lock.close();
    }
  }
}

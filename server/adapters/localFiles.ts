// Self-host FileStorage adapter — local disk under the mounted data volume (the counterpart of the
// cloud GCS adapter). Keys are code-generated; a traversal guard keeps them under root regardless.
import { promises as fs } from "node:fs";
import { join, dirname, normalize } from "node:path";
import type { FileStorage, StoredFile } from "../../core/src/ports";

export class LocalFileStorage implements FileStorage {
  constructor(
    private readonly root: string,
    private readonly baseUrl = "/files",
  ) {}

  private safe(key: string): string {
    const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
    return join(this.root, clean);
  }

  async put(key: string, data: Uint8Array, _contentType?: string): Promise<StoredFile> {
    const f = this.safe(key);
    await fs.mkdir(dirname(f), { recursive: true });
    await fs.writeFile(f, data);
    return { key, url: `${this.baseUrl}/${key}` };
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.safe(key)));
    } catch {
      return null;
    }
  }
  async url(key: string): Promise<string> {
    return `${this.baseUrl}/${key}`;
  }
  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.safe(key));
    } catch {
      /* already gone */
    }
  }
}

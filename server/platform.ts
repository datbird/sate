// Assemble the self-host Platform bundle from the local adapters — the counterpart of the cloud
// cloudPlatform(). Everything is local to the mounted data dir; `identity` is omitted (no GCP), so
// core's entitlements/AI degrade to open/local exactly as the ports intend.
import type { Platform } from "../core/src/ports";
import { SqliteData } from "./adapters/sqlite";
import { ProxyHeaderAuth } from "./adapters/proxyAuth";
import { LocalFileStorage } from "./adapters/localFiles";
import { LocalSecrets } from "./adapters/localSecrets";
import { decryptKey } from "../core/src/api/admin";

export function selfHostPlatform(): Platform {
  const dataDir = (process.env.SATE_DATA || "./pb_data").replace(/\/+$/, "");
  const data = new SqliteData(`${dataDir}/sate.db`);

  // Tier-2 secret lookup: a "<provider>-api-key" (e.g. google-api-key) resolves to the provider's
  // key entered in the admin console — stored AES-256-GCM-encrypted in the `providers` collection and
  // decrypted here with APP_ENCRYPTION_KEY. This is the loop that makes admin-entered keys power AI.
  // (Keys migrated from PocketBase used a different cipher → decryptKey throws → returns undefined,
  // so they must be re-entered once via the admin.)
  const dbLookup = async (name: string): Promise<string | undefined> => {
    const m = name.match(/^(.+)-api-key$/);
    const encKey = process.env.APP_ENCRYPTION_KEY || "";
    if (!m || !encKey) return undefined;
    try {
      const { items } = await data
        .instance()
        .list<{ name?: string; api_key_enc?: string }>("providers", { where: [{ field: "name", op: "==", value: m[1] }], limit: 1 });
      const enc = items[0]?.api_key_enc;
      return enc ? decryptKey(enc, encKey) : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    data,
    auth: new ProxyHeaderAuth(process.env.DEV_EMAIL),
    files: new LocalFileStorage(`${dataDir}/files`),
    secrets: new LocalSecrets(dbLookup),
  };
}

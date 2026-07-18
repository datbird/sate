// Assemble the self-host Platform bundle from the local adapters — the counterpart of the cloud
// cloudPlatform(). Everything is local to the mounted data dir; `identity` is omitted (no GCP), so
// core's entitlements/AI degrade to open/local exactly as the ports intend.
import type { Platform } from "../core/src/ports";
import { SqliteData } from "./adapters/sqlite";
import { ProxyHeaderAuth } from "./adapters/proxyAuth";
import { LocalFileStorage } from "./adapters/localFiles";
import { LocalSecrets } from "./adapters/localSecrets";

export function selfHostPlatform(): Platform {
  const dataDir = (process.env.SATE_DATA || "./pb_data").replace(/\/+$/, "");
  return {
    data: new SqliteData(`${dataDir}/sate.db`),
    auth: new ProxyHeaderAuth(process.env.DEV_EMAIL),
    files: new LocalFileStorage(`${dataDir}/files`),
    secrets: new LocalSecrets(),
  };
}

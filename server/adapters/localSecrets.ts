// Self-host Secrets adapter. Tier 1: env-var resolution (mirrors the cloud SecretManager env override
// — secret `google-api-key` → env `GOOGLE_API_KEY`). Tier 2 (optional): decrypt a provider key stored
// in the instance `providers`/`settings` store with APP_ENCRYPTION_KEY, preserving the admin "paste
// your key" UX. Tier 2 is wired when the admin console is ported (Phase 1); env alone boots the stack.
import type { DataStore, Secrets } from "../../core/src/ports";

export interface DbSecretLookup {
  (name: string): Promise<string | undefined>;
}

export class LocalSecrets implements Secrets {
  private readonly cache = new Map<string, string | undefined>();
  constructor(private readonly dbLookup?: DbSecretLookup) {}

  private envName(name: string): string {
    return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  }

  async get(name: string): Promise<string | undefined> {
    if (this.cache.has(name)) return this.cache.get(name);
    let val: string | undefined = process.env[this.envName(name)];
    if (!val && this.dbLookup) {
      try {
        val = await this.dbLookup(name);
      } catch {
        val = undefined;
      }
    }
    this.cache.set(name, val);
    return val;
  }
}

// Placeholder for the Phase-1 DB-backed lookup so the type is available to platform wiring.
export type { DataStore };

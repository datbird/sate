// Self-host Auth adapter. Identity on self-host comes from a trusted proxy email header (Cloudflare
// Access) consumed by core's auth middleware trust-header path — so verify() is only reached if a raw
// bearer token is sent (no proxy header). We support a single local-dev token (DEV_EMAIL + token "dev")
// for testing without a proxy; anything else is rejected. On self-host the uid IS the email (there is
// no Firebase uid), matching the PB→core migration which keys user data on the email.
import type { Auth, AuthUser } from "../../core/src/ports";

export class ProxyHeaderAuth implements Auth {
  constructor(private readonly devEmail?: string) {}
  async verify(token: string): Promise<AuthUser> {
    if (this.devEmail && token === "dev") {
      const email = this.devEmail.toLowerCase();
      return { uid: email, email, emailVerified: true };
    }
    throw new Error("self-host uses proxy-header auth; no bearer token accepted");
  }
}

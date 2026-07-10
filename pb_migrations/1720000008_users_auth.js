/// <reference path="../pb_data/types.d.ts" />

// Sate — `users` auth collection, used only when AUTH_MODE=apple.
//
// In the default AUTH_MODE=proxy the app has no login of its own: an auth proxy
// (Cloudflare Access, oauth2-proxy, …) authenticates the request and injects the user's email
// as a header. This collection is what makes the app able to authenticate people itself.
//
// Password auth is left off deliberately — Sate has no password UI, no reset flow, and no
// rate limiting for one. OAuth2 (Sign in with Apple) is the only intended way in. The provider's
// credentials are configured after the fact, in the PocketBase dashboard or by an operator,
// so no secrets live in this migration.
//
// `profiles` remains keyed by email and stays the source of truth for goals/role, so the two
// auth modes converge on the same profile for the same person.

migrate(
  (app) => {
    let col;
    try {
      col = app.findCollectionByNameOrId("users");
    } catch (_) {
      col = new Collection({ type: "auth", name: "users" });
    }

    col.passwordAuth = { enabled: false, identityFields: ["email"] };
    col.oauth2 = { enabled: false, providers: [] };

    // In apple mode PocketBase is internet-facing, so the generic record API matters.
    // Nothing lists users (a filter rule would still answer anonymous callers with 200 + an
    // empty page); only the owner may view or update their own record.
    col.listRule = null;
    col.viewRule = "id = @request.auth.id";
    col.createRule = null; // records are created by the OAuth2 flow, never by clients
    col.updateRule = "id = @request.auth.id";
    col.deleteRule = null;

    if (!col.fields.getByName("name")) col.fields.add(new Field({ type: "text", name: "name" }));

    app.save(col);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("users"));
    } catch (_) {}
  }
);

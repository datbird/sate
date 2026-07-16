// Sate core — PORTS (interfaces). Core depends only on these; each platform provides concrete
// adapters. Core NEVER imports Firestore / Firebase / SQLite / PocketBase directly — that is the
// single rule that lets `core/` be byte-identical across the cloud and self-host repos.

export type Unsubscribe = () => void;

// ---- DataStore ----------------------------------------------------------
// Collections are user-scoped by the ADAPTER (cloud → users/{uid}/{collection}; self-host →
// filtered by a user column). The API obtains a store already bound to the authenticated user
// via DataStoreProvider.forUser(uid), so handlers can't accidentally cross users.

export type FilterOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "array-contains";
export interface Filter {
  field: string;
  op: FilterOp;
  value: unknown;
}
export interface Order {
  field: string;
  dir?: "asc" | "desc";
}
export interface QuerySpec {
  where?: Filter[];
  orderBy?: Order[];
  limit?: number;
  cursor?: string; // opaque pagination cursor returned from a prior list()
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export type BatchOp =
  | { kind: "create"; collection: string; id?: string; data: Record<string, unknown> }
  | { kind: "update"; collection: string; id: string; patch: Record<string, unknown> }
  | { kind: "delete"; collection: string; id: string };

export interface DataStore {
  get<T>(collection: string, id: string): Promise<T | null>;
  list<T>(collection: string, spec?: QuerySpec): Promise<Page<T>>;
  /** Realtime subscription. Cloud → Firestore onSnapshot; self-host → poll or SSE. */
  watch<T>(collection: string, spec: QuerySpec, onChange: (items: T[]) => void): Unsubscribe;
  create<T extends { id?: string }>(collection: string, data: Omit<T, "id">, id?: string): Promise<T>;
  update<T>(collection: string, id: string, patch: Partial<T>): Promise<T>;
  delete(collection: string, id: string): Promise<void>;
  /** Atomic multi-write — used by migrations and multi-document operations. */
  batch(ops: BatchOp[]): Promise<void>;
}

export interface DataStoreProvider {
  /** Per-user data (cloud → users/{uid}/{collection}; self-host → filtered by user column). */
  forUser(uid: string): DataStore;
  /** Instance-scoped, non-user collections: AI usage/limits/prices, provider config, KB, settings. */
  instance(): DataStore;
}

// ---- Auth ---------------------------------------------------------------
export interface AuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}
export interface Auth {
  /** Verify a client bearer token → identity. Throws on invalid/expired token. */
  verify(token: string): Promise<AuthUser>;
}

// ---- FileStorage --------------------------------------------------------
export interface StoredFile {
  key: string;
  url: string;
}
export interface FileStorage {
  put(key: string, data: Uint8Array, contentType?: string): Promise<StoredFile>;
  get(key: string): Promise<Uint8Array | null>;
  url(key: string): Promise<string>; // public or signed URL
  delete(key: string): Promise<void>;
}

// ---- Secrets ------------------------------------------------------------
export interface Secrets {
  /** Resolve a named secret — provider API keys, the encryption key, etc. */
  get(name: string): Promise<string | undefined>;
}

// ---- Identity (optional) ------------------------------------------------
// Mints a GCP identity token for calling an IAM-protected upstream (e.g. a private entitlements
// plane on Cloud Run). Provided only by hosts that run on GCP; undefined on self-host, where the
// upstream is either public or absent.
export interface Identity {
  /** An OIDC identity token whose audience is `audience` (the target service URL), or undefined. */
  token(audience: string): Promise<string | undefined>;
}

// ---- The adapter bundle a host wires up at startup ----------------------
export interface Platform {
  data: DataStoreProvider;
  auth: Auth;
  files: FileStorage;
  secrets: Secrets;
  identity?: Identity;
}

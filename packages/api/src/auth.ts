import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ROLES = ["viewer", "investigator", "admin"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { viewer: 0, investigator: 1, admin: 2 };

/** viewer reads incidents; investigator also runs investigations; admin also reads the audit log. */
export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export interface Principal {
  id: string;
  role: Role;
}

const KeysSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "use letters, digits, - and _"),
      /** SHA-256 of the key, as 64 hex characters. The key itself is never stored. */
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      role: z.enum(ROLES),
    }),
  )
  .min(1, "at least one API key is required");

export function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateKey(): { token: string; sha256: string } {
  const token = `kt_${randomBytes(32).toString("base64url")}`;
  return { token, sha256: hashKey(token) };
}

export class ApiKeyAuthenticator {
  private readonly keys: Array<{ id: string; role: Role; digest: Buffer }>;

  constructor(config: unknown) {
    const parsed = KeysSchema.parse(config);
    const ids = new Set(parsed.map((k) => k.id));
    if (ids.size !== parsed.length) throw new Error("API key ids must be unique.");
    this.keys = parsed.map((k) => ({ id: k.id, role: k.role, digest: Buffer.from(k.sha256, "hex") }));
  }

  /** Reads KUBE_TRIAGE_API_KEYS, a JSON array of {id, sha256, role}. */
  static fromEnv(env: NodeJS.ProcessEnv): ApiKeyAuthenticator {
    const raw = env["KUBE_TRIAGE_API_KEYS"];
    if (!raw) throw new Error("KUBE_TRIAGE_API_KEYS is not set; refusing to start without API keys.");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error("KUBE_TRIAGE_API_KEYS is not valid JSON.");
    }
    return new ApiKeyAuthenticator(json);
  }

  /** Accepts "Bearer <key>". Compares in constant time and checks every key, to avoid timing leaks. */
  authenticate(authorization: string | undefined): Principal | undefined {
    const match = /^Bearer (\S+)$/.exec(authorization ?? "");
    if (!match) return undefined;
    const presented = createHash("sha256")
      .update(match[1] as string)
      .digest();
    let found: Principal | undefined;
    for (const key of this.keys) {
      if (timingSafeEqual(presented, key.digest)) found = { id: key.id, role: key.role };
    }
    return found;
  }
}

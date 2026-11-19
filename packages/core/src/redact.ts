const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key)/i;

const VALUE_PATTERNS: RegExp[] = [
  // Authorization header values
  /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // JSON Web Tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // AWS access key ids
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // user:password@host in URLs
  /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g,
];

// key=value, key: value, "key":"value" where the key looks sensitive
const KEY_VALUE =
  /(["']?[\w.-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key)[\w.-]*["']?\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi;

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out.replace(KEY_VALUE, (_m, key: string) => `${key}${REDACTED}`);
}

/** Deeply redacts strings; values under sensitive-looking keys are dropped entirely. */
export function redactValue<T>(value: T): T {
  return redactInner(value) as T;
}

function redactInner(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactInner);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactInner(v);
    }
    return out;
  }
  return value;
}

#!/usr/bin/env node
import { generateKey, ROLES, type Role } from "./auth.js";

const [id = "", role = ""] = process.argv.slice(2);
if (!id || !(ROLES as readonly string[]).includes(role)) {
  process.stderr.write(`Usage: kube-triage-keygen <id> <${ROLES.join("|")}>\n`);
  process.exit(2);
}
const { token, sha256 } = generateKey();
process.stdout.write(
  [
    `API key (shown once, store it somewhere safe): ${token}`,
    ``,
    `Add this entry to KUBE_TRIAGE_API_KEYS (a JSON array):`,
    JSON.stringify({ id, sha256, role: role as Role }),
    ``,
  ].join("\n"),
);

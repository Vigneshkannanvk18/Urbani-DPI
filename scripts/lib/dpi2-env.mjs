// Shared helpers for the DPI 2 deployment config (deploy/dpi2.env[.example]). No dependencies.
//
// File format: shell-compatible KEY=VALUE lines (values with spaces/JSON are quoted), "#" comment lines,
// and structure directives that are plain comments to bash:
//   #@section deploy | app | secrets      which group the following variables belong to
//   # REQUIRED ... / # OPTIONAL ...       first words of the comment right above a variable
import fs from 'node:fs';

export function parseEnvText(text) {
  const entries = [];
  let section = 'deploy';
  let requirement = null;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const sec = /^#@section\s+(\w+)/.exec(line);
    if (sec) { section = sec[1]; return; }
    if (line.startsWith('#')) {
      const r = /^#\s*(REQUIRED|OPTIONAL)\b/.exec(line);
      if (r) requirement = r[1];
      return;
    }
    if (!line) { requirement = null; return; }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error(`env line ${i + 1}: not KEY=VALUE`);
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    entries.push({ key: m[1], value, section, line: i + 1, requirement });
    requirement = null;
  });
  return entries;
}

export function parseEnvFile(file) {
  return parseEnvText(fs.readFileSync(file, 'utf8'));
}

export const toMap = (entries) => Object.fromEntries(entries.map((e) => [e.key, e.value]));

/** App variables that carry secret material. They may only be referenced by Secrets Manager name. */
export const SECRET_APP_VARS = [
  'JWT_SECRET', 'MFA_ENCRYPTION_KEY', 'SEED_ADMIN_PASSWORD', 'URBANI_API_KEY',
  'OIDC_CLIENT_SECRET', 'SLACK_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL', 'SMTP_PASSWORD',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
];
/** Secrets that are always injected; the rest are injected only when listed in ENABLED_OPTIONAL_SECRETS. */
export const ALWAYS_SECRETS = ['JWT_SECRET', 'MFA_ENCRYPTION_KEY', 'SEED_ADMIN_PASSWORD', 'URBANI_API_KEY'];
export const OPTIONAL_SECRETS = ['SLACK_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL', 'OIDC_CLIENT_SECRET', 'SMTP_PASSWORD'];

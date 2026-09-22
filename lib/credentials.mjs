/**
 * Credential resolution (REQ-04, 8.1) — the P0 fix.
 *
 * The defect that made this a P0: the old resolver tried to match a YAML line
 * and, on failure, returned the WHOLE FILE as the key. On a real credential
 * store that means several kilobytes of unrelated secrets become a Bearer
 * header value. It also had no defence against a value containing a newline,
 * which a header must never carry.
 *
 * The fix is structural, not a patch:
 *   - the plain-key parser and the YAML parser are separate, chosen by format;
 *   - a YAML document without the requested key is NEVER a key;
 *   - every candidate value passes the same sanity check before it is returned;
 *   - a failure reports a reason code and a file path, never file contents.
 *
 * Nothing here opens a real credential store on its own: the filesystem is
 * injected, so the regression tests run on synthetic strings only.
 */
import { existsSync as realExists, readFileSync as realRead } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_KEY_NAME = 'TYPESAFE_API_KEY';

export const CREDENTIAL_REASON = Object.freeze({
  fromEnv: 'env',
  fromPlainFile: 'plain_file',
  fromYaml: 'yaml_mapping',
  notFound: 'no_credential_found',
  fileUnreadable: 'credential_file_unreadable',
  malformedValue: 'credential_value_malformed',
  emptyValue: 'credential_value_empty',
  yamlKeyMissing: 'yaml_key_missing',
  ambiguousPlainFile: 'plain_file_not_single_line',
});

/**
 * A credential is a token: printable ASCII, no whitespace, bounded length.
 * This is the check that would have stopped the multi-kilobyte fallback.
 */
export function sanitizeKeyValue(raw) {
  if (typeof raw !== 'string') return { ok: false, code: CREDENTIAL_REASON.emptyValue };
  const value = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (value === '') return { ok: false, code: CREDENTIAL_REASON.emptyValue };
  if (value.length < 8 || value.length > 4096) return { ok: false, code: CREDENTIAL_REASON.malformedValue };
  if (/[\r\n\t]/.test(value)) return { ok: false, code: CREDENTIAL_REASON.malformedValue };
  if (!/^[\x21-\x7e]+$/.test(value)) return { ok: false, code: CREDENTIAL_REASON.malformedValue };
  return { ok: true, value };
}

/**
 * A file holding nothing but the key. Exactly one meaningful line: a second line
 * means this is not a key file, and guessing which line is the key is how the
 * original bug happened.
 */
export function parsePlainKeyFile(text) {
  if (typeof text !== 'string') return { ok: false, code: CREDENTIAL_REASON.fileUnreadable };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  if (lines.length === 0) return { ok: false, code: CREDENTIAL_REASON.emptyValue };
  if (lines.length > 1) return { ok: false, code: CREDENTIAL_REASON.ambiguousPlainFile };
  return sanitizeKeyValue(lines[0]);
}

/**
 * Find one key in a YAML mapping.
 *
 * Deliberately not a YAML parser: it scans for a shallow mapping entry, stops at
 * the first match, ignores comments, list items and nested structures, and
 * refuses to fall back to anything. When the key is absent the answer is
 * "absent" — which is the whole point of the fix.
 */
export function parseYamlCredential(text, { keyName = DEFAULT_KEY_NAME, maxIndent = 4 } = {}) {
  if (typeof text !== 'string') return { ok: false, code: CREDENTIAL_REASON.fileUnreadable };
  const escaped = keyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^(\\s*)${escaped}\\s*:\\s*(.*)$`);

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue;
    const match = rawLine.match(line);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '  ').length;
    if (indent > maxIndent) continue;
    if (/^\s*-\s/.test(rawLine)) continue;
    let value = match[2];
    // Strip an inline comment only when it is clearly separated from the value.
    value = value.replace(/\s+#.*$/, '').trim();
    const sanitized = sanitizeKeyValue(value);
    if (sanitized.ok) return { ...sanitized, indent };
    return { ok: false, code: sanitized.code };
  }
  return { ok: false, code: CREDENTIAL_REASON.yamlKeyMissing };
}

/**
 * Decide which parser a file deserves.
 *
 * Only a real mapping entry counts as YAML: `key:` at the start of a line or
 * after indentation. An empty line must not qualify — a plain key file ends with
 * a newline, and a naive blank-line test would send it to the YAML parser and
 * lose the key.
 */
export function parseCredentialFile(text, { keyName = DEFAULT_KEY_NAME } = {}) {
  const looksLikeYaml = /^[A-Za-z_][\w.-]*\s*:/m.test(text) || /^[ \t]+[A-Za-z_][\w.-]*\s*:/m.test(text);
  return looksLikeYaml ? parseYamlCredential(text, { keyName }) : parsePlainKeyFile(text);
}

/** Candidate locations, in priority order. `key` files come before shared stores. */
export function credentialCandidates({ homeDir, userHome = homedir() } = {}) {
  const list = [];
  if (homeDir) list.push({ path: join(homeDir, 'key'), format: 'auto', source: 'jev_home' });
  list.push({ path: join(userHome, '.dsh', '.credentials.yaml'), format: 'yaml', source: 'dsh_credentials' });
  list.push({ path: join(userHome, '.config', 'jev-gates', 'key'), format: 'plain', source: 'xdg_config' });
  return list;
}

/**
 * Resolve a key. `fs` is injected so tests never touch a real store.
 *
 * Returns `{ ok, value, source, code }`. The value is never logged by this
 * module and never included in a failure.
 */
export function resolveApiKey({
  env = process.env,
  homeDir = null,
  userHome = homedir(),
  keyName = DEFAULT_KEY_NAME,
  fs = { existsSync: realExists, readFileSync: realRead },
} = {}) {
  const fromEnv = sanitizeKeyValue(env?.[keyName]);
  if (fromEnv.ok) return { ok: true, value: fromEnv.value, source: CREDENTIAL_REASON.fromEnv, code: null };

  const attempts = [];
  for (const candidate of credentialCandidates({ homeDir, userHome })) {
    if (!fs.existsSync(candidate.path)) continue;
    let text;
    try {
      text = fs.readFileSync(candidate.path, 'utf8');
    } catch {
      attempts.push({ source: candidate.source, code: CREDENTIAL_REASON.fileUnreadable });
      continue;
    }
    const parsed =
      candidate.format === 'yaml'
        ? parseYamlCredential(text, { keyName })
        : candidate.format === 'plain'
          ? parsePlainKeyFile(text)
          : parseCredentialFile(text, { keyName });
    if (parsed.ok) {
      return {
        ok: true,
        value: parsed.value,
        source: candidate.format === 'yaml' ? CREDENTIAL_REASON.fromYaml : CREDENTIAL_REASON.fromPlainFile,
        path: candidate.path,
        code: null,
      };
    }
    attempts.push({ source: candidate.source, code: parsed.code });
  }

  return { ok: false, value: null, source: null, code: CREDENTIAL_REASON.notFound, attempts };
}

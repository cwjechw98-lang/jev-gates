/**
 * Action classification for the DSH adapter.
 *
 * Narrow by design. This is not the approval gateway: it does not have an
 * "undeclared" rule, because in a live session every unrecognised tool would
 * become a question and the adapter would be unmounted within a day. Here,
 * silence means "this gate has nothing to say", and another guard's deny stays
 * in force (the harness folds decisions as deny > ask > allow).
 *
 * The patterns are deliberately explicit and readable: a rule a human cannot
 * audit is a rule a human cannot trust.
 */

/** Each rule: a name, a test, and the irreversibility flags it implies. */
export const COMMAND_RULES = [
  {
    name: 'git_push',
    test: /\bgit\s+push\b/i,
    flags: ['external_irreversible', 'public_irreversible'],
  },
  {
    name: 'package_publish',
    test: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i,
    flags: ['external_irreversible', 'public_irreversible'],
  },
  {
    name: 'release_or_pr',
    test: /\bgh\s+(pr|release|repo)\s+(create|delete|edit)\b|\bgh\s+release\s+(create|delete)\b/i,
    flags: ['external_irreversible', 'public_irreversible'],
  },
  {
    name: 'recursive_delete',
    test: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\bRemove-Item\b[^\n]*-Recurse\b|\brmdir\s+\/s\b|\bdel\s+\/[sq]\b/i,
    flags: ['destructive_irreversible'],
  },
  {
    name: 'history_rewrite',
    test: /\bgit\s+(push\s+--force|push\s+-f|reset\s+--hard|filter-branch|rebase\s+--root)\b/i,
    flags: ['destructive_irreversible', 'external_irreversible'],
  },
  {
    name: 'credential_read',
    test: /(\.credentials\.yaml|\.env\b|id_rsa|\.pem\b|credentials\.json|\.aws\/credentials)/i,
    flags: ['credential_out'],
  },
  {
    name: 'outbound_upload',
    test: /\bcurl\b[^\n]*(-X\s*POST|-d\s|--data|-T\s|--upload-file)|\bgh\s+gist\s+create\b|\baws\s+s3\s+(cp|sync|rm)\b/i,
    flags: ['external_irreversible'],
  },
  {
    name: 'bulk_overwrite',
    test: /\bfind\b[^\n]*-delete\b|\bsed\b[^\n]*-i\b[^\n]*\*|\btruncate\b|\bformat\b\s+[A-Z]:/i,
    flags: ['bulk_irreversible'],
  },
];

/** Irreversible when the tool writes outside the project, by tool name alone. */
const TOOL_RULES = [
  { name: 'web_fetch_or_post', test: /^(webfetch|web_fetch|websearch)$/i, flags: [] },
];

/**
 * Classify a command.
 *
 * Two kinds of rule are accepted in `rules`, and both are needed:
 *
 * - `{name, test, flags}` matches the command TEXT, for shell-shaped calls;
 * - `{name, tool, flags}` matches the TOOL NAME, for a tool whose arguments carry
 *   no command to read. Without the second kind a session could not state "this
 *   particular tool always needs authorisation", which is exactly the rule an
 *   acceptance test needs and exactly what `TOOL_RULES` above was written for.
 *
 * @returns {{action, flags, irreversible, rule}}
 */
export function classifyCommand(command, { toolName = null, rules = null } = {}) {
  const text = typeof command === 'string' ? command : '';
  const activeRules = Array.isArray(rules) ? rules : COMMAND_RULES;
  const matchedFlags = new Set();
  const matchedRules = [];

  for (const rule of activeRules) {
    const textHit = rule.test instanceof RegExp && rule.test.test(text);
    const toolHit = rule.tool instanceof RegExp && typeof toolName === 'string' && rule.tool.test(toolName);
    if (textHit || toolHit) {
      matchedRules.push(rule.name);
      for (const flag of rule.flags) matchedFlags.add(flag);
    }
  }

  // A read of a credential file is only "going out" when the same command also
  // sends something. Reading a file to inspect it is not exfiltration, and
  // treating it as such would make the rule useless.
  if (matchedFlags.has('credential_out') && !/(curl|wget|Invoke-WebRequest|scp|rsync|upload|gist)/i.test(text)) {
    matchedFlags.delete('credential_out');
  }

  const flags = [...matchedFlags];
  const action = matchedRules[0] ?? (toolName ? `tool:${toolName}` : 'unclassified');
  return {
    action,
    flags,
    irreversible: flags.length > 0,
    rules: matchedRules,
    toolName,
  };
}

/** Convenience: just the flags, for callers that only need the verdict. */
export function irreversibleFlags(command, options = {}) {
  return classifyCommand(command, options).flags;
}

export { TOOL_RULES };

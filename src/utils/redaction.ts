import { LIMITS, truncate } from './limits.js';

/**
 * Redaction helpers.
 *
 * COUE reports *where* a credential-like value appears, never the value. Every
 * piece of evidence that leaves the analysis engine passes through
 * `redactEvidence` first.
 */

/** Pattern groups whose matches must be masked anywhere they appear. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  // AWS access key IDs.
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  // GitHub tokens (classic, fine-grained, OAuth, app, refresh).
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Stripe keys.
  /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  // OpenAI-style keys.
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // Anthropic-style keys.
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // Hugging Face tokens.
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  // Private key blocks.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g
];

/**
 * Assignment forms such as `API_KEY = "..."`, `password: '...'`,
 * `token=...`. The captured value is replaced, the key is kept.
 */
const ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|apikey|secret|secret[_-]?key|password|passwd|pwd|token|access[_-]?token|auth[_-]?token|bearer|client[_-]?secret|private[_-]?key|connection[_-]?string|dsn)\s*[:=]\s*)(["'`]?)([^\s"'`,;)\]}]{4,})\2/gi;

/** Credentials embedded in a URL, e.g. `postgres://user:pw@host/db`. */
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi;

export const REDACTED = '[REDACTED]';

/**
 * Masks credential-like values inside an arbitrary string.
 *
 * This is intentionally aggressive: it is applied to text that is about to be
 * returned to the caller, where over-masking is harmless and under-masking is
 * a disclosure.
 */
export function redactSecrets(input: string): string {
  let out = input;

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }

  out = out.replace(URL_CREDENTIAL_PATTERN, (_m, scheme: string, user: string) => {
    return `${scheme}${user}:${REDACTED}@`;
  });

  out = out.replace(ASSIGNMENT_PATTERN, (_m, prefix: string, quote: string) => {
    return `${prefix}${quote}${REDACTED}${quote}`;
  });

  return out;
}

/**
 * Prepares an evidence snippet for inclusion in a finding: collapses
 * whitespace, redacts credential-like values, and truncates.
 *
 * Returns `undefined` when nothing meaningful remains, so callers can omit the
 * `evidence` field rather than emit an empty one.
 */
export function redactEvidence(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  const redacted = redactSecrets(collapsed);
  const clipped = truncate(redacted, LIMITS.MAX_EVIDENCE_CHARS);
  return clipped.length > 0 ? clipped : undefined;
}

/**
 * Describes a credential match without revealing it: returns only the match
 * length and a masked shape, suitable for a finding description.
 */
export function describeSecretShape(match: string): string {
  const length = match.length;
  return `${length}-character value`;
}

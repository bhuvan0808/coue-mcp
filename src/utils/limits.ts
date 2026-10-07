/**
 * Application-level limits for COUE.
 *
 * These are deliberately set well below Claude's platform maxima (~150,000
 * characters per tool result on claude.ai, 240s per tool call). COUE is a
 * public, unauthenticated service, so the limits also act as abuse control.
 */
export const LIMITS = {
  /** Maximum decoded request body COUE will accept on /mcp, in bytes. */
  MAX_REQUEST_BODY_BYTES: 1_500_000,

  /** Maximum number of files accepted by a single audit_project call. */
  MAX_FILES: 60,

  /** Maximum size of any single submitted file, in characters. */
  MAX_FILE_CHARS: 120_000,

  /** Maximum combined size of all submitted file contents, in characters. */
  MAX_TOTAL_CHARS: 600_000,

  /** Maximum length of a submitted file path. */
  MAX_PATH_CHARS: 400,

  /** Hard ceiling on findings returned, regardless of maxFindings. */
  MAX_FINDINGS_CEILING: 50,

  /** Default number of findings returned when the caller does not specify. */
  DEFAULT_MAX_FINDINGS: 10,

  /** Maximum models accepted by compare_models. */
  MAX_MODELS: 12,

  /** Maximum distinct metrics considered per model. */
  MAX_METRICS_PER_MODEL: 25,

  /** Maximum findings accepted by generate_readiness_report. */
  MAX_REPORT_FINDINGS: 60,

  /** Maximum characters of a single evidence snippet included in a finding. */
  MAX_EVIDENCE_CHARS: 180,

  /** Soft ceiling on the character length of any tool result payload. */
  MAX_RESULT_CHARS: 60_000,

  /** Number of lines scanned per file by line-oriented analyzers. */
  MAX_LINES_SCANNED: 4_000,

  /** Wall-clock budget for a single analysis run, in milliseconds. */
  ANALYSIS_TIME_BUDGET_MS: 10_000
} as const;

/**
 * Characters that must never appear in a submitted path.
 *
 * Matching control characters is the point of this rule: a path containing a
 * NUL, a newline, or an escape sequence is rejected rather than echoed back
 * into a result where it could corrupt output or hide content.
 */
// eslint-disable-next-line no-control-regex -- intentionally matches control characters
const PATH_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Normalizes a submitted file path for display and analysis.
 *
 * COUE never touches a filesystem, so this is not a filesystem security
 * boundary. It exists so that traversal sequences and absolute paths cannot
 * be echoed back into a result or used to confuse path-based matching.
 */
export function normalizePath(rawPath: string): string {
  const unixified = rawPath.replace(/\\/g, '/');
  const segments = unixified.split('/');
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    // Strip a Windows drive prefix such as "C:".
    out.push(segment.replace(/^[A-Za-z]:$/, ''));
  }

  return out.filter(Boolean).join('/');
}

/** Returns true when a path is safe to accept and echo back. */
export function isAcceptablePath(rawPath: string): boolean {
  if (typeof rawPath !== 'string') return false;
  if (rawPath.length === 0 || rawPath.length > LIMITS.MAX_PATH_CHARS) return false;
  if (PATH_CONTROL_CHARS.test(rawPath)) return false;
  return normalizePath(rawPath).length > 0;
}

/** Keys that must never be copied out of caller-supplied objects. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Returns true when an object key is safe to read from caller input. */
export function isSafeKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key);
}

/**
 * Copies a caller-supplied record into a null-prototype object, dropping any
 * key that could be used for prototype pollution.
 */
export function safeRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!isSafeKey(key)) continue;
    out[key] = input[key];
  }
  return out;
}

/** Truncates a string to `max` characters, appending an ellipsis marker. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}\u2026`;
}

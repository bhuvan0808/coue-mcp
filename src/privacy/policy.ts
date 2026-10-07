/**
 * COUE privacy posture, as a single source of truth.
 *
 * These statements are asserted by the test suite against the implementation,
 * and are reproduced verbatim in docs/privacy.md and in the directory
 * submission answers. If the implementation changes, this file and both of
 * those must change with it.
 */

export const PRIVACY_POLICY = {
  version: '1.0.0',
  effectiveDate: '2026-10-07',

  /** What COUE receives. */
  dataReceived: [
    'File paths and file contents that the user chooses to send through Claude for an audit.',
    'Structured project metadata supplied to check_ml_project.',
    'Model names and numeric metrics supplied to compare_models.',
    'Findings supplied to generate_readiness_report.'
  ],

  /** What COUE does with it. */
  processing: [
    'All analysis is performed in memory, within the single request that supplied the data.',
    'Analysis is static: COUE never executes, imports, installs, or interprets submitted code.',
    'COUE makes no outbound network requests while analyzing a project.'
  ],

  /** What COUE stores. */
  retention: [
    'COUE operates no database, no object storage, no cache, and no queue.',
    'Submitted file contents, paths, metadata, and findings are discarded when the request completes.',
    'Request bodies are never written to logs.',
    'Detected credential values are never returned, never logged, and never stored.'
  ],

  /** What COUE never accesses. */
  neverAccessed: [
    'Claude conversation history',
    'Claude memory',
    'User files other than those explicitly supplied to a tool call',
    'Any external account, repository, or cloud provider',
    'Any third-party API'
  ],

  /** Operational logging. */
  logging: [
    'COUE emits operational log records containing the tool name, a coarse outcome, a duration, and counts such as the number of files analyzed.',
    'COUE does not log file paths, file contents, findings, metric values, or any value matching a credential pattern.',
    'Cloudflare, as the hosting provider, processes request metadata (such as source IP, timestamp, and response status) under its own terms as part of serving the request. COUE does not configure additional retention beyond the platform default and does not have access to submitted request bodies after the request completes.'
  ],

  /** Data COUE does not request. */
  notRequested: {
    personalData: 'Not intentionally requested.',
    sensitiveData: 'Not intentionally requested.',
    authenticationCredentials: 'Not required. COUE is unauthenticated.',
    financialData: 'Not required.',
    healthData: 'Not required.',
    externalAccountAccess: 'None.'
  },

  /** Training. */
  training: 'Submitted content is never used to train any model.',

  /** Where to raise a concern. */
  contact: 'https://github.com/bhuvan0808/coue-mcp/issues'
} as const;

/**
 * The short privacy notice COUE can return inline when a user asks what it
 * does with their code.
 */
export const PRIVACY_SUMMARY =
  'COUE analyzes the files you send in memory and discards them when the request completes. It operates no database or storage, makes no outbound network calls during analysis, never executes submitted code, and never returns or logs a detected credential value. It does not access Claude conversation history, Claude memory, or any external account.';

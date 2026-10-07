import { redactEvidence } from '../utils/redaction.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type Confidence = 'high' | 'medium' | 'low';

/**
 * The eight scored categories. These are stable identifiers used in findings,
 * in the scoring engine, and in the `focus` parameter of `audit_project`.
 */
export type Category =
  | 'dependencies'
  | 'security'
  | 'testing'
  | 'docker'
  | 'model-serving'
  | 'reproducibility'
  | 'observability'
  | 'deployment';

export const ALL_CATEGORIES: readonly Category[] = [
  'dependencies',
  'security',
  'testing',
  'docker',
  'model-serving',
  'reproducibility',
  'observability',
  'deployment'
] as const;

/**
 * A check outcome. `UNKNOWN` is a first-class result: it means COUE could not
 * determine the answer from the files it was given, which is different from
 * the check failing.
 */
export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE';

export interface Finding {
  id: string;
  severity: Severity;
  category: Category | string;
  title: string;
  description: string;
  evidence?: string;
  recommendation: string;
  confidence: Confidence;
}

/** A finding plus the internal bookkeeping the scoring engine needs. */
export interface InternalFinding extends Finding {
  category: Category;
  /** Where the issue was observed, when a specific file is implicated. */
  file?: string;
  /** 1-based line number, when a specific line is implicated. */
  line?: number;
}

export interface PassedCheck {
  id: string;
  category: Category;
  title: string;
  /** Defaults to PASS; set explicitly only for NOT_APPLICABLE. */
  status?: Extract<CheckStatus, 'PASS' | 'NOT_APPLICABLE'>;
}

export interface UnknownCheck {
  id: string;
  category: Category;
  title: string;
  reason: string;
}

/** Everything an analyzer produces. */
export interface AnalyzerResult {
  findings: InternalFinding[];
  passed: PassedCheck[];
  unknown: UnknownCheck[];
}

export function emptyResult(): AnalyzerResult {
  return { findings: [], passed: [], unknown: [] };
}

export function mergeResults(results: AnalyzerResult[]): AnalyzerResult {
  const merged = emptyResult();
  for (const r of results) {
    merged.findings.push(...r.findings);
    merged.passed.push(...r.passed);
    merged.unknown.push(...r.unknown);
  }
  return merged;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

const CONFIDENCE_ORDER: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2
};

/** Sorts findings most severe first, then by confidence, then by id. */
export function sortFindings<T extends Finding>(findings: T[]): T[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byConfidence = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Removes duplicate findings. Two findings collapse when they share an id and
 * implicate the same file, which happens when several analyzers observe the
 * same root cause.
 */
export function dedupeFindings(findings: InternalFinding[]): InternalFinding[] {
  const seen = new Set<string>();
  const out: InternalFinding[] = [];
  for (const f of findings) {
    const key = `${f.id}::${f.file ?? ''}::${f.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export interface FindingInit {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  recommendation: string;
  confidence: Confidence;
  file?: string;
  line?: number;
  evidence?: string;
}

/**
 * Builds a finding, redacting evidence on the way in.
 *
 * Evidence is omitted entirely when it is absent or reduces to nothing after
 * redaction. COUE never fabricates a file name, a line number, or a snippet.
 */
export function makeFinding(init: FindingInit): InternalFinding {
  const evidence = redactEvidence(init.evidence);
  const finding: InternalFinding = {
    id: init.id,
    severity: init.severity,
    category: init.category,
    title: init.title,
    description: init.description,
    recommendation: init.recommendation,
    confidence: init.confidence
  };
  if (evidence !== undefined) finding.evidence = evidence;
  if (init.file !== undefined) finding.file = init.file;
  if (init.line !== undefined) finding.line = init.line;
  return finding;
}

/** Strips internal-only fields, producing the public finding shape. */
export function toPublicFinding(f: InternalFinding): Finding {
  const location = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : undefined;
  const description = location ? `${f.description} (observed in ${location})` : f.description;

  const out: Finding = {
    id: f.id,
    severity: f.severity,
    category: f.category,
    title: f.title,
    description,
    recommendation: f.recommendation,
    confidence: f.confidence
  };
  if (f.evidence !== undefined) out.evidence = f.evidence;
  return out;
}

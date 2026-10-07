import { analyzeDependencies } from './dependencies.js';
import { analyzeDeployment } from './deployment.js';
import { analyzeDocker } from './docker.js';
import {
  ALL_CATEGORIES,
  dedupeFindings,
  mergeResults,
  sortFindings,
  toPublicFinding,
  type AnalyzerResult,
  type Category,
  type Finding,
  type InternalFinding,
  type PassedCheck,
  type UnknownCheck
} from './findings.js';
import { analyzeModelServing } from './model-serving.js';
import { analyzeObservability } from './observability.js';
import { detectProject, toSourceFile, type ProjectProfile } from './project-detector.js';
import { analyzeReproducibility } from './reproducibility.js';
import {
  SCORE_DISCLAIMER,
  buildCategoryEvidence,
  computeScore,
  type ScoreResult
} from './scoring.js';
import { analyzeSecurity } from './security.js';
import { analyzeTesting } from './testing.js';
import { errors } from '../utils/errors.js';
import { LIMITS, isAcceptablePath } from '../utils/limits.js';

/**
 * Audit service.
 *
 * This is the boundary between the MCP layer and the analysis engine. Tool
 * handlers call `runAudit` and format its result; they contain no analysis
 * logic of their own.
 */

export interface RawFile {
  path: string;
  content: string;
}

export interface AuditOptions {
  projectName?: string;
  frameworkHint?: string;
  focus?: Category[];
  includePassedChecks?: boolean;
  maxFindings?: number;
}

export interface AuditResult {
  score: number;
  status: string;
  summary: string;
  disclaimer: string;
  project: {
    name?: string;
    ecosystems: string[];
    frameworksDetected: Array<{ name: string; evidence: string }>;
    filesAnalyzed: number;
    categoriesAnalyzed: string[];
    categoriesNotAssessed: string[];
  };
  categories: Record<string, number>;
  findingCounts: Record<string, number>;
  criticalFindings: Finding[];
  highFindings: Finding[];
  otherFindings: Finding[];
  totalFindings: number;
  findingsReturned: number;
  recommendations: string[];
  passedChecks?: Array<{ id: string; category: string; title: string }>;
  couldNotDetermine: Array<{ category: string; check: string; reason: string }>;
}

type AnalyzerFn = (profile: ProjectProfile) => AnalyzerResult;

const ANALYZERS: Record<Category, AnalyzerFn> = {
  security: analyzeSecurity,
  dependencies: analyzeDependencies,
  docker: analyzeDocker,
  'model-serving': analyzeModelServing,
  reproducibility: analyzeReproducibility,
  testing: analyzeTesting,
  observability: analyzeObservability,
  deployment: analyzeDeployment
};

/**
 * Validates and normalizes submitted files.
 *
 * Throws a CoueError describing the specific limit that was exceeded, so the
 * caller gets an actionable message rather than a generic rejection.
 */
export function prepareFiles(files: RawFile[]): ReturnType<typeof toSourceFile>[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw errors.emptyInput();
  }

  if (files.length > LIMITS.MAX_FILES) {
    throw errors.tooManyFiles(files.length, LIMITS.MAX_FILES);
  }

  let total = 0;
  const prepared: ReturnType<typeof toSourceFile>[] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw errors.unsupportedPath(typeof file?.path === 'string' ? file.path : '');
    }

    if (!isAcceptablePath(file.path)) {
      throw errors.unsupportedPath(file.path);
    }

    if (file.content.length > LIMITS.MAX_FILE_CHARS) {
      throw errors.fileTooLarge(file.path, LIMITS.MAX_FILE_CHARS);
    }

    total += file.content.length;
    if (total > LIMITS.MAX_TOTAL_CHARS) {
      throw errors.sourceTooLarge(total, LIMITS.MAX_TOTAL_CHARS);
    }

    const source = toSourceFile(file.path, file.content);
    // A duplicate path would double-count findings; keep the first occurrence.
    const key = source.path.toLowerCase();
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    prepared.push(source);
  }

  if (prepared.length === 0) {
    throw errors.emptyInput();
  }

  return prepared;
}

/** Builds the one-paragraph human summary that accompanies every audit. */
function buildSummary(
  profile: ProjectProfile,
  score: ScoreResult,
  findings: InternalFinding[]
): string {
  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const highCount = findings.filter((f) => f.severity === 'high').length;

  const name = profile.projectName ? `"${profile.projectName}"` : 'The project';
  const frameworkNames = profile.frameworks.map((f) => f.name);
  const frameworkText =
    frameworkNames.length > 0
      ? ` COUE detected ${frameworkNames.slice(0, 4).join(', ')}${frameworkNames.length > 4 ? ', and others' : ''}.`
      : '';

  if (score.assessedWeight === 0) {
    return (
      `${name} could not be scored. The files supplied did not contain enough configuration or source for any ` +
      'of the eight readiness categories to be assessed. Include the serving entry point, the dependency manifest, ' +
      'and the container or deployment configuration for a meaningful audit.'
    );
  }

  const parts: string[] = [];
  parts.push(`${name} scores ${score.score}/100 (${score.status}).`);

  if (criticalCount > 0) {
    parts.push(
      `${criticalCount} critical ${criticalCount === 1 ? 'issue' : 'issues'} ${criticalCount === 1 ? 'was' : 'were'} found and should be resolved before deployment.`
    );
  } else if (highCount > 0) {
    parts.push(
      `No critical issues were found, but ${highCount} high-severity ${highCount === 1 ? 'issue' : 'issues'} ${highCount === 1 ? 'needs' : 'need'} attention.`
    );
  } else if (findings.length > 0) {
    parts.push('No critical or high-severity issues were found.');
  } else {
    parts.push('No issues were found in the categories COUE was able to assess.');
  }

  if (score.notAssessed.length > 0) {
    parts.push(
      `${score.notAssessed.length} ${score.notAssessed.length === 1 ? 'category' : 'categories'} (${score.notAssessed.join(', ')}) could not be assessed from the files supplied and ${score.notAssessed.length === 1 ? 'was' : 'were'} excluded from the score rather than counted as failures.`
    );
  }

  return parts.join(' ') + frameworkText;
}

/** Picks the recommendations worth surfacing, most severe first, deduplicated. */
function buildRecommendations(findings: InternalFinding[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const finding of sortFindings(findings)) {
    if (out.length >= limit) break;
    const key = finding.recommendation.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding.recommendation);
  }

  return out;
}

/** Runs the audit. This is the single entry point used by the MCP layer. */
export function runAudit(files: RawFile[], options: AuditOptions = {}): AuditResult {
  const started = Date.now();

  const prepared = prepareFiles(files);
  const profile = detectProject(prepared, options.projectName);

  const requested: Category[] =
    options.focus && options.focus.length > 0 ? [...new Set(options.focus)] : [...ALL_CATEGORIES];

  const results: AnalyzerResult[] = [];
  for (const category of requested) {
    const analyzer = ANALYZERS[category];
    if (!analyzer) continue;
    results.push(analyzer(profile));

    if (Date.now() - started > LIMITS.ANALYSIS_TIME_BUDGET_MS) {
      // Return what was computed rather than failing the whole request.
      break;
    }
  }

  const merged = mergeResults(results);

  // Findings are keyed to a category; a focused audit must not leak findings
  // from an analyzer that happened to observe something outside its remit.
  const requestedSet = new Set(requested);
  const allFindings = dedupeFindings(merged.findings).filter((f) => requestedSet.has(f.category));
  const passed: PassedCheck[] = merged.passed.filter((p) => requestedSet.has(p.category));
  const unknowns: UnknownCheck[] = merged.unknown.filter((u) => requestedSet.has(u.category));

  const evidence = buildCategoryEvidence(
    allFindings,
    passed.map((p) => p.category),
    unknowns
  );

  // Categories the caller did not ask for must not count against the score.
  for (const category of ALL_CATEGORIES) {
    if (requestedSet.has(category)) continue;
    const entry = evidence[category];
    if (entry) entry.blockingUnknowns = 1;
  }

  const score = computeScore(allFindings, evidence);

  const sorted = sortFindings(allFindings);
  const maxFindings = Math.min(
    options.maxFindings ?? LIMITS.DEFAULT_MAX_FINDINGS,
    LIMITS.MAX_FINDINGS_CEILING
  );

  const critical = sorted.filter((f) => f.severity === 'critical');
  const high = sorted.filter((f) => f.severity === 'high');
  const rest = sorted.filter((f) => f.severity !== 'critical' && f.severity !== 'high');

  // Critical and high findings always take priority within the budget.
  const returned: InternalFinding[] = [];
  for (const group of [critical, high, rest]) {
    for (const finding of group) {
      if (returned.length >= maxFindings) break;
      returned.push(finding);
    }
  }

  const returnedCritical = returned.filter((f) => f.severity === 'critical').map(toPublicFinding);
  const returnedHigh = returned.filter((f) => f.severity === 'high').map(toPublicFinding);
  const returnedOther = returned
    .filter((f) => f.severity !== 'critical' && f.severity !== 'high')
    .map(toPublicFinding);

  const findingCounts: Record<string, number> = {
    critical: critical.length,
    high: high.length,
    medium: allFindings.filter((f) => f.severity === 'medium').length,
    low: allFindings.filter((f) => f.severity === 'low').length,
    info: allFindings.filter((f) => f.severity === 'info').length
  };

  const result: AuditResult = {
    score: score.score,
    status: score.status,
    summary: buildSummary(profile, score, allFindings),
    disclaimer: SCORE_DISCLAIMER,
    project: {
      ecosystems: profile.ecosystems,
      frameworksDetected: profile.frameworks.map((f) => ({ name: f.name, evidence: f.evidence })),
      filesAnalyzed: prepared.length,
      categoriesAnalyzed: requested.filter((c) => !score.notAssessed.includes(c)),
      categoriesNotAssessed: score.notAssessed
    },
    categories: score.categories,
    findingCounts,
    criticalFindings: returnedCritical,
    highFindings: returnedHigh,
    otherFindings: returnedOther,
    totalFindings: allFindings.length,
    findingsReturned: returned.length,
    recommendations: buildRecommendations(allFindings, 5),
    couldNotDetermine: unknowns.map((u) => ({
      category: u.category,
      check: u.title,
      reason: u.reason
    }))
  };

  if (profile.projectName !== undefined) result.project.name = profile.projectName;

  if (options.includePassedChecks) {
    result.passedChecks = passed.map((p) => ({ id: p.id, category: p.category, title: p.title }));
  }

  return result;
}

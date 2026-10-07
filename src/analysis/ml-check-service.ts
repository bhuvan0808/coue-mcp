import type { CheckMlProjectInput } from '../schemas/audit.js';
import { SCORE_DISCLAIMER, statusForScore } from './scoring.js';
import type { Category, CheckStatus, Confidence, Finding, Severity } from './findings.js';

/**
 * Metadata-driven ML readiness check.
 *
 * Unlike `runAudit`, this service has no files to look at: it evaluates a
 * caller-supplied description of the system. The central rule is that a field
 * the caller omitted is `UNKNOWN`, never `false`. An unknown never produces a
 * finding and never costs score; it is reported so the caller can go and find
 * out.
 */

export interface CheckItem {
  id: string;
  category: Category;
  title: string;
  status: CheckStatus;
  /** Present when the status is FAIL. */
  impact?: string;
  recommendation?: string;
  severity?: Severity;
}

export interface MlCheckResult {
  score: number | null;
  status: string;
  summary: string;
  disclaimer: string;
  declared: {
    framework: string;
    modelType: string;
    servingFramework: string;
  };
  coverage: {
    totalChecks: number;
    answered: number;
    unknown: number;
    notApplicable: number;
  };
  checks: CheckItem[];
  findings: Finding[];
  unknowns: Array<{ check: string; category: string; whyItMatters: string }>;
  recommendations: string[];
}

interface CheckDefinition {
  id: string;
  category: Category;
  title: string;
  severity: Severity;
  confidence: Confidence;
  /** Why a `false` answer matters. */
  impact: string;
  recommendation: string;
  /** Why the caller should find out when the answer is unknown. */
  whyItMatters: string;
}

const CHECKS: Record<string, CheckDefinition> = {
  'trainingPipeline.hasConfigFile': {
    id: 'ML-CONFIG',
    category: 'reproducibility',
    title: 'Training configuration is externalized',
    severity: 'medium',
    confidence: 'high',
    impact:
      'Hyperparameters embedded in code mean reproducing a past run requires recovering the exact source revision, and comparing two runs requires reading a diff.',
    recommendation:
      'Move hyperparameters into a configuration file and store the resolved configuration with each run.',
    whyItMatters:
      'Determines whether a past training run can be reproduced from recorded settings.'
  },
  'trainingPipeline.randomSeedSet': {
    id: 'ML-SEED',
    category: 'reproducibility',
    title: 'Random seed is set for training',
    severity: 'medium',
    confidence: 'high',
    impact:
      'Without a fixed seed, two runs of the same code on the same data produce different weights, so a regression cannot be separated from run-to-run variance.',
    recommendation:
      'Seed every generator the run uses, read the seed from configuration, and record it with the run. Note that seeding alone does not make GPU training bit-exact.',
    whyItMatters: 'Determines whether a training result can be reproduced at all.'
  },
  'trainingPipeline.dataVersioned': {
    id: 'ML-DATA-VERSION',
    category: 'reproducibility',
    title: 'Training data is versioned',
    severity: 'high',
    confidence: 'high',
    impact:
      'When the training dataset can change in place, a model cannot be tied back to the data that produced it, and a rerun on "the same" data can yield a different model.',
    recommendation:
      'Version the dataset with an immutable identifier, whether through a data-versioning tool or a versioned object-store prefix, and record the identifier with each run.',
    whyItMatters:
      'Determines whether the data behind a deployed model can be identified after the fact.'
  },
  'trainingPipeline.modelVersioned': {
    id: 'ML-MODEL-VERSION',
    category: 'reproducibility',
    title: 'Model artifacts are versioned',
    severity: 'high',
    confidence: 'high',
    impact:
      'An artifact at a mutable path can be replaced without trace, after which the deployed behaviour no longer corresponds to any recorded run and a rollback has nothing to roll back to.',
    recommendation:
      'Publish each artifact under an immutable version identifier and have the serving process load a specific version.',
    whyItMatters: 'Determines whether a deployment can be rolled back to a known-good model.'
  },
  'trainingPipeline.experimentTracking': {
    id: 'ML-TRACKING',
    category: 'reproducibility',
    title: 'Experiment tracking is in place',
    severity: 'low',
    confidence: 'high',
    impact:
      'Without a per-run record of parameters, metrics, and artifacts, comparing a candidate against the deployed model relies on manually kept notes.',
    recommendation:
      'Record parameters, metrics, configuration, code revision, and output artifact for every run. A structured metadata file alongside each artifact satisfies this as well as a tracking service.',
    whyItMatters: 'Determines whether model selection decisions can be justified later.'
  },

  'serving.healthEndpoint': {
    id: 'ML-HEALTH',
    category: 'model-serving',
    title: 'Health endpoint is exposed',
    severity: 'high',
    confidence: 'high',
    impact:
      'Without a health endpoint, an orchestrator cannot distinguish a process that is running from one that is serving, so a container stuck after a failed model load keeps receiving traffic.',
    recommendation:
      'Expose a lightweight health endpoint that returns quickly without touching the model, and wire it to the liveness probe.',
    whyItMatters: 'Determines whether a hung replica is detected and restarted automatically.'
  },
  'serving.readinessEndpoint': {
    id: 'ML-READINESS',
    category: 'model-serving',
    title: 'Readiness endpoint is exposed',
    severity: 'medium',
    confidence: 'high',
    impact:
      'A liveness check cannot express "up but not loaded yet", so during a rolling deployment traffic reaches replicas that cannot serve a prediction.',
    recommendation:
      'Expose a readiness endpoint that succeeds only once the model is loaded, and point the readiness probe at it.',
    whyItMatters: 'Determines whether a rolling deployment drops requests.'
  },
  'serving.modelLoadedAtStartup': {
    id: 'ML-STARTUP-LOAD',
    category: 'model-serving',
    title: 'Model is loaded at startup rather than per request',
    severity: 'critical',
    confidence: 'high',
    impact:
      'Loading the model inside the request path adds the full load time to every request and multiplies memory use under concurrency. For a large model this is the difference between tens of milliseconds and several seconds per request.',
    recommendation:
      'Load the model once at process startup, hold it on application state, and gate readiness on the load completing.',
    whyItMatters:
      'Determines the latency and memory profile of the service under any real traffic.'
  },
  'serving.inputValidation': {
    id: 'ML-INPUT-VALIDATION',
    category: 'model-serving',
    title: 'Request input is validated against a schema',
    severity: 'high',
    confidence: 'high',
    impact:
      'Unvalidated input reaching a preprocessing or tensor-construction path surfaces as a 500 rather than a 400, and a malformed shape can allocate unbounded memory.',
    recommendation:
      'Define a request schema constraining types, presence, array lengths, and value ranges, and reject anything that does not match with a 4xx.',
    whyItMatters: 'Determines whether malformed input degrades the service or is rejected cleanly.'
  },
  'serving.authentication': {
    id: 'ML-AUTH',
    category: 'security',
    title: 'Inference endpoint requires authentication',
    severity: 'high',
    confidence: 'medium',
    impact:
      'An unauthenticated inference endpoint can be called by anyone who can reach it. For a model that was expensive to train, this permits extraction through systematic querying, and it makes the compute cost of serving unbounded.',
    recommendation:
      'Require authentication on the inference endpoint, or place it behind a gateway that does. If the endpoint is intentionally public, record that decision and rely on rate limiting and quota.',
    whyItMatters:
      'Determines who can consume inference capacity and query the model. If the endpoint is only reachable inside a private network, this may be satisfied at the network layer.'
  },
  'serving.rateLimiting': {
    id: 'ML-RATE-LIMIT',
    category: 'security',
    title: 'Rate limiting is applied to inference',
    severity: 'medium',
    confidence: 'high',
    impact:
      'Without a rate limit, one caller can consume the whole inference capacity. Inference is expensive per request, so the volume needed to exhaust it is far lower than for a conventional API.',
    recommendation:
      'Apply a per-caller rate limit and a global concurrency limit, and shed load with a 429 rather than queueing without bound.',
    whyItMatters: 'Determines whether one caller can deny service to the rest.'
  },
  'serving.timeoutHandling': {
    id: 'ML-TIMEOUT',
    category: 'model-serving',
    title: 'Inference timeouts are handled',
    severity: 'medium',
    confidence: 'high',
    impact:
      'A pathological input or a stalled accelerator call holds a worker indefinitely, and under load the whole pool can be consumed by requests that will never complete.',
    recommendation:
      'Apply a bounded timeout to the inference call and return a 503 or 504 when it is exceeded.',
    whyItMatters: 'Determines whether a single slow request can exhaust the worker pool.'
  },

  'monitoring.logging': {
    id: 'ML-LOGGING',
    category: 'observability',
    title: 'Application logging is in place',
    severity: 'high',
    confidence: 'high',
    impact:
      'Without logs, a production failure leaves no record beyond the orchestrator restart count.',
    recommendation:
      'Emit structured log records to standard output with a request identifier, the endpoint, the outcome, and the model version.',
    whyItMatters: 'Determines whether a production incident can be investigated at all.'
  },
  'monitoring.metrics': {
    id: 'ML-METRICS',
    category: 'observability',
    title: 'Request metrics are exported',
    severity: 'medium',
    confidence: 'high',
    impact:
      'Without request rate, error rate, and duration, an incident is detected by a user report rather than an alert.',
    recommendation:
      'Export request count, error count, and duration per endpoint, and alert on error rate and a latency percentile.',
    whyItMatters: 'Determines whether a degradation is noticed before users report it.'
  },
  'monitoring.latencyTracking': {
    id: 'ML-LATENCY',
    category: 'observability',
    title: 'Inference latency is tracked',
    severity: 'medium',
    confidence: 'high',
    impact:
      'Inference latency is the metric most likely to move when a model, batch size, or hardware target changes. Without it, a regression is only noticed downstream.',
    recommendation:
      'Measure inference duration separately from total request duration, export it as a histogram, and alert on a high percentile.',
    whyItMatters: 'Determines whether a model change that slowed inference is detected.'
  },
  'monitoring.errorTracking': {
    id: 'ML-ERROR-TRACKING',
    category: 'observability',
    title: 'Errors are tracked',
    severity: 'low',
    confidence: 'high',
    impact:
      'Exceptions visible only in logs mean a new failure mode is easy to miss until it is frequent.',
    recommendation:
      'Report unhandled exceptions to an error tracker, or alert on error-level log rate.',
    whyItMatters: 'Determines whether a new failure mode surfaces on its first occurrences.'
  },
  'monitoring.modelDriftMonitoring': {
    id: 'ML-DRIFT',
    category: 'observability',
    title: 'Model drift is monitored',
    severity: 'medium',
    confidence: 'high',
    impact:
      'Application monitoring reports whether the service is up and fast, not whether the model is still right. A model whose input distribution has moved continues returning confident predictions at normal latency while real accuracy falls, and no application dashboard shows that.',
    recommendation:
      'Record input and prediction distributions in production, compare them against the training reference, and alert on a material shift. Where ground truth arrives later, track realized accuracy.',
    whyItMatters:
      'Determines whether a silently degrading model is detected. This is the failure mode that application monitoring cannot see.'
  }
};

/** Reads a nested boolean, returning undefined when absent. */
function readFlag(input: CheckMlProjectInput, path: string): boolean | undefined {
  const [group, field] = path.split('.');
  if (!group || !field) return undefined;
  const section = (input as unknown as Record<string, unknown>)[group];
  if (!section || typeof section !== 'object') return undefined;
  const value = (section as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : undefined;
}

export function runMlCheck(input: CheckMlProjectInput): MlCheckResult {
  const checks: CheckItem[] = [];
  const findings: Finding[] = [];
  const unknowns: Array<{ check: string; category: string; whyItMatters: string }> = [];

  for (const [path, def] of Object.entries(CHECKS)) {
    const value = readFlag(input, path);

    if (value === undefined) {
      checks.push({
        id: def.id,
        category: def.category,
        title: def.title,
        status: 'UNKNOWN'
      });
      unknowns.push({
        check: def.title,
        category: def.category,
        whyItMatters: def.whyItMatters
      });
      continue;
    }

    if (value) {
      checks.push({
        id: def.id,
        category: def.category,
        title: def.title,
        status: 'PASS'
      });
      continue;
    }

    checks.push({
      id: def.id,
      category: def.category,
      title: def.title,
      status: 'FAIL',
      impact: def.impact,
      recommendation: def.recommendation,
      severity: def.severity
    });

    findings.push({
      id: def.id,
      severity: def.severity,
      category: def.category,
      title: `${def.title} — declared as not in place`,
      description: def.impact,
      recommendation: def.recommendation,
      confidence: def.confidence
    });
  }

  const answered = checks.filter((c) => c.status === 'PASS' || c.status === 'FAIL').length;
  const unknownCount = checks.filter((c) => c.status === 'UNKNOWN').length;
  const passCount = checks.filter((c) => c.status === 'PASS').length;

  // The score is computed only over answered checks, weighted by severity.
  // When nothing was answered, the score is null rather than zero: COUE has no
  // basis to judge, which is different from judging the project poorly.
  const SEVERITY_POINTS: Record<Severity, number> = {
    critical: 5,
    high: 4,
    medium: 2,
    low: 1,
    info: 0
  };

  let earned = 0;
  let possible = 0;
  for (const check of checks) {
    if (check.status !== 'PASS' && check.status !== 'FAIL') continue;
    const def = Object.values(CHECKS).find((d) => d.id === check.id);
    if (!def) continue;
    const points = SEVERITY_POINTS[def.severity];
    possible += points;
    if (check.status === 'PASS') earned += points;
  }

  const score = possible > 0 ? Math.round((earned / possible) * 100) : null;

  const summaryParts: string[] = [];
  if (score === null) {
    summaryParts.push(
      'No readiness score could be computed because no check was answered. Every field was omitted, and COUE reports an omitted field as UNKNOWN rather than assuming it is absent.'
    );
  } else {
    summaryParts.push(
      `${passCount} of ${answered} answered checks pass, giving ${score}/100 across what was declared (${statusForScore(score).toLowerCase()}).`
    );
  }

  if (unknownCount > 0) {
    summaryParts.push(
      `${unknownCount} of ${checks.length} checks could not be evaluated because the corresponding field was not supplied. These are reported as UNKNOWN and are excluded from the score; they are not counted as failures.`
    );
  }

  const failedChecks = checks.filter((c) => c.status === 'FAIL');
  if (failedChecks.length > 0) {
    const criticalOrHigh = failedChecks.filter(
      (c) => c.severity === 'critical' || c.severity === 'high'
    );
    if (criticalOrHigh.length > 0) {
      summaryParts.push(
        `${criticalOrHigh.length} of the failing checks ${criticalOrHigh.length === 1 ? 'is' : 'are'} critical or high severity.`
      );
    }
  }

  const severityRank: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4
  };

  const recommendations = [...failedChecks]
    .sort((a, b) => severityRank[a.severity ?? 'info'] - severityRank[b.severity ?? 'info'])
    .slice(0, 5)
    .map((c) => c.recommendation ?? '')
    .filter(Boolean);

  return {
    score,
    status: score === null ? 'Not Assessed' : statusForScore(score),
    summary: summaryParts.join(' '),
    disclaimer: SCORE_DISCLAIMER,
    declared: {
      framework: input.framework ?? 'UNKNOWN',
      modelType: input.modelType ?? 'UNKNOWN',
      servingFramework: input.serving?.framework ?? 'UNKNOWN'
    },
    coverage: {
      totalChecks: checks.length,
      answered,
      unknown: unknownCount,
      notApplicable: checks.filter((c) => c.status === 'NOT_APPLICABLE').length
    },
    checks,
    findings,
    unknowns,
    recommendations
  };
}

import { emptyResult, makeFinding, type AnalyzerResult } from './findings.js';
import {
  hasMlFramework,
  isJsTs,
  isPython,
  isTestFile,
  type ProjectProfile
} from './project-detector.js';

/**
 * Observability analysis.
 *
 * COUE distinguishes two layers:
 *
 *   - *application* observability: logs, request metrics, latency, errors.
 *     These tell you whether the service is up and fast.
 *   - *model* observability: prediction distributions, input drift, confidence
 *     tracking, ground-truth feedback. These tell you whether the model is
 *     still right.
 *
 * The presence of the first is never treated as evidence of the second. A
 * service can be perfectly healthy by every application metric while serving
 * steadily worse predictions.
 */

const LOGGING_PATTERNS: Array<{ pattern: RegExp; label: string; structured: boolean }> = [
  { pattern: /\bimport\s+structlog\b|\bfrom\s+structlog\b/, label: 'structlog', structured: true },
  { pattern: /\bpython-json-logger\b|\bjsonlogger\b/, label: 'python-json-logger', structured: true },
  { pattern: /\bfrom\s+loguru\b|\bimport\s+loguru\b/, label: 'loguru', structured: true },
  { pattern: /\bfrom\s+["']pino["']|\brequire\(\s*["']pino["']/, label: 'pino', structured: true },
  { pattern: /\bfrom\s+["']winston["']|\brequire\(\s*["']winston["']/, label: 'winston', structured: true },
  { pattern: /\bfrom\s+["']bunyan["']|\brequire\(\s*["']bunyan["']/, label: 'bunyan', structured: true },
  { pattern: /\bimport\s+logging\b|\bfrom\s+logging\b/, label: 'the standard logging module', structured: false }
];

const METRICS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bprometheus_client\b|\bfrom\s+prometheus_client\b/, label: 'Prometheus client' },
  { pattern: /\bprom-client\b|\bfrom\s+["']prom-client["']/, label: 'prom-client' },
  { pattern: /\bopentelemetry\b|\bfrom\s+["']@opentelemetry\//, label: 'OpenTelemetry' },
  { pattern: /\bstatsd\b|\bdatadog\b|\bddtrace\b/, label: 'StatsD or Datadog' },
  { pattern: /\bInstrumentator\s*\(|\bprometheus_fastapi_instrumentator\b/, label: 'FastAPI Prometheus instrumentator' },
  { pattern: /\bCounter\s*\(|\bHistogram\s*\(|\bGauge\s*\(|\bSummary\s*\(/, label: 'metric instruments' }
];

const ERROR_TRACKING_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsentry_sdk\b|\bfrom\s+["']@sentry\//, label: 'Sentry' },
  { pattern: /\brollbar\b/, label: 'Rollbar' },
  { pattern: /\bbugsnag\b/, label: 'Bugsnag' },
  { pattern: /\bhoneybadger\b/, label: 'Honeybadger' },
  { pattern: /\bopentelemetry.*trace\b/, label: 'OpenTelemetry tracing' }
];

const LATENCY_PATTERNS = [
  /\btime\.perf_counter\s*\(/,
  /\btime\.monotonic\s*\(/,
  /\btime\.time\s*\(\)[\s\S]{0,200}?\btime\.time\s*\(\)/,
  /\bHistogram\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bDate\.now\s*\(\)[\s\S]{0,200}?\bDate\.now\s*\(\)/,
  /\blatency\b/i,
  /\bduration_seconds\b/,
  /\bprocess_time\b/,
  /\belapsed\b/i
];

/** Model-observability signals. Deliberately specific. */
const DRIFT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bevidently\b/i, label: 'Evidently' },
  { pattern: /\bwhylogs\b|\bwhylabs\b/i, label: 'WhyLabs' },
  { pattern: /\balibi_detect\b|\balibi-detect\b/i, label: 'Alibi Detect' },
  { pattern: /\bnannyml\b/i, label: 'NannyML' },
  { pattern: /\bdeepchecks\b/i, label: 'Deepchecks' },
  { pattern: /\barize\b/i, label: 'Arize' },
  { pattern: /\bfiddler\b/i, label: 'Fiddler' },
  { pattern: /\bdata_drift\b|\bdrift_detect|\bdrift_score\b|\bpopulation_stability|\bpsi_score\b/i, label: 'a drift computation' },
  { pattern: /\bkolmogorov|\bks_2samp\b|\bwasserstein_distance\b|\bjensen_shannon\b/i, label: 'a distribution-distance computation' }
];

const PREDICTION_LOGGING_PATTERNS = [
  /\blog_prediction\b/i,
  /\bprediction_log\b/i,
  /\blog.*\bprediction\b/i,
  /\bconfidence\b[\s\S]{0,80}\blog\b/i,
  /\bpredictions?_table\b/i,
  /\binference_log\b/i
];

export function analyzeObservability(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();

  const codeFiles = profile.files.filter((f) => (isPython(f) || isJsTs(f)) && !isTestFile(f));
  if (codeFiles.length === 0) {
    result.unknown.push({
      id: 'OBS-PRESENT',
      category: 'observability',
      title: 'Observability configuration',
      reason: 'No application source was included in the analyzed files.'
    });
    return result;
  }

  const combined = codeFiles.map((f) => f.content).join('\n');
  const isMlProject = hasMlFramework(profile);
  const serves = profile.servesHttp;

  // --- Logging ---
  const logging = LOGGING_PATTERNS.find((l) => l.pattern.test(combined));
  const usesPrint = /^\s*print\s*\(/m.test(combined) || /\bconsole\.log\s*\(/.test(combined);

  if (!logging) {
    result.findings.push(
      makeFinding({
        id: 'OBS-NO-LOGGING',
        severity: usesPrint ? 'high' : 'medium',
        category: 'observability',
        title: usesPrint
          ? 'Application writes to standard output instead of using a logger'
          : 'No logging configuration was detected',
        description: usesPrint
          ? 'Output is written with print or console.log rather than through a logging library. These calls carry no level, no timestamp, and no request correlation, so they cannot be filtered or routed, and they cannot be turned down under load.'
          : 'No logging library was detected in the analyzed files. Without logs, a production failure leaves no record beyond the orchestrator restart count.',
        recommendation:
          'Adopt a logging library configured to emit structured records to standard output, include a request or correlation identifier on every record, and let the platform collect them.',
        confidence: 'medium'
      })
    );
  } else if (!logging.structured) {
    result.findings.push(
      makeFinding({
        id: 'OBS-UNSTRUCTURED-LOGGING',
        severity: 'low',
        category: 'observability',
        title: 'Logging is present but does not appear to be structured',
        description:
          `Logging uses ${logging.label}. Free-text log lines are hard to query in aggregate: filtering by model version, by endpoint, or by outcome requires parsing message strings rather than reading fields.`,
        recommendation:
          'Configure a JSON formatter and attach context as fields (request id, model version, endpoint, latency, outcome) rather than interpolating them into the message.',
        confidence: 'medium'
      })
    );
  } else {
    result.passed.push({
      id: 'OBS-STRUCTURED-LOGGING',
      category: 'observability',
      title: `Structured logging is configured (${logging.label})`
    });
  }

  // --- Metrics ---
  const metrics = METRICS_PATTERNS.find((m) => m.pattern.test(combined));
  if (metrics) {
    result.passed.push({
      id: 'OBS-METRICS',
      category: 'observability',
      title: `Metrics instrumentation is present (${metrics.label})`
    });
  } else if (serves) {
    result.findings.push(
      makeFinding({
        id: 'OBS-NO-METRICS',
        severity: 'medium',
        category: 'observability',
        title: 'No request metrics instrumentation was detected',
        description:
          'No metrics client or instrumentation was found in the analyzed files. Without request rate, error rate, and duration, an incident is detected by a user report rather than by an alert, and a capacity decision has no data behind it.',
        recommendation:
          'Export request count, error count, and request duration per endpoint, and alert on error rate and on a latency percentile rather than on an average.',
        confidence: 'medium'
      })
    );
  }

  // --- Latency tracking ---
  const tracksLatency = LATENCY_PATTERNS.some((p) => p.test(combined));
  if (tracksLatency) {
    result.passed.push({
      id: 'OBS-LATENCY',
      category: 'observability',
      title: 'Latency measurement is present'
    });
  } else if (serves) {
    result.findings.push(
      makeFinding({
        id: 'OBS-NO-LATENCY',
        severity: 'medium',
        category: 'observability',
        title: 'No inference latency measurement was detected',
        description:
          'Nothing in the analyzed files measures how long inference takes. Inference latency is the metric most likely to move when a model, a batch size, or a hardware target changes, and without it a regression is only noticed downstream.',
        recommendation:
          'Measure inference duration separately from total request duration, export it as a histogram, and alert on a high percentile.',
        confidence: 'medium'
      })
    );
  }

  // --- Error tracking ---
  const errorTracking = ERROR_TRACKING_PATTERNS.find((e) => e.pattern.test(combined));
  if (errorTracking) {
    result.passed.push({
      id: 'OBS-ERROR-TRACKING',
      category: 'observability',
      title: `Error tracking is configured (${errorTracking.label})`
    });
  } else if (serves) {
    result.findings.push(
      makeFinding({
        id: 'OBS-NO-ERROR-TRACKING',
        severity: 'low',
        category: 'observability',
        title: 'No error tracking integration was detected',
        description:
          'No error-reporting integration was found. Exceptions are then visible only in logs, where a new failure mode is easy to miss until it is frequent.',
        recommendation:
          'Send unhandled exceptions to an error tracker, or alert on an error-level log rate, so a new failure mode surfaces on its first occurrences.',
        confidence: 'medium'
      })
    );
  }

  // --- Model observability: drift ---
  const drift = DRIFT_PATTERNS.find((d) => d.pattern.test(combined));
  if (drift) {
    result.passed.push({
      id: 'OBS-DRIFT',
      category: 'observability',
      title: `Model drift monitoring is configured (${drift.label})`
    });
  } else if (isMlProject && serves) {
    result.findings.push(
      makeFinding({
        id: 'OBS-NO-DRIFT',
        severity: 'medium',
        category: 'observability',
        title: 'No model drift monitoring configuration was detected in the analyzed files',
        description:
          'No drift detection or input-distribution monitoring was found. Application monitoring answers whether the service is up and fast; it does not answer whether the model is still accurate. A model whose input distribution has moved away from its training data continues to return confident predictions at normal latency while its real accuracy falls, and nothing in a standard application dashboard shows that.',
        recommendation:
          'Record input feature distributions and prediction distributions in production, compare them periodically against the training reference, and alert on a material shift. Where ground truth arrives later, close the loop and track realized accuracy over time.',
        confidence: 'high'
      })
    );
  }

  // --- Model observability: prediction logging ---
  const logsPredictions = PREDICTION_LOGGING_PATTERNS.some((p) => p.test(combined));
  if (logsPredictions) {
    result.passed.push({
      id: 'OBS-PREDICTION-LOGGING',
      category: 'observability',
      title: 'Prediction outcomes are recorded'
    });
  } else if (isMlProject && serves) {
    result.findings.push(
      makeFinding({
        id: 'OBS-NO-PREDICTION-LOGGING',
        severity: 'medium',
        category: 'observability',
        title: 'No prediction logging was detected',
        description:
          'Predictions do not appear to be recorded with their inputs and confidence. Without that record there is no dataset to investigate a disputed prediction, to measure realized accuracy once ground truth arrives, or to build the next training set from real traffic.',
        recommendation:
          'Record a sampled, privacy-reviewed record of each prediction with its model version, confidence, and latency. Apply the same retention and minimization rules as any other record of user data.',
        confidence: 'medium'
      })
    );
  }

  // --- Explicit statement about what application observability does not cover ---
  if (isMlProject && (metrics || logging) && !drift) {
    result.unknown.push({
      id: 'OBS-MODEL-QUALITY',
      category: 'observability',
      title: 'Production model quality',
      reason:
        'Application observability was detected, but it does not report model quality. COUE found no signal that would reveal a drop in accuracy while the service continues to respond normally.'
    });
  }

  return result;
}

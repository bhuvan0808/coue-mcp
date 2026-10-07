import type { CompareModelsInput } from '../schemas/models.js';
import { errors } from '../utils/errors.js';
import { LIMITS, safeRecord } from '../utils/limits.js';

/**
 * Model comparison.
 *
 * Deterministic ranking of caller-supplied model configurations under an
 * explicitly selected optimization criterion. COUE never claims a model is
 * universally best: a recommendation is always qualified by the criterion it
 * was produced under, and when the supplied metrics cannot support a
 * meaningful recommendation, COUE says so instead of producing one.
 */

export type OptimizeFor = 'accuracy' | 'latency' | 'memory' | 'balanced';

/** Metric names where a lower value is better. */
const LOWER_IS_BETTER = new Set([
  'loss',
  'val_loss',
  'test_loss',
  'train_loss',
  'error',
  'error_rate',
  'mse',
  'rmse',
  'mae',
  'mape',
  'perplexity',
  'wer',
  'cer',
  'fid',
  'eer',
  'brier',
  'log_loss',
  'logloss'
]);

/** Metric names commonly used as the primary quality measure, in preference order. */
const PRIMARY_METRIC_PREFERENCE = [
  'f1',
  'f1_score',
  'accuracy',
  'acc',
  'auc',
  'roc_auc',
  'map',
  'map50',
  'precision',
  'recall',
  'r2',
  'bleu',
  'rouge',
  'ndcg'
];

export function isLowerBetter(metricName: string): boolean {
  return LOWER_IS_BETTER.has(metricName.toLowerCase());
}

export interface ModelRanking {
  rank: number;
  name: string;
  /** Composite score under the selected criterion, 0-100. */
  score: number;
  primaryMetricValue: number | null;
  latencyMs: number | null;
  memoryMb: number | null;
  modelSizeMb: number | null;
  throughput: number | null;
  /** What this model is good and bad at relative to the others. */
  tradeoffs: string[];
}

export interface MetricComparison {
  metric: string;
  direction: 'higher is better' | 'lower is better';
  /** Present on every model, so the comparison is meaningful. */
  complete: boolean;
  best: { name: string; value: number } | null;
  worst: { name: string; value: number } | null;
  spreadPercent: number | null;
}

export interface CompareResult {
  optimizedFor: OptimizeFor;
  primaryMetric: string | null;
  modelsCompared: number;
  ranking: ModelRanking[];
  metricComparison: MetricComparison[];
  recommendation: {
    model: string | null;
    rationale: string;
    /** Always present, so the qualification travels with the result. */
    qualification: string;
  };
  caveats: string[];
  /** Set when the supplied metrics cannot support a recommendation. */
  insufficientMetrics: boolean;
}

interface NormalizedModel {
  name: string;
  metrics: Map<string, number>;
  latencyMs: number | null;
  memoryMb: number | null;
  modelSizeMb: number | null;
  throughput: number | null;
}

function normalize(input: CompareModelsInput): NormalizedModel[] {
  return input.models.map((m) => {
    const metrics = new Map<string, number>();
    const safe = safeRecord(m.metrics as Record<string, unknown>);
    let count = 0;
    for (const [key, value] of Object.entries(safe)) {
      if (count >= LIMITS.MAX_METRICS_PER_MODEL) break;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      metrics.set(key, value);
      count++;
    }
    return {
      name: m.name,
      metrics,
      latencyMs: m.latencyMs ?? null,
      memoryMb: m.memoryMb ?? null,
      modelSizeMb: m.modelSizeMb ?? null,
      throughput: m.throughput ?? null
    };
  });
}

/** Picks the primary metric: the caller's choice, or a common well-known one. */
function selectPrimaryMetric(models: NormalizedModel[], requested?: string): string | null {
  const presentOnAll = (name: string): boolean => models.every((m) => m.metrics.has(name));

  if (requested) {
    return presentOnAll(requested) ? requested : null;
  }

  const lowerCaseIndex = new Map<string, string>();
  for (const m of models) {
    for (const key of m.metrics.keys()) {
      if (!lowerCaseIndex.has(key.toLowerCase())) lowerCaseIndex.set(key.toLowerCase(), key);
    }
  }

  for (const preferred of PRIMARY_METRIC_PREFERENCE) {
    const actual = lowerCaseIndex.get(preferred);
    if (actual && presentOnAll(actual)) return actual;
  }

  // Fall back to any metric present on every model.
  const first = models[0];
  if (!first) return null;
  for (const key of first.metrics.keys()) {
    if (presentOnAll(key)) return key;
  }

  return null;
}

/**
 * Scales a set of values to 0-1 where 1 is best.
 * Returns an empty map when fewer than two distinct values exist.
 */
function scaleToUnit(
  values: Array<{ name: string; value: number | null }>,
  lowerIsBetter: boolean
): Map<string, number> {
  const out = new Map<string, number>();
  const present = values.filter((v): v is { name: string; value: number } => v.value !== null);
  if (present.length === 0) return out;

  const numbers = present.map((p) => p.value);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);

  for (const p of present) {
    if (max === min) {
      out.set(p.name, 1);
      continue;
    }
    const unit = (p.value - min) / (max - min);
    out.set(p.name, lowerIsBetter ? 1 - unit : unit);
  }

  return out;
}

/** Weights per optimization criterion: [quality, latency, memory]. */
const CRITERION_WEIGHTS: Record<OptimizeFor, { quality: number; latency: number; memory: number }> = {
  accuracy: { quality: 1.0, latency: 0.0, memory: 0.0 },
  latency: { quality: 0.25, latency: 0.75, memory: 0.0 },
  memory: { quality: 0.25, latency: 0.0, memory: 0.75 },
  balanced: { quality: 0.5, latency: 0.3, memory: 0.2 }
};

export function compareModels(input: CompareModelsInput): CompareResult {
  if (input.models.length > LIMITS.MAX_MODELS) {
    throw errors.tooManyModels(input.models.length, LIMITS.MAX_MODELS);
  }

  const models = normalize(input);
  const optimizeFor: OptimizeFor = input.optimizeFor ?? 'balanced';
  const primaryMetric = selectPrimaryMetric(models, input.primaryMetric);
  const caveats: string[] = [];

  // --- Metric comparison table ---
  const allMetricNames = new Set<string>();
  for (const m of models) for (const key of m.metrics.keys()) allMetricNames.add(key);

  const metricComparison: MetricComparison[] = [];
  for (const metric of [...allMetricNames].sort()) {
    const lower = isLowerBetter(metric);
    const values = models
      .map((m) => ({ name: m.name, value: m.metrics.get(metric) }))
      .filter((v): v is { name: string; value: number } => v.value !== undefined);

    const complete = values.length === models.length;
    if (values.length === 0) continue;

    const sorted = [...values].sort((a, b) => (lower ? a.value - b.value : b.value - a.value));
    const best = sorted[0] ?? null;
    const worst = sorted[sorted.length - 1] ?? null;

    let spreadPercent: number | null = null;
    if (best && worst && worst.value !== 0) {
      spreadPercent = Math.round(Math.abs((best.value - worst.value) / Math.abs(worst.value)) * 1000) / 10;
    }

    metricComparison.push({
      metric,
      direction: lower ? 'lower is better' : 'higher is better',
      complete,
      best,
      worst,
      spreadPercent
    });

    if (!complete) {
      caveats.push(
        `Metric "${metric}" is not reported for every model, so it was excluded from the ranking.`
      );
    }
  }

  // --- Determine whether a recommendation is supportable ---
  const hasLatency = models.filter((m) => m.latencyMs !== null).length === models.length;
  const hasMemory =
    models.filter((m) => m.memoryMb !== null || m.modelSizeMb !== null).length === models.length;

  let insufficient = false;
  const insufficiencyReasons: string[] = [];

  if (primaryMetric === null) {
    insufficient = true;
    insufficiencyReasons.push(
      input.primaryMetric
        ? `the requested primary metric "${input.primaryMetric}" is not reported for every model`
        : 'no quality metric is reported for every model, so the models cannot be compared on quality'
    );
  }

  if (optimizeFor === 'latency' && !hasLatency) {
    insufficient = true;
    insufficiencyReasons.push(
      'latency optimization was requested but latencyMs is not reported for every model'
    );
  }

  if (optimizeFor === 'memory' && !hasMemory) {
    insufficient = true;
    insufficiencyReasons.push(
      'memory optimization was requested but neither memoryMb nor modelSizeMb is reported for every model'
    );
  }

  // --- Composite scoring ---
  const qualityScale = primaryMetric
    ? scaleToUnit(
        models.map((m) => ({ name: m.name, value: m.metrics.get(primaryMetric) ?? null })),
        isLowerBetter(primaryMetric)
      )
    : new Map<string, number>();

  const latencyScale = scaleToUnit(
    models.map((m) => ({ name: m.name, value: m.latencyMs })),
    true
  );

  const memoryScale = scaleToUnit(
    models.map((m) => ({
      name: m.name,
      value: m.memoryMb ?? m.modelSizeMb
    })),
    true
  );

  const weights = CRITERION_WEIGHTS[optimizeFor];

  const scored = models.map((m) => {
    const components: Array<{ weight: number; value: number }> = [];
    const quality = qualityScale.get(m.name);
    const latency = latencyScale.get(m.name);
    const memory = memoryScale.get(m.name);

    if (weights.quality > 0 && quality !== undefined) {
      components.push({ weight: weights.quality, value: quality });
    }
    if (weights.latency > 0 && latency !== undefined) {
      components.push({ weight: weights.latency, value: latency });
    }
    if (weights.memory > 0 && memory !== undefined) {
      components.push({ weight: weights.memory, value: memory });
    }

    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    const composite =
      totalWeight > 0
        ? components.reduce((s, c) => s + c.weight * c.value, 0) / totalWeight
        : 0;

    return { model: m, score: Math.round(composite * 1000) / 10 };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.model.name.localeCompare(b.model.name);
  });

  // --- Trade-offs ---
  const bestLatency = models.reduce<NormalizedModel | null>(
    (best, m) =>
      m.latencyMs === null ? best : best === null || m.latencyMs < (best.latencyMs ?? Infinity) ? m : best,
    null
  );
  const bestMemoryValue = (m: NormalizedModel): number | null => m.memoryMb ?? m.modelSizeMb;
  const bestMemory = models.reduce<NormalizedModel | null>((best, m) => {
    const value = bestMemoryValue(m);
    if (value === null) return best;
    const bestValue = best === null ? null : bestMemoryValue(best);
    return bestValue === null || value < bestValue ? m : best;
  }, null);
  const bestQuality = primaryMetric
    ? models.reduce<NormalizedModel | null>((best, m) => {
        const value = m.metrics.get(primaryMetric);
        if (value === undefined) return best;
        if (best === null) return m;
        const bestValue = best.metrics.get(primaryMetric);
        if (bestValue === undefined) return m;
        return isLowerBetter(primaryMetric)
          ? value < bestValue
            ? m
            : best
          : value > bestValue
            ? m
            : best;
      }, null)
    : null;

  const ranking: ModelRanking[] = scored.map((entry, index) => {
    const m = entry.model;
    const tradeoffs: string[] = [];

    if (bestQuality && m.name === bestQuality.name && primaryMetric) {
      tradeoffs.push(`Best ${primaryMetric} of the set.`);
    }
    if (bestLatency && m.name === bestLatency.name) {
      tradeoffs.push('Lowest inference latency of the set.');
    }
    if (bestMemory && m.name === bestMemory.name) {
      tradeoffs.push('Smallest memory or artifact footprint of the set.');
    }

    if (primaryMetric && bestQuality && m.name !== bestQuality.name) {
      const mine = m.metrics.get(primaryMetric);
      const theirs = bestQuality.metrics.get(primaryMetric);
      if (mine !== undefined && theirs !== undefined && theirs !== 0) {
        const deltaPct = Math.round(Math.abs(((mine - theirs) / theirs) * 1000)) / 10;
        if (deltaPct > 0) {
          tradeoffs.push(
            `${deltaPct}% ${isLowerBetter(primaryMetric) ? 'higher' : 'lower'} ${primaryMetric} than ${bestQuality.name}.`
          );
        }
      }
    }

    if (bestLatency && m.latencyMs !== null && m.name !== bestLatency.name && bestLatency.latencyMs) {
      const factor = Math.round((m.latencyMs / bestLatency.latencyMs) * 10) / 10;
      if (factor > 1) tradeoffs.push(`${factor}x the latency of ${bestLatency.name}.`);
    }

    if (tradeoffs.length === 0) tradeoffs.push('No distinguishing strength in the metrics supplied.');

    return {
      rank: index + 1,
      name: m.name,
      score: entry.score,
      primaryMetricValue: primaryMetric ? (m.metrics.get(primaryMetric) ?? null) : null,
      latencyMs: m.latencyMs,
      memoryMb: m.memoryMb,
      modelSizeMb: m.modelSizeMb,
      throughput: m.throughput,
      tradeoffs
    };
  });

  // --- Recommendation ---
  const winner = ranking[0];
  const runnerUp = ranking[1];

  const criterionLabel: Record<OptimizeFor, string> = {
    accuracy: 'maximizing the primary quality metric',
    latency: 'minimizing inference latency while retaining quality',
    memory: 'minimizing memory and artifact footprint while retaining quality',
    balanced: 'balancing quality, latency, and footprint'
  };

  let recommendedModel: string | null = null;
  let rationale: string;

  if (insufficient) {
    rationale =
      'COUE did not produce a recommendation because the metrics supplied cannot support one: ' +
      `${insufficiencyReasons.join('; ')}. Supply the missing values for every model and run the comparison again.`;
  } else if (!winner) {
    rationale = 'No model could be ranked from the input supplied.';
  } else {
    recommendedModel = winner.name;
    const parts: string[] = [];
    parts.push(
      `${winner.name} ranks first under the "${optimizeFor}" criterion, which weights ${criterionLabel[optimizeFor]}.`
    );

    if (primaryMetric && winner.primaryMetricValue !== null) {
      parts.push(`Its ${primaryMetric} is ${winner.primaryMetricValue}.`);
    }
    if (winner.latencyMs !== null) {
      parts.push(`Inference latency is ${winner.latencyMs} ms.`);
    }
    if (runnerUp) {
      const margin = Math.round((winner.score - runnerUp.score) * 10) / 10;
      if (margin < 3) {
        parts.push(
          `${runnerUp.name} scores within ${margin} points, so the two are close enough that the choice should be settled against your actual latency budget and traffic profile rather than on this ranking alone.`
        );
      } else {
        parts.push(`It leads ${runnerUp.name} by ${margin} points on the composite score.`);
      }
    }
    rationale = parts.join(' ');
  }

  // --- Caveats ---
  if (!hasLatency && optimizeFor !== 'accuracy') {
    caveats.push(
      'Inference latency was not supplied for every model, so the ranking reflects quality and footprint only.'
    );
  }
  if (models.some((m) => m.metrics.size === 0)) {
    caveats.push('At least one model was supplied with no quality metrics.');
  }
  caveats.push(
    'The ranking reflects only the numbers supplied. It does not account for evaluation-set representativeness, fairness across subgroups, robustness to distribution shift, serving cost, or licensing.'
  );

  return {
    optimizedFor: optimizeFor,
    primaryMetric,
    modelsCompared: models.length,
    ranking,
    metricComparison,
    recommendation: {
      model: recommendedModel,
      rationale,
      qualification: insufficient
        ? 'No recommendation was made.'
        : `Best under the "${optimizeFor}" optimization criterion, on the metrics supplied. This is not a claim that it is the best model in general.`
    },
    caveats,
    insufficientMetrics: insufficient
  };
}

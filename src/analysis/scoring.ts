import {
  ALL_CATEGORIES,
  type Category,
  type InternalFinding,
  type Severity,
  type UnknownCheck
} from './findings.js';

/**
 * Scoring engine.
 *
 * The score is a transparent, deterministic heuristic. Each category carries a
 * fixed weight; findings deduct from their category's budget according to
 * severity; the category floor is zero, so one badly-served category cannot
 * drive the total negative.
 *
 * Design constraints this encodes:
 *   - A critical finding must move the score materially.
 *   - A single missing optional feature must not destroy the score, so low and
 *     info findings deduct little and deductions within a category saturate.
 *   - A category COUE could not assess is not penalized. Its weight is removed
 *     from the denominator and the score is reported out of what was actually
 *     assessable, so "we could not see it" never reads as "it is broken".
 */

export const CATEGORY_WEIGHTS: Record<Category, number> = {
  security: 20,
  'model-serving': 15,
  dependencies: 15,
  testing: 10,
  reproducibility: 10,
  docker: 10,
  observability: 10,
  deployment: 10
};

/**
 * Deduction per finding, as a fraction of the category weight.
 *
 * A single critical finding removes 60% of its category's budget; two remove
 * almost all of it. Low and info findings are deliberately small.
 */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 0.6,
  high: 0.35,
  medium: 0.18,
  low: 0.07,
  info: 0.0
};

/**
 * Confidence multiplier. A low-confidence finding deducts less, so a heuristic
 * match cannot dominate the score.
 */
const CONFIDENCE_MULTIPLIER = {
  high: 1.0,
  medium: 0.85,
  low: 0.55
} as const;

export type ReadinessStatus =
  | 'Production Ready'
  | 'Mostly Ready'
  | 'Needs Attention'
  | 'High Risk'
  | 'Not Production Ready';

export interface CategoryScore {
  category: Category;
  /** Points earned, rounded, out of `weight`. */
  score: number;
  /** The category's maximum contribution. */
  weight: number;
  /** True when COUE had no basis to assess this category. */
  assessed: boolean;
  findingCount: number;
}

export interface ScoreResult {
  /** 0-100, normalized across assessed categories only. */
  score: number;
  status: ReadinessStatus;
  categories: Record<string, number>;
  categoryDetail: CategoryScore[];
  /** Categories excluded from the score because nothing was assessable. */
  notAssessed: Category[];
  /** Sum of the weights that contributed to the score. */
  assessedWeight: number;
}

export function statusForScore(score: number): ReadinessStatus {
  if (score >= 90) return 'Production Ready';
  if (score >= 75) return 'Mostly Ready';
  if (score >= 60) return 'Needs Attention';
  if (score >= 40) return 'High Risk';
  return 'Not Production Ready';
}

/**
 * A category counts as assessed when at least one finding, passed check, or
 * category-level signal exists for it. A category that produced only
 * "could not determine" unknowns is not assessed.
 */
export interface CategoryEvidence {
  findings: number;
  passed: number;
  /** Unknowns that represent "COUE could not see this at all". */
  blockingUnknowns: number;
}

/**
 * Unknown check ids that mean the whole category was invisible to COUE, rather
 * than one aspect of it being unverifiable.
 */
const CATEGORY_BLOCKING_UNKNOWNS = new Set([
  'DOCKER-PRESENT',
  'SERVE-PRESENT',
  'OBS-PRESENT',
  'DEPLOY-TARGET'
]);

export function buildCategoryEvidence(
  findings: InternalFinding[],
  passedCategories: Category[],
  unknowns: UnknownCheck[]
): Record<Category, CategoryEvidence> {
  const evidence = {} as Record<Category, CategoryEvidence>;
  for (const category of ALL_CATEGORIES) {
    evidence[category] = { findings: 0, passed: 0, blockingUnknowns: 0 };
  }

  for (const f of findings) {
    const entry = evidence[f.category];
    if (entry) entry.findings++;
  }
  for (const c of passedCategories) {
    const entry = evidence[c];
    if (entry) entry.passed++;
  }
  for (const u of unknowns) {
    if (!CATEGORY_BLOCKING_UNKNOWNS.has(u.id)) continue;
    const entry = evidence[u.category];
    if (entry) entry.blockingUnknowns++;
  }

  return evidence;
}

/** Computes the readiness score from findings and per-category evidence. */
export function computeScore(
  findings: InternalFinding[],
  evidence: Record<Category, CategoryEvidence>
): ScoreResult {
  const detail: CategoryScore[] = [];
  const notAssessed: Category[] = [];
  let earned = 0;
  let assessedWeight = 0;

  for (const category of ALL_CATEGORIES) {
    const weight = CATEGORY_WEIGHTS[category];
    const categoryEvidence = evidence[category] ?? { findings: 0, passed: 0, blockingUnknowns: 0 };
    const categoryFindings = findings.filter((f) => f.category === category);

    // A category is assessable unless COUE explicitly could not see it and
    // found nothing in it.
    const assessed =
      categoryEvidence.blockingUnknowns === 0 ||
      categoryEvidence.findings > 0 ||
      categoryEvidence.passed > 0;

    if (!assessed) {
      notAssessed.push(category);
      detail.push({ category, score: 0, weight, assessed: false, findingCount: 0 });
      continue;
    }

    // Deductions saturate: the total fraction removed cannot exceed 1.
    let deductionFraction = 0;
    for (const f of categoryFindings) {
      deductionFraction += SEVERITY_WEIGHT[f.severity] * CONFIDENCE_MULTIPLIER[f.confidence];
    }
    deductionFraction = Math.min(1, deductionFraction);

    const categoryScore = weight * (1 - deductionFraction);

    earned += categoryScore;
    assessedWeight += weight;
    detail.push({
      category,
      score: Math.round(categoryScore * 10) / 10,
      weight,
      assessed: true,
      findingCount: categoryFindings.length
    });
  }

  // Normalize across the categories that were actually assessed. When nothing
  // was assessable the score is 0 and the status reflects that COUE had no
  // basis to judge, which the summary states explicitly.
  const score = assessedWeight > 0 ? Math.round((earned / assessedWeight) * 100) : 0;

  const categories: Record<string, number> = {};
  for (const d of detail) {
    categories[toCamelCase(d.category)] = d.assessed ? Math.round(d.score) : 0;
  }

  return {
    score,
    status: statusForScore(score),
    categories,
    categoryDetail: detail,
    notAssessed,
    assessedWeight
  };
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** The disclaimer that accompanies every score COUE reports. */
export const SCORE_DISCLAIMER =
  "COUE's readiness score is an engineering heuristic derived from static analysis of the files supplied. It is not a security certification, a compliance certification, or a guarantee of production safety.";

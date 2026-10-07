import { describe, expect, it } from 'vitest';

import { runAudit } from '../../src/analysis/audit-service.js';
import { compareModels, isLowerBetter } from '../../src/analysis/compare-models.js';
import { makeFinding, sortFindings, type InternalFinding } from '../../src/analysis/findings.js';
import { runMlCheck } from '../../src/analysis/ml-check-service.js';
import { generateReport } from '../../src/analysis/report-service.js';
import {
  CATEGORY_WEIGHTS,
  buildCategoryEvidence,
  computeScore,
  statusForScore
} from '../../src/analysis/scoring.js';
import { healthyProject } from '../fixtures/projects.js';

describe('scoring', () => {
  it('category weights total 100', () => {
    const total = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('maps scores to the documented status bands', () => {
    expect(statusForScore(100)).toBe('Production Ready');
    expect(statusForScore(90)).toBe('Production Ready');
    expect(statusForScore(89)).toBe('Mostly Ready');
    expect(statusForScore(75)).toBe('Mostly Ready');
    expect(statusForScore(74)).toBe('Needs Attention');
    expect(statusForScore(60)).toBe('Needs Attention');
    expect(statusForScore(59)).toBe('High Risk');
    expect(statusForScore(40)).toBe('High Risk');
    expect(statusForScore(39)).toBe('Not Production Ready');
    expect(statusForScore(0)).toBe('Not Production Ready');
  });

  it('a clean project scores 100', () => {
    const evidence = buildCategoryEvidence(
      [],
      ['security', 'docker', 'testing', 'dependencies', 'model-serving', 'reproducibility', 'observability', 'deployment'],
      []
    );
    expect(computeScore([], evidence).score).toBe(100);
  });

  it('a critical finding moves the score materially', () => {
    const evidence = buildCategoryEvidence([], [...Object.keys(CATEGORY_WEIGHTS)] as never, []);
    const critical: InternalFinding = makeFinding({
      id: 'X',
      severity: 'critical',
      category: 'security',
      title: 't',
      description: 'd',
      recommendation: 'r',
      confidence: 'high'
    });
    const withEvidence = buildCategoryEvidence([critical], [...Object.keys(CATEGORY_WEIGHTS)] as never, []);
    const clean = computeScore([], evidence).score;
    const scored = computeScore([critical], withEvidence).score;
    expect(clean - scored).toBeGreaterThanOrEqual(10);
  });

  it('a single low finding does not destroy the score', () => {
    const low: InternalFinding = makeFinding({
      id: 'X',
      severity: 'low',
      category: 'testing',
      title: 't',
      description: 'd',
      recommendation: 'r',
      confidence: 'high'
    });
    const evidence = buildCategoryEvidence([low], [...Object.keys(CATEGORY_WEIGHTS)] as never, []);
    expect(computeScore([low], evidence).score).toBeGreaterThanOrEqual(99);
  });

  it('deductions saturate so one category cannot go negative', () => {
    const findings: InternalFinding[] = Array.from({ length: 12 }, (_, i) =>
      makeFinding({
        id: `X${i}`,
        severity: 'critical',
        category: 'security',
        title: 't',
        description: 'd',
        recommendation: 'r',
        confidence: 'high'
      })
    );
    const evidence = buildCategoryEvidence(findings, [...Object.keys(CATEGORY_WEIGHTS)] as never, []);
    const result = computeScore(findings, evidence);
    const security = result.categoryDetail.find((c) => c.category === 'security');
    expect(security?.score).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('a low-confidence finding deducts less than a high-confidence one', () => {
    const base = {
      id: 'X',
      severity: 'high' as const,
      category: 'security' as const,
      title: 't',
      description: 'd',
      recommendation: 'r'
    };
    const high = makeFinding({ ...base, confidence: 'high' });
    const low = makeFinding({ ...base, confidence: 'low' });

    const cats = [...Object.keys(CATEGORY_WEIGHTS)] as never;
    const highScore = computeScore([high], buildCategoryEvidence([high], cats, [])).score;
    const lowScore = computeScore([low], buildCategoryEvidence([low], cats, [])).score;
    expect(lowScore).toBeGreaterThan(highScore);
  });

  it('excludes an unassessable category from the score instead of failing it', () => {
    const evidence = buildCategoryEvidence([], ['security'], [
      { id: 'DOCKER-PRESENT', category: 'docker', title: 'x', reason: 'y' }
    ]);
    const result = computeScore([], evidence);
    expect(result.notAssessed).toContain('docker');
    // Security passed and docker was excluded, so the score is not dragged down.
    expect(result.score).toBe(100);
    expect(result.assessedWeight).toBeLessThan(100);
  });

  it('sorts findings by severity then confidence', () => {
    const mk = (severity: InternalFinding['severity'], confidence: InternalFinding['confidence'], id: string) =>
      makeFinding({
        id,
        severity,
        category: 'security',
        title: 't',
        description: 'd',
        recommendation: 'r',
        confidence
      });
    const sorted = sortFindings([
      mk('low', 'high', 'a'),
      mk('critical', 'low', 'b'),
      mk('critical', 'high', 'c'),
      mk('high', 'high', 'd')
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('audit service options', () => {
  it('honours maxFindings and prioritizes severe findings', () => {
    const result = runAudit(healthyProject, { maxFindings: 2 });
    expect(result.findingsReturned).toBeLessThanOrEqual(2);
    const returned = [...result.criticalFindings, ...result.highFindings, ...result.otherFindings];
    expect(returned.length).toBeLessThanOrEqual(2);
  });

  it('defaults to ten findings', () => {
    const result = runAudit(healthyProject);
    expect(result.findingsReturned).toBeLessThanOrEqual(10);
  });

  it('omits passed checks by default and includes them on request', () => {
    expect(runAudit(healthyProject).passedChecks).toBeUndefined();
    const withPassed = runAudit(healthyProject, { includePassedChecks: true });
    expect(withPassed.passedChecks).toBeDefined();
    expect((withPassed.passedChecks ?? []).length).toBeGreaterThan(0);
  });

  it('restricts findings to the requested focus categories', () => {
    const result = runAudit(healthyProject, { focus: ['docker'], maxFindings: 50 });
    const all = [...result.criticalFindings, ...result.highFindings, ...result.otherFindings];
    for (const finding of all) {
      expect(finding.category).toBe('docker');
    }
  });

  it('deduplicates identical findings', () => {
    const result = runAudit(healthyProject, { maxFindings: 50 });
    const all = [...result.criticalFindings, ...result.highFindings, ...result.otherFindings];
    const keys = all.map((f) => `${f.id}::${f.description}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes the heuristic disclaimer on every audit', () => {
    expect(runAudit(healthyProject).disclaimer).toContain('engineering heuristic');
  });
});

describe('check_ml_project', () => {
  it('reports every omitted field as UNKNOWN, never as a failure', () => {
    const result = runMlCheck({});
    expect(result.checks.every((c) => c.status === 'UNKNOWN')).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.score).toBeNull();
    expect(result.status).toBe('Not Assessed');
  });

  it('does not turn an unknown into a false', () => {
    const result = runMlCheck({ trainingPipeline: { modelVersioned: undefined } });
    const check = result.checks.find((c) => c.id === 'ML-MODEL-VERSION');
    expect(check?.status).toBe('UNKNOWN');
  });

  it('records an explicit false as a failure', () => {
    const result = runMlCheck({ trainingPipeline: { modelVersioned: false } });
    const check = result.checks.find((c) => c.id === 'ML-MODEL-VERSION');
    expect(check?.status).toBe('FAIL');
    expect(result.findings.some((f) => f.id === 'ML-MODEL-VERSION')).toBe(true);
  });

  it('records an explicit true as a pass', () => {
    const result = runMlCheck({ trainingPipeline: { modelVersioned: true } });
    expect(result.checks.find((c) => c.id === 'ML-MODEL-VERSION')?.status).toBe('PASS');
    expect(result.score).toBe(100);
  });

  it('scores only over the answered checks', () => {
    const result = runMlCheck({
      serving: { healthEndpoint: true, readinessEndpoint: false }
    });
    expect(result.coverage.answered).toBe(2);
    expect(result.score).not.toBeNull();
    expect(result.coverage.unknown).toBeGreaterThan(0);
  });

  it('reports declared values as UNKNOWN when absent', () => {
    const result = runMlCheck({});
    expect(result.declared.framework).toBe('UNKNOWN');
    expect(result.declared.modelType).toBe('UNKNOWN');
    expect(result.declared.servingFramework).toBe('UNKNOWN');
  });

  it('treats a per-request model load as critical', () => {
    const result = runMlCheck({ serving: { modelLoadedAtStartup: false } });
    const finding = result.findings.find((f) => f.id === 'ML-STARTUP-LOAD');
    expect(finding?.severity).toBe('critical');
  });
});

describe('compare_models', () => {
  const base = [
    { name: 'large', metrics: { accuracy: 0.95 }, latencyMs: 400, memoryMb: 3000 },
    { name: 'medium', metrics: { accuracy: 0.93 }, latencyMs: 120, memoryMb: 900 },
    { name: 'small', metrics: { accuracy: 0.88 }, latencyMs: 25, memoryMb: 200 }
  ];

  it('knows which metrics are better when lower', () => {
    expect(isLowerBetter('loss')).toBe(true);
    expect(isLowerBetter('rmse')).toBe(true);
    expect(isLowerBetter('accuracy')).toBe(false);
  });

  it('ranks by accuracy when optimizing for accuracy', () => {
    const result = compareModels({ models: base, optimizeFor: 'accuracy' });
    expect(result.ranking[0]?.name).toBe('large');
  });

  it('ranks by latency when optimizing for latency', () => {
    const result = compareModels({ models: base, optimizeFor: 'latency' });
    expect(result.ranking[0]?.name).toBe('small');
  });

  it('ranks by footprint when optimizing for memory', () => {
    const result = compareModels({ models: base, optimizeFor: 'memory' });
    expect(result.ranking[0]?.name).toBe('small');
  });

  it('produces a balanced ranking by default', () => {
    const result = compareModels({ models: base });
    expect(result.optimizedFor).toBe('balanced');
    expect(result.ranking).toHaveLength(3);
    expect(result.ranking[0]?.rank).toBe(1);
  });

  it('always qualifies the recommendation rather than claiming a universal best', () => {
    const result = compareModels({ models: base, optimizeFor: 'latency' });
    expect(result.recommendation.qualification).toContain('latency');
    expect(result.recommendation.qualification).toContain('not a claim that it is the best model in general');
  });

  it('declines to recommend when no metric is common to all models', () => {
    const result = compareModels({
      models: [
        { name: 'a', metrics: { accuracy: 0.9 } },
        { name: 'b', metrics: { f1: 0.8 } }
      ]
    });
    expect(result.insufficientMetrics).toBe(true);
    expect(result.recommendation.model).toBeNull();
    expect(result.recommendation.rationale).toContain('did not produce a recommendation');
  });

  it('declines to recommend when latency is requested but not supplied for all', () => {
    const result = compareModels({
      models: [
        { name: 'a', metrics: { accuracy: 0.9 }, latencyMs: 10 },
        { name: 'b', metrics: { accuracy: 0.8 } }
      ],
      optimizeFor: 'latency'
    });
    expect(result.insufficientMetrics).toBe(true);
  });

  it('handles a lower-is-better primary metric', () => {
    const result = compareModels({
      models: [
        { name: 'a', metrics: { rmse: 0.5 } },
        { name: 'b', metrics: { rmse: 0.2 } }
      ],
      primaryMetric: 'rmse',
      optimizeFor: 'accuracy'
    });
    expect(result.ranking[0]?.name).toBe('b');
  });

  it('marks a metric missing from some models as incomplete', () => {
    const result = compareModels({
      models: [
        { name: 'a', metrics: { accuracy: 0.9, f1: 0.8 } },
        { name: 'b', metrics: { accuracy: 0.85 } }
      ]
    });
    const f1 = result.metricComparison.find((m) => m.metric === 'f1');
    expect(f1?.complete).toBe(false);
  });

  it('always returns caveats', () => {
    const result = compareModels({ models: base });
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(result.caveats.join(' ')).toContain('fairness');
  });

  it('is deterministic', () => {
    const a = JSON.stringify(compareModels({ models: base, optimizeFor: 'balanced' }));
    const b = JSON.stringify(compareModels({ models: base, optimizeFor: 'balanced' }));
    expect(a).toBe(b);
  });
});

describe('generate_readiness_report', () => {
  const findings = [
    {
      id: 'A',
      severity: 'critical' as const,
      category: 'security',
      title: 'Credential in source',
      description: 'd',
      recommendation: 'Rotate the credential.',
      confidence: 'high' as const
    },
    {
      id: 'B',
      severity: 'high' as const,
      category: 'docker',
      title: 'Runs as root',
      description: 'd',
      recommendation: 'Add a non-root user.',
      confidence: 'high' as const
    },
    {
      id: 'C',
      severity: 'low' as const,
      category: 'testing',
      title: 'Sparse tests',
      description: 'd',
      recommendation: 'Add tests.',
      confidence: 'low' as const
    }
  ];

  it('handles an empty finding set', () => {
    const result = generateReport({ findings: [], score: 100 });
    expect(result.overallStatus).toBe('Production Ready');
    expect(result.criticalFindings).toHaveLength(0);
    expect(result.reportText).toContain('No findings were supplied');
  });

  it('blocks deployment when a critical finding exists', () => {
    const result = generateReport({ findings, score: 45 });
    expect(result.deploymentRecommendation).toContain('Do not deploy');
  });

  it('produces a summary by default', () => {
    const result = generateReport({ findings, score: 45 });
    expect(result.format).toBe('summary');
    expect(result.allFindings).toBeUndefined();
    expect(result.deploymentChecklist).toBeUndefined();
  });

  it('includes every finding in the detailed format', () => {
    const result = generateReport({ findings, score: 45, format: 'detailed' });
    expect(result.allFindings).toHaveLength(3);
    expect(result.reportText).toContain('Credential in source');
    expect(result.reportText).toContain('Sparse tests');
  });

  it('produces a prioritized checklist with manual items', () => {
    const result = generateReport({ findings, score: 45, format: 'deployment-checklist' });
    expect(result.deploymentChecklist).toBeDefined();
    expect(result.deploymentChecklist?.[0]?.priority).toBe('blocker');
    expect(result.reportText).toContain('Items COUE cannot verify');
    expect(result.reportText).toContain('Rollback procedure has been tested');
  });

  it('counts findings by severity', () => {
    const result = generateReport({ findings, score: 45 });
    expect(result.findingCounts['critical']).toBe(1);
    expect(result.findingCounts['high']).toBe(1);
    expect(result.findingCounts['low']).toBe(1);
  });

  it('carries the disclaimer into every format', () => {
    for (const format of ['summary', 'detailed', 'deployment-checklist'] as const) {
      const result = generateReport({ findings, score: 45, format });
      expect(result.reportText).toContain('engineering heuristic');
    }
  });
});

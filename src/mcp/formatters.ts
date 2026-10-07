import type { AuditResult } from '../analysis/audit-service.js';
import type { CompareResult } from '../analysis/compare-models.js';
import type { Finding } from '../analysis/findings.js';
import type { MlCheckResult } from '../analysis/ml-check-service.js';
import { LIMITS, truncate } from '../utils/limits.js';

/**
 * Text renderers.
 *
 * Every tool returns both structured content and a compact text rendering.
 * Claude reads the text to explain the result; the structured content is there
 * for a caller that wants to work with the data.
 *
 * These renderings are deliberately short. The platform allows roughly 150,000
 * characters per tool result, and COUE aims far below that.
 */

function severityLabel(finding: Finding): string {
  return finding.severity.toUpperCase();
}

function renderFinding(finding: Finding, index: number): string[] {
  const lines: string[] = [];
  lines.push(`${index}. [${severityLabel(finding)}] ${finding.title}`);
  lines.push(`   Category: ${finding.category} · Confidence: ${finding.confidence} · ID: ${finding.id}`);
  lines.push(`   ${finding.description}`);
  if (finding.evidence) {
    lines.push(`   Evidence: ${finding.evidence}`);
  }
  lines.push(`   Fix: ${finding.recommendation}`);
  return lines;
}

export function formatAuditText(result: AuditResult): string {
  const lines: string[] = [];

  lines.push(`COUE Production Readiness Audit`);
  lines.push('='.repeat(32));
  lines.push('');
  lines.push(`Score:  ${result.score}/100`);
  lines.push(`Status: ${result.status}`);
  lines.push('');
  lines.push(result.summary);
  lines.push('');

  // Project context.
  lines.push('Project');
  lines.push('-------');
  lines.push(`Files analyzed: ${result.project.filesAnalyzed}`);
  lines.push(`Ecosystems:     ${result.project.ecosystems.join(', ') || 'not determined'}`);
  if (result.project.frameworksDetected.length > 0) {
    lines.push(
      `Frameworks:     ${result.project.frameworksDetected.map((f) => f.name).join(', ')}`
    );
  } else {
    lines.push('Frameworks:     none detected from imports or dependency declarations');
  }
  lines.push('');

  // Category scores.
  lines.push('Category scores');
  lines.push('---------------');
  const notAssessed = new Set(result.project.categoriesNotAssessed);
  for (const [name, value] of Object.entries(result.categories)) {
    const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase();
    if (notAssessed.has(kebab)) {
      lines.push(`${name.padEnd(16)} not assessed`);
    } else {
      lines.push(`${name.padEnd(16)} ${value}`);
    }
  }
  lines.push('');

  // Findings.
  const counts = result.findingCounts;
  lines.push(
    `Findings: ${result.totalFindings} total ` +
      `(${counts['critical'] ?? 0} critical, ${counts['high'] ?? 0} high, ${counts['medium'] ?? 0} medium, ${counts['low'] ?? 0} low)`
  );
  if (result.findingsReturned < result.totalFindings) {
    lines.push(
      `Showing the ${result.findingsReturned} highest-severity findings. Raise maxFindings to see more.`
    );
  }
  lines.push('');

  let index = 1;
  if (result.criticalFindings.length > 0) {
    lines.push('CRITICAL');
    lines.push('--------');
    for (const f of result.criticalFindings) {
      lines.push(...renderFinding(f, index++));
      lines.push('');
    }
  }

  if (result.highFindings.length > 0) {
    lines.push('HIGH');
    lines.push('----');
    for (const f of result.highFindings) {
      lines.push(...renderFinding(f, index++));
      lines.push('');
    }
  }

  if (result.otherFindings.length > 0) {
    lines.push('OTHER');
    lines.push('-----');
    for (const f of result.otherFindings) {
      lines.push(...renderFinding(f, index++));
      lines.push('');
    }
  }

  if (result.totalFindings === 0) {
    lines.push('No issues were detected in the categories that could be assessed.');
    lines.push('');
  }

  // Top recommendations.
  if (result.recommendations.length > 0) {
    lines.push('Top recommendations');
    lines.push('-------------------');
    result.recommendations.forEach((rec, i) => lines.push(`${i + 1}. ${rec}`));
    lines.push('');
  }

  // Passed checks, when requested.
  if (result.passedChecks && result.passedChecks.length > 0) {
    lines.push('Passed checks');
    lines.push('-------------');
    for (const check of result.passedChecks) {
      lines.push(`PASS  [${check.category}] ${check.title}`);
    }
    lines.push('');
  }

  // Explicit unknowns.
  if (result.couldNotDetermine.length > 0) {
    lines.push('Could not be determined');
    lines.push('-----------------------');
    lines.push(
      'These were not assessed. They are reported as unknown rather than as failures:'
    );
    lines.push('');
    for (const unknown of result.couldNotDetermine) {
      lines.push(`UNKNOWN  [${unknown.category}] ${unknown.check}`);
      lines.push(`         ${unknown.reason}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(result.disclaimer);

  return truncate(lines.join('\n'), LIMITS.MAX_RESULT_CHARS);
}

export function formatMlCheckText(result: MlCheckResult): string {
  const lines: string[] = [];

  lines.push('COUE ML Engineering Check');
  lines.push('='.repeat(32));
  lines.push('');
  lines.push(result.score === null ? 'Score:  not assessed' : `Score:  ${result.score}/100`);
  lines.push(`Status: ${result.status}`);
  lines.push('');
  lines.push(result.summary);
  lines.push('');

  lines.push('Declared');
  lines.push('--------');
  lines.push(`Framework:         ${result.declared.framework}`);
  lines.push(`Model type:        ${result.declared.modelType}`);
  lines.push(`Serving framework: ${result.declared.servingFramework}`);
  lines.push('');

  lines.push('Coverage');
  lines.push('--------');
  lines.push(
    `${result.coverage.answered} of ${result.coverage.totalChecks} checks answered; ${result.coverage.unknown} unknown.`
  );
  lines.push('');

  const failed = result.checks.filter((c) => c.status === 'FAIL');
  const passed = result.checks.filter((c) => c.status === 'PASS');
  const unknown = result.checks.filter((c) => c.status === 'UNKNOWN');

  if (failed.length > 0) {
    lines.push(`FAIL (${failed.length})`);
    lines.push('-'.repeat(12));
    for (const check of failed) {
      lines.push(`[${(check.severity ?? 'info').toUpperCase()}] ${check.title}  (${check.category})`);
      if (check.impact) lines.push(`   Why it matters: ${check.impact}`);
      if (check.recommendation) lines.push(`   Fix: ${check.recommendation}`);
      lines.push('');
    }
  }

  if (passed.length > 0) {
    lines.push(`PASS (${passed.length})`);
    lines.push('-'.repeat(12));
    for (const check of passed) {
      lines.push(`PASS  ${check.title}  (${check.category})`);
    }
    lines.push('');
  }

  if (unknown.length > 0) {
    lines.push(`UNKNOWN (${unknown.length})`);
    lines.push('-'.repeat(12));
    lines.push(
      'These fields were not supplied. COUE reports them as unknown and excludes them from the score; it does not treat them as failures.'
    );
    lines.push('');
    for (const check of unknown) {
      const detail = result.unknowns.find((u) => u.check === check.title);
      lines.push(`UNKNOWN  ${check.title}  (${check.category})`);
      if (detail) lines.push(`         ${detail.whyItMatters}`);
    }
    lines.push('');
  }

  if (result.recommendations.length > 0) {
    lines.push('Top recommendations');
    lines.push('-------------------');
    result.recommendations.forEach((rec, i) => lines.push(`${i + 1}. ${rec}`));
    lines.push('');
  }

  lines.push('---');
  lines.push(result.disclaimer);

  return truncate(lines.join('\n'), LIMITS.MAX_RESULT_CHARS);
}

export function formatCompareText(result: CompareResult): string {
  const lines: string[] = [];

  lines.push('COUE Model Comparison');
  lines.push('='.repeat(32));
  lines.push('');
  lines.push(`Models compared: ${result.modelsCompared}`);
  lines.push(`Optimizing for:  ${result.optimizedFor}`);
  lines.push(`Primary metric:  ${result.primaryMetric ?? 'none common to all models'}`);
  lines.push('');

  lines.push('Ranking');
  lines.push('-------');
  for (const entry of result.ranking) {
    const bits: string[] = [];
    if (entry.primaryMetricValue !== null && result.primaryMetric) {
      bits.push(`${result.primaryMetric}=${entry.primaryMetricValue}`);
    }
    if (entry.latencyMs !== null) bits.push(`${entry.latencyMs}ms`);
    if (entry.memoryMb !== null) bits.push(`${entry.memoryMb}MB mem`);
    if (entry.modelSizeMb !== null) bits.push(`${entry.modelSizeMb}MB size`);
    if (entry.throughput !== null) bits.push(`${entry.throughput}/s`);

    lines.push(`${entry.rank}. ${entry.name}  (composite ${entry.score}/100)`);
    if (bits.length > 0) lines.push(`   ${bits.join(' · ')}`);
    for (const tradeoff of entry.tradeoffs) {
      lines.push(`   - ${tradeoff}`);
    }
    lines.push('');
  }

  if (result.metricComparison.length > 0) {
    lines.push('Metric comparison');
    lines.push('-----------------');
    for (const m of result.metricComparison) {
      const bestText = m.best ? `${m.best.name} (${m.best.value})` : 'n/a';
      const note = m.complete ? '' : '  [not reported for every model]';
      lines.push(`${m.metric} — ${m.direction}; best: ${bestText}${note}`);
    }
    lines.push('');
  }

  lines.push('Recommendation');
  lines.push('--------------');
  if (result.insufficientMetrics) {
    lines.push('No recommendation.');
    lines.push(result.recommendation.rationale);
  } else {
    lines.push(`${result.recommendation.model}`);
    lines.push('');
    lines.push(result.recommendation.rationale);
    lines.push('');
    lines.push(result.recommendation.qualification);
  }
  lines.push('');

  if (result.caveats.length > 0) {
    lines.push('Caveats');
    lines.push('-------');
    for (const caveat of result.caveats) {
      lines.push(`- ${caveat}`);
    }
  }

  return truncate(lines.join('\n'), LIMITS.MAX_RESULT_CHARS);
}

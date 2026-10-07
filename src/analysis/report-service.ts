import type { GenerateReportInput } from '../schemas/reports.js';
import { sortFindings, type Finding, type Severity } from './findings.js';
import { SCORE_DISCLAIMER, statusForScore } from './scoring.js';

/**
 * Readiness report generation.
 *
 * Converts a finding set and a score into one of three shapes: a short
 * summary, a full detailed report, or an ordered pre-deployment checklist.
 */

export type ReportFormat = 'summary' | 'detailed' | 'deployment-checklist';

export interface ChecklistItem {
  order: number;
  /** 'blocker' items should be resolved before deploying. */
  priority: 'blocker' | 'required' | 'recommended' | 'optional';
  category: string;
  action: string;
  rationale: string;
  findingId: string;
}

export interface ReportResult {
  format: ReportFormat;
  overallStatus: string;
  score: number;
  deploymentRecommendation: string;
  disclaimer: string;
  findingCounts: Record<string, number>;
  criticalFindings: Finding[];
  highPriorityFindings: Finding[];
  recommendedActions: string[];
  /** Present for the detailed format. */
  allFindings?: Finding[];
  /** Present for the deployment-checklist format. */
  deploymentChecklist?: ChecklistItem[];
  /** Rendered text, ready for Claude to present. */
  reportText: string;
}

const PRIORITY_FOR_SEVERITY: Record<Severity, ChecklistItem['priority']> = {
  critical: 'blocker',
  high: 'required',
  medium: 'recommended',
  low: 'optional',
  info: 'optional'
};

/** The go/no-go sentence that heads every report. */
function deploymentRecommendation(score: number, criticalCount: number, highCount: number): string {
  if (criticalCount > 0) {
    return `Do not deploy until the ${criticalCount} critical ${criticalCount === 1 ? 'finding is' : 'findings are'} resolved. Critical findings represent issues that are likely to cause an incident or expose a credential.`;
  }
  if (score >= 90 && highCount === 0) {
    return 'No blocking issues were identified in the categories assessed. Proceed with deployment, and confirm the operational items that static analysis cannot verify.';
  }
  if (highCount > 0) {
    return `Deployment is feasible, but resolve the ${highCount} high-severity ${highCount === 1 ? 'finding' : 'findings'} first or accept them explicitly with a documented owner and a date.`;
  }
  if (score >= 75) {
    return 'No critical or high-severity findings were identified. The remaining items are improvements that can be scheduled after deployment.';
  }
  return 'Address the outstanding findings before deployment, or document which ones are being accepted and why.';
}

function renderSummary(result: Omit<ReportResult, 'reportText'>): string {
  const lines: string[] = [];

  lines.push('# Production Readiness Report');
  lines.push('');
  lines.push(`**Status:** ${result.overallStatus}  `);
  lines.push(`**Score:** ${result.score}/100`);
  lines.push('');
  lines.push(result.deploymentRecommendation);
  lines.push('');

  const counts = result.findingCounts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    lines.push('No findings were supplied.');
  } else {
    lines.push(
      `**Findings:** ${counts['critical'] ?? 0} critical, ${counts['high'] ?? 0} high, ${counts['medium'] ?? 0} medium, ${counts['low'] ?? 0} low, ${counts['info'] ?? 0} info.`
    );
  }
  lines.push('');

  if (result.criticalFindings.length > 0) {
    lines.push('## Critical findings');
    lines.push('');
    for (const f of result.criticalFindings) {
      lines.push(`- **${f.title}** (${f.category}) — ${f.recommendation}`);
    }
    lines.push('');
  }

  if (result.highPriorityFindings.length > 0) {
    lines.push('## High-priority findings');
    lines.push('');
    for (const f of result.highPriorityFindings) {
      lines.push(`- **${f.title}** (${f.category}) — ${f.recommendation}`);
    }
    lines.push('');
  }

  if (result.recommendedActions.length > 0) {
    lines.push('## Recommended actions');
    lines.push('');
    result.recommendedActions.forEach((action, i) => lines.push(`${i + 1}. ${action}`));
    lines.push('');
  }

  lines.push('---');
  lines.push(`_${SCORE_DISCLAIMER}_`);

  return lines.join('\n');
}

function renderDetailed(result: Omit<ReportResult, 'reportText'>): string {
  const lines: string[] = [];

  lines.push('# Production Readiness Report (detailed)');
  lines.push('');
  lines.push(`**Status:** ${result.overallStatus}  `);
  lines.push(`**Score:** ${result.score}/100`);
  lines.push('');
  lines.push(result.deploymentRecommendation);
  lines.push('');

  const bySeverity = new Map<Severity, Finding[]>();
  for (const f of result.allFindings ?? []) {
    const existing = bySeverity.get(f.severity) ?? [];
    existing.push(f);
    bySeverity.set(f.severity, existing);
  }

  const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  for (const severity of severityOrder) {
    const group = bySeverity.get(severity);
    if (!group || group.length === 0) continue;

    lines.push(`## ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${group.length})`);
    lines.push('');

    for (const f of group) {
      lines.push(`### ${f.title}`);
      lines.push('');
      lines.push(`- **ID:** \`${f.id}\``);
      lines.push(`- **Category:** ${f.category}`);
      lines.push(`- **Confidence:** ${f.confidence}`);
      lines.push('');
      lines.push(f.description);
      lines.push('');
      if (f.evidence) {
        lines.push(`**Evidence:** \`${f.evidence}\``);
        lines.push('');
      }
      lines.push(`**Recommendation:** ${f.recommendation}`);
      lines.push('');
    }
  }

  if ((result.allFindings ?? []).length === 0) {
    lines.push('No findings were supplied.');
    lines.push('');
  }

  lines.push('---');
  lines.push(`_${SCORE_DISCLAIMER}_`);

  return lines.join('\n');
}

function renderChecklist(result: Omit<ReportResult, 'reportText'>): string {
  const lines: string[] = [];
  const checklist = result.deploymentChecklist ?? [];

  lines.push('# Deployment Readiness Checklist');
  lines.push('');
  lines.push(`**Status:** ${result.overallStatus} — ${result.score}/100`);
  lines.push('');
  lines.push(result.deploymentRecommendation);
  lines.push('');

  const groups: Array<{ key: ChecklistItem['priority']; heading: string; note: string }> = [
    {
      key: 'blocker',
      heading: 'Blockers — resolve before deploying',
      note: 'These findings are likely to cause an incident or expose a credential.'
    },
    {
      key: 'required',
      heading: 'Required — resolve or explicitly accept',
      note: 'Assign an owner and a date to anything accepted rather than fixed.'
    },
    {
      key: 'recommended',
      heading: 'Recommended — schedule after deployment',
      note: ''
    },
    { key: 'optional', heading: 'Optional improvements', note: '' }
  ];

  let any = false;
  for (const group of groups) {
    const items = checklist.filter((i) => i.priority === group.key);
    if (items.length === 0) continue;
    any = true;

    lines.push(`## ${group.heading}`);
    if (group.note) {
      lines.push('');
      lines.push(`_${group.note}_`);
    }
    lines.push('');
    for (const item of items) {
      lines.push(`- [ ] **${item.action}**`);
      lines.push(`  - ${item.rationale}`);
      lines.push(`  - Category: ${item.category} · Finding: \`${item.findingId}\``);
    }
    lines.push('');
  }

  if (!any) {
    lines.push('No outstanding items. No findings were supplied.');
    lines.push('');
  }

  lines.push('## Items COUE cannot verify');
  lines.push('');
  lines.push(
    'Static analysis cannot confirm these. Check them manually before deploying:'
  );
  lines.push('');
  lines.push('- [ ] Rollback procedure has been tested, not just documented');
  lines.push('- [ ] Resource limits were sized against an observed load test, not estimated');
  lines.push('- [ ] On-call owner and escalation path are assigned for this service');
  lines.push('- [ ] Alert thresholds have been verified to fire');
  lines.push('- [ ] Model artifact in the target environment matches the evaluated version');
  lines.push('- [ ] Dependency vulnerability scan has been run against the final image');
  lines.push('');
  lines.push('---');
  lines.push(`_${SCORE_DISCLAIMER}_`);

  return lines.join('\n');
}

export function generateReport(input: GenerateReportInput): ReportResult {
  const format: ReportFormat = input.format ?? 'summary';
  const findings = sortFindings(input.findings as Finding[]);
  const score = Math.round(input.score);

  const counts: Record<string, number> = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    info: findings.filter((f) => f.severity === 'info').length
  };

  const criticalFindings = findings.filter((f) => f.severity === 'critical');
  const highPriorityFindings = findings.filter((f) => f.severity === 'high');

  const recommendedActions: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (recommendedActions.length >= 8) break;
    const key = f.recommendation.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    recommendedActions.push(f.recommendation);
  }

  const base: Omit<ReportResult, 'reportText'> = {
    format,
    overallStatus: statusForScore(score),
    score,
    deploymentRecommendation: deploymentRecommendation(
      score,
      counts['critical'] ?? 0,
      counts['high'] ?? 0
    ),
    disclaimer: SCORE_DISCLAIMER,
    findingCounts: counts,
    criticalFindings,
    highPriorityFindings,
    recommendedActions
  };

  if (format === 'detailed') {
    base.allFindings = findings;
  }

  if (format === 'deployment-checklist') {
    base.deploymentChecklist = findings.map((f, index) => ({
      order: index + 1,
      priority: PRIORITY_FOR_SEVERITY[f.severity],
      category: f.category,
      action: f.recommendation,
      rationale: f.title,
      findingId: f.id
    }));
  }

  let reportText: string;
  if (format === 'detailed') reportText = renderDetailed(base);
  else if (format === 'deployment-checklist') reportText = renderChecklist(base);
  else reportText = renderSummary(base);

  return { ...base, reportText };
}

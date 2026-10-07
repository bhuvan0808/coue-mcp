import { z } from 'zod';
import { LIMITS } from '../utils/limits.js';

/** Input schema for generate_readiness_report. */
export const generateReportShape = {
  findings: z
    .array(
      z.object({
        id: z.string().min(1).max(100).describe('Stable identifier for the finding.'),
        severity: z
          .enum(['critical', 'high', 'medium', 'low', 'info'])
          .describe('Severity of the finding.'),
        category: z.string().min(1).max(60).describe('Category the finding belongs to.'),
        title: z.string().min(1).max(300).describe('Short title.'),
        description: z.string().max(3000).describe('What the issue is.'),
        evidence: z.string().max(1000).optional().describe('Optional supporting detail.'),
        recommendation: z.string().max(2000).describe('What to do about it.'),
        confidence: z
          .enum(['high', 'medium', 'low'])
          .describe('How confident the analysis is in this finding.')
      })
    )
    .max(LIMITS.MAX_REPORT_FINDINGS)
    .describe(
      'The findings to report on, normally taken from a prior audit_project or check_ml_project result. An empty array is valid and produces a report with no outstanding findings.'
    ),

  score: z
    .number()
    .min(0)
    .max(100)
    .describe('The readiness score these findings correspond to, from 0 to 100.'),

  format: z
    .enum(['summary', 'detailed', 'deployment-checklist'])
    .optional()
    .describe(
      'Report shape. "summary" is a short overview, "detailed" includes every finding in full, and "deployment-checklist" produces ordered pre-deployment items. Defaults to "summary".'
    )
};

export const generateReportSchema = z.object(generateReportShape);
export type GenerateReportInput = z.infer<typeof generateReportSchema>;

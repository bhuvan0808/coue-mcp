import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { runAudit } from '../analysis/audit-service.js';
import { compareModels } from '../analysis/compare-models.js';
import { runMlCheck } from '../analysis/ml-check-service.js';
import { generateReport } from '../analysis/report-service.js';
import { auditProjectShape, checkMlProjectShape } from '../schemas/audit.js';
import { compareModelsShape } from '../schemas/models.js';
import { generateReportShape } from '../schemas/reports.js';
import { toCoueError } from '../utils/errors.js';
import { formatAuditText, formatCompareText, formatMlCheckText } from './formatters.js';

export const SERVER_NAME = 'coue';
export const SERVER_VERSION = '1.0.0';

/**
 * Server instructions.
 *
 * This describes what COUE offers. It deliberately does not instruct Claude on
 * when to answer, which tools to prefer over its own reasoning, or how to
 * behave outside the scope of these tools.
 */
const INSTRUCTIONS = [
  'COUE performs static, offline analysis of AI and machine-learning projects for production readiness.',
  '',
  'It analyzes files that are supplied to it in the tool call. It does not read a filesystem, clone a repository, call any external API, or execute submitted code.',
  '',
  'Scores and findings are engineering heuristics derived from the files supplied, not certifications. Where COUE cannot determine something from the files it was given, it reports UNKNOWN rather than assuming the answer is negative.'
].join('\n');

/**
 * Annotations shared by all four tools.
 *
 * Every COUE tool reads its input and returns an analysis. Nothing is
 * persisted, nothing is mutated, and no external system is contacted, so:
 *   readOnlyHint   true  - no tool modifies any state
 *   destructiveHint false - nothing is deleted or overwritten
 *   idempotentHint  true  - the same input always produces the same output
 *   openWorldHint   false - the analysis touches no external system
 */
function readOnlyAnnotations(title: string): {
  title: string;
  readOnlyHint: true;
  destructiveHint: false;
  idempotentHint: true;
  openWorldHint: false;
} {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };
}

/** Wraps a handler so that any failure becomes a clean, actionable tool error. */
function safely(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (err) {
    const coueError = toCoueError(err);
    return {
      isError: true,
      content: [{ type: 'text', text: coueError.toUserMessage() }],
      structuredContent: {
        error: {
          code: coueError.code,
          reason: coueError.reason,
          recommendation: coueError.recommendation
        }
      }
    };
  }
}

/**
 * Builds a COUE MCP server instance.
 *
 * A fresh instance is created per request: the server is stateless, so there
 * is no cross-request state to share and nothing to clean up.
 */
export function createCoueServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      // Ajv compiles schemas with `new Function`, which edge runtimes block.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
  );

  // ---------------------------------------------------------------- tool 1 --
  server.registerTool(
    'audit_project',
    {
      title: 'Audit ML project files',
      description:
        'Analyzes supplied machine-learning project files for production-readiness issues across eight categories: security, dependencies, testing, Docker, model serving, reproducibility, observability, and deployment. ' +
        'Takes an array of files, each with a path and its text content, and optionally a project name, a framework hint, a list of categories to focus on, and a cap on how many findings to return. ' +
        'Returns a readiness score out of 100, a status, per-category scores, prioritized findings with severity and a recommendation for each, a list of checks that could not be determined from the files supplied, and a plain-text summary. ' +
        'Analysis is static and offline: no submitted code is executed and no external service is contacted. Detected credential values are never returned.',
      inputSchema: auditProjectShape,
      annotations: readOnlyAnnotations('Audit ML project files')
    },
    (args) =>
      safely(() => {
        const options: Parameters<typeof runAudit>[1] = {};
        if (args.projectName !== undefined) options.projectName = args.projectName;
        if (args.framework !== undefined) options.frameworkHint = args.framework;
        if (args.focus !== undefined) options.focus = args.focus;
        if (args.includePassedChecks !== undefined) {
          options.includePassedChecks = args.includePassedChecks;
        }
        if (args.maxFindings !== undefined) options.maxFindings = args.maxFindings;

        const result = runAudit(args.files, options);

        return {
          content: [{ type: 'text', text: formatAuditText(result) }],
          structuredContent: result as unknown as Record<string, unknown>
        };
      })
  );

  // ---------------------------------------------------------------- tool 2 --
  server.registerTool(
    'check_ml_project',
    {
      title: 'Check ML practices from metadata',
      description:
        'Evaluates a machine-learning system against production engineering practices using a structured description of it, rather than its source files. ' +
        'Takes optional framework and model-type labels and three optional groups of boolean facts: the training pipeline (configuration file, random seed, data versioning, model versioning, experiment tracking), serving (health and readiness endpoints, whether the model is loaded at startup, input validation, authentication, rate limiting, timeout handling), and monitoring (logging, metrics, latency tracking, error tracking, model drift monitoring). ' +
        'Any field that is omitted is reported as UNKNOWN and excluded from the score; it is never treated as a failure. ' +
        'Returns a per-check PASS, FAIL, or UNKNOWN status, a score computed only over the checks that were answered, the impact and a recommendation for each failing check, and why each unknown check matters. ' +
        'Use this when the project files are not available but its practices can be described.',
      inputSchema: checkMlProjectShape,
      annotations: readOnlyAnnotations('Check ML practices from metadata')
    },
    (args) =>
      safely(() => {
        const result = runMlCheck(args);
        return {
          content: [{ type: 'text', text: formatMlCheckText(result) }],
          structuredContent: result as unknown as Record<string, unknown>
        };
      })
  );

  // ---------------------------------------------------------------- tool 3 --
  server.registerTool(
    'compare_models',
    {
      title: 'Compare trained models',
      description:
        'Ranks two or more trained model configurations against each other using metrics the caller supplies. ' +
        'Takes a list of models, each with a name, a map of quality metrics, and optional inference latency in milliseconds, memory use in megabytes, artifact size in megabytes, and throughput; plus an optional primary metric name and an optimization criterion of accuracy, latency, memory, or balanced. ' +
        'Returns a ranking with a composite score, a per-metric comparison identifying the best and worst model for each metric, the trade-offs each model makes, and a recommended model with its rationale. ' +
        'The recommendation is always qualified by the optimization criterion it was produced under and is never presented as a universally best model. When the metrics supplied cannot support a meaningful recommendation, COUE reports that instead of producing one.',
      inputSchema: compareModelsShape,
      annotations: readOnlyAnnotations('Compare trained models')
    },
    (args) =>
      safely(() => {
        const result = compareModels(args);
        return {
          content: [{ type: 'text', text: formatCompareText(result) }],
          structuredContent: result as unknown as Record<string, unknown>
        };
      })
  );

  // ---------------------------------------------------------------- tool 4 --
  server.registerTool(
    'generate_readiness_report',
    {
      title: 'Generate readiness report',
      description:
        'Turns a set of production-readiness findings and a score into a formatted report. ' +
        'Takes an array of findings, each with an id, severity, category, title, description, optional evidence, recommendation, and confidence, together with the score from 0 to 100 that they correspond to, and an optional format of summary, detailed, or deployment-checklist. ' +
        'Returns an overall status, a go or no-go deployment recommendation, finding counts by severity, the critical and high-priority findings, ordered recommended actions, and the rendered report text. ' +
        'The deployment-checklist format additionally returns ordered checklist items grouped by priority, plus items that static analysis cannot verify and that need manual confirmation. ' +
        'Findings normally come from a prior audit_project or check_ml_project result.',
      inputSchema: generateReportShape,
      annotations: readOnlyAnnotations('Generate readiness report')
    },
    (args) =>
      safely(() => {
        const result = generateReport(args);
        return {
          content: [{ type: 'text', text: result.reportText }],
          structuredContent: result as unknown as Record<string, unknown>
        };
      })
  );

  return server;
}

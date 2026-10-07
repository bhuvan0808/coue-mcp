import { z } from 'zod';
import { LIMITS } from '../utils/limits.js';

/**
 * Input schemas for the audit tools.
 *
 * Shapes are exported as raw Zod object shapes because the MCP SDK's
 * `registerTool` takes a shape and derives the JSON Schema that Claude sees.
 */

export const auditProjectShape = {
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(LIMITS.MAX_PATH_CHARS)
          .describe('Project-relative file path, for example "src/app.py" or "Dockerfile".'),
        content: z
          .string()
          .max(LIMITS.MAX_FILE_CHARS)
          .describe('Full text content of the file.')
      })
    )
    .min(1)
    .max(LIMITS.MAX_FILES)
    .describe(
      'The project files to analyze. Include source, configuration, dependency manifests, lockfiles, Dockerfiles, CI configuration, and tests. Omit datasets, model weights, and binary artifacts.'
    ),

  projectName: z
    .string()
    .max(200)
    .optional()
    .describe('Optional project name, used only in the summary text.'),

  framework: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Optional framework hint, for example "pytorch" or "fastapi". COUE detects frameworks from the files; this only records what the caller believes is in use.'
    ),

  focus: z
    .array(
      z.enum([
        'dependencies',
        'security',
        'testing',
        'docker',
        'model-serving',
        'reproducibility',
        'observability',
        'deployment'
      ])
    )
    .optional()
    .describe(
      'Restrict the audit to these categories. When omitted, all eight categories are analyzed.'
    ),

  includePassedChecks: z
    .boolean()
    .optional()
    .describe('Include the list of checks that passed. Defaults to false to keep results compact.'),

  maxFindings: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.MAX_FINDINGS_CEILING)
    .optional()
    .describe(`Maximum number of findings to return. Defaults to ${LIMITS.DEFAULT_MAX_FINDINGS}.`)
};

export const auditProjectSchema = z.object(auditProjectShape);
export type AuditProjectInput = z.infer<typeof auditProjectSchema>;

/** A tri-state answer used throughout check_ml_project. */
const triState = z
  .boolean()
  .optional()
  .describe('Set true or false when known. Omit when unknown; COUE reports UNKNOWN rather than assuming false.');

export const checkMlProjectShape = {
  framework: z
    .string()
    .max(100)
    .optional()
    .describe('ML framework in use, for example "pytorch", "tensorflow", or "scikit-learn".'),

  modelType: z
    .string()
    .max(100)
    .optional()
    .describe('Model type, for example "image-classification" or "tabular-regression".'),

  trainingPipeline: z
    .object({
      hasConfigFile: triState,
      randomSeedSet: triState,
      dataVersioned: triState,
      modelVersioned: triState,
      experimentTracking: triState
    })
    .optional()
    .describe('What the training pipeline does. Omit any field that is unknown.'),

  serving: z
    .object({
      framework: z
        .string()
        .max(100)
        .optional()
        .describe('Serving framework, for example "fastapi", "flask", "torchserve", or "triton".'),
      healthEndpoint: triState,
      readinessEndpoint: triState,
      modelLoadedAtStartup: triState,
      inputValidation: triState,
      authentication: triState,
      rateLimiting: triState,
      timeoutHandling: triState
    })
    .optional()
    .describe('How the model is served. Omit any field that is unknown.'),

  monitoring: z
    .object({
      logging: triState,
      metrics: triState,
      latencyTracking: triState,
      errorTracking: triState,
      modelDriftMonitoring: triState
    })
    .optional()
    .describe('What is monitored in production. Omit any field that is unknown.')
};

export const checkMlProjectSchema = z.object(checkMlProjectShape);
export type CheckMlProjectInput = z.infer<typeof checkMlProjectSchema>;

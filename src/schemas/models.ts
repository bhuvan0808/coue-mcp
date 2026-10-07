import { z } from 'zod';
import { LIMITS } from '../utils/limits.js';

/** Input schema for compare_models. */
export const compareModelsShape = {
  models: z
    .array(
      z.object({
        name: z.string().min(1).max(120).describe('Identifier for this model configuration.'),
        metrics: z
          .record(z.string().max(80), z.number().finite())
          .describe(
            'Quality metrics for this model, for example {"accuracy": 0.94, "f1": 0.91}. Use the same metric names across every model so they can be compared.'
          ),
        latencyMs: z
          .number()
          .nonnegative()
          .finite()
          .optional()
          .describe('Inference latency in milliseconds. Lower is better.'),
        memoryMb: z
          .number()
          .nonnegative()
          .finite()
          .optional()
          .describe('Peak memory use in megabytes during inference. Lower is better.'),
        modelSizeMb: z
          .number()
          .nonnegative()
          .finite()
          .optional()
          .describe('Serialized artifact size in megabytes. Lower is better.'),
        throughput: z
          .number()
          .nonnegative()
          .finite()
          .optional()
          .describe('Requests or samples served per second. Higher is better.')
      })
    )
    .min(2)
    .max(LIMITS.MAX_MODELS)
    .describe('The model configurations to compare. At least two are required.'),

  primaryMetric: z
    .string()
    .max(80)
    .optional()
    .describe(
      'Which metric in `metrics` is the primary quality measure. When omitted, COUE picks a common metric present on every model.'
    ),

  optimizeFor: z
    .enum(['accuracy', 'latency', 'memory', 'balanced'])
    .optional()
    .describe(
      'The optimization criterion for the recommendation. Defaults to "balanced". The recommendation is valid only under the criterion selected.'
    )
};

export const compareModelsSchema = z.object(compareModelsShape);
export type CompareModelsInput = z.infer<typeof compareModelsSchema>;

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCoueServer } from '../../src/mcp/server.js';
import { demoProject, healthyProject } from '../fixtures/projects.js';

/**
 * Protocol-level tests.
 *
 * These drive a real MCP client against a real COUE server over an in-memory
 * transport, so the tool schemas, annotations, argument validation, and result
 * shapes are exercised exactly as Claude exercises them.
 */

let client: Client;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCoueServer();
  const newClient = new Client({ name: 'coue-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);
  return newClient;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
}

/**
 * Asserts that a tool call failed with an actionable error.
 *
 * This SDK surfaces both schema-validation failures and handler errors as a
 * CallToolResult with `isError: true`, rather than by rejecting, so that
 * Claude receives the explanation as tool output. Directory review requires
 * these messages to be specific, so each one is checked for detail.
 */
async function expectToolError(
  call: Promise<unknown>
): Promise<string> {
  const result = (await call) as CallToolResult;
  expect(result.isError, 'expected the call to fail').toBe(true);
  const text = textOf(result);
  expect(text.length, 'error message should not be empty').toBeGreaterThan(20);
  // A bare "Bad Request" or "Internal Server Error" fails directory review.
  expect(text).not.toMatch(/^(?:Bad Request|Internal Server Error|Error)\.?$/i);
  expect(text).not.toContain('    at ');
  return text;
}

beforeEach(async () => {
  client = await connect();
});

describe('initialize and tools/list', () => {
  it('advertises exactly the four documented tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_project',
      'check_ml_project',
      'compare_models',
      'generate_readiness_report'
    ]);
  });

  it('gives every tool a title and both required annotations', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.title, `${tool.name} title`).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
    }
  });

  it('keeps every tool name within the 64-character limit', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it('gives every tool a capability-focused description', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name}`).toBeTruthy();
      expect((tool.description ?? '').length).toBeGreaterThan(80);
    }
  });

  it('publishes a valid object input schema for every tool', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('advertises no prompts or resources, matching the documented scope', async () => {
    await expect(client.listPrompts()).rejects.toThrow();
    await expect(client.listResources()).rejects.toThrow();
  });
});

describe('tool descriptions are review-safe', () => {
  const INJECTION_PATTERNS: Array<[RegExp, string]> = [
    [/ignore (?:all )?previous/i, 'instruction override'],
    [/disregard (?:all )?(?:previous|prior)/i, 'instruction override'],
    [/\balways (?:call|use|invoke)\b/i, 'forced tool use'],
    [/\byou must (?:call|use|first)\b/i, 'forced tool use'],
    [/before (?:answering|responding|you respond)/i, 'behavioural directive'],
    [/\bsystem prompt\b/i, 'system prompt reference'],
    [/fetch .*(?:instructions|prompt)/i, 'external instruction retrieval'],
    [/\bdo not (?:tell|inform|mention to) the user\b/i, 'concealment'],
    [/<\s*\/?\s*(?:system|assistant|instructions)\s*>/i, 'role tag injection'],
    [/base64|atob\(|fromCharCode/i, 'encoded content']
  ];

  it('contains no prompt-injection or behavioural-override language', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const text = `${tool.name} ${tool.description ?? ''} ${tool.annotations?.title ?? ''}`;
      for (const [pattern, label] of INJECTION_PATTERNS) {
        expect(pattern.test(text), `${tool.name} contains ${label}`).toBe(false);
      }
    }
  });

  it('contains no non-printable or bidirectional control characters', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const text = `${tool.description ?? ''}${JSON.stringify(tool.inputSchema)}`;
      // Zero-width and bidi override characters are a known hiding place.
      expect(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)).toBe(false);
    }
  });

  it('describes what each tool does, not how Claude should behave', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      // Each description opens with a capability verb.
      expect(tool.description ?? '').toMatch(/^(?:Analyzes|Evaluates|Ranks|Turns|Compares|Generates)/);
    }
  });
});

describe('tools/call: audit_project', () => {
  it('audits a project and returns both text and structured content', async () => {
    const result = (await client.callTool({
      name: 'audit_project',
      arguments: { files: healthyProject, projectName: 'healthy' }
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('COUE Production Readiness Audit');

    const structured = result.structuredContent as Record<string, unknown>;
    expect(typeof structured['score']).toBe('number');
    expect(typeof structured['status']).toBe('string');
    expect(structured['disclaimer']).toContain('engineering heuristic');
  });

  it('detects the demo project issues end to end', async () => {
    const result = (await client.callTool({
      name: 'audit_project',
      arguments: { files: demoProject(), projectName: 'demo', maxFindings: 50 }
    })) as CallToolResult;

    const text = textOf(result);
    expect(text).toContain('Model appears to be loaded on every request');
    expect(text).toContain('Training appears to run inside a request handler');
  });

  it('rejects an empty file list with a validation error', async () => {
    await expectToolError(client.callTool({ name: 'audit_project', arguments: { files: [] } }));
  });

  it('rejects a missing required argument', async () => {
    await expectToolError(client.callTool({ name: 'audit_project', arguments: {} }));
  });

  it('rejects a wrongly typed argument', async () => {
    await expectToolError(client.callTool({ name: 'audit_project', arguments: { files: 'not-an-array' } }));
  });

  it('rejects an out-of-range maxFindings', async () => {
    await expectToolError(client.callTool({
        name: 'audit_project',
        arguments: { files: healthyProject, maxFindings: 9999 }
      }));
  });

  it('rejects an unknown focus category', async () => {
    await expectToolError(client.callTool({
        name: 'audit_project',
        arguments: { files: healthyProject, focus: ['not-a-category'] }
      }));
  });

  it('returns a result comfortably within the platform output limit', async () => {
    const result = (await client.callTool({
      name: 'audit_project',
      arguments: { files: demoProject(), maxFindings: 50, includePassedChecks: true }
    })) as CallToolResult;

    const size = JSON.stringify(result).length;
    // Claude's limit is roughly 150,000 characters; COUE stays well under it.
    expect(size).toBeLessThan(100_000);
  });

  it('is deterministic across repeated calls', async () => {
    const args = { files: demoProject(), projectName: 'demo' };
    const first = (await client.callTool({ name: 'audit_project', arguments: args })) as CallToolResult;
    const second = (await client.callTool({ name: 'audit_project', arguments: args })) as CallToolResult;
    expect(textOf(first)).toBe(textOf(second));
  });
});

describe('tools/call: check_ml_project', () => {
  it('accepts an entirely empty input and reports UNKNOWN', async () => {
    const result = (await client.callTool({
      name: 'check_ml_project',
      arguments: {}
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('UNKNOWN');
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured['score']).toBeNull();
  });

  it('accepts partial metadata', async () => {
    const result = (await client.callTool({
      name: 'check_ml_project',
      arguments: {
        framework: 'pytorch',
        serving: { healthEndpoint: true, modelLoadedAtStartup: false }
      }
    })) as CallToolResult;

    const text = textOf(result);
    expect(text).toContain('pytorch');
    expect(text).toContain('FAIL');
    expect(text).toContain('PASS');
  });

  it('rejects a non-boolean where a boolean is required', async () => {
    await expectToolError(client.callTool({
        name: 'check_ml_project',
        arguments: { serving: { healthEndpoint: 'yes' } }
      }));
  });
});

describe('tools/call: compare_models', () => {
  const models = [
    { name: 'large', metrics: { accuracy: 0.95 }, latencyMs: 400, memoryMb: 3000 },
    { name: 'small', metrics: { accuracy: 0.9 }, latencyMs: 30, memoryMb: 300 }
  ];

  it('compares models under each optimization criterion', async () => {
    for (const optimizeFor of ['accuracy', 'latency', 'memory', 'balanced'] as const) {
      const result = (await client.callTool({
        name: 'compare_models',
        arguments: { models, optimizeFor }
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Recommendation');
    }
  });

  it('rejects a single model', async () => {
    await expectToolError(client.callTool({ name: 'compare_models', arguments: { models: [models[0]] } }));
  });

  it('reports insufficient metrics rather than inventing a recommendation', async () => {
    const result = (await client.callTool({
      name: 'compare_models',
      arguments: {
        models: [
          { name: 'a', metrics: { accuracy: 0.9 } },
          { name: 'b', metrics: { f1: 0.8 } }
        ]
      }
    })) as CallToolResult;

    expect(textOf(result)).toContain('No recommendation');
  });

  it('rejects a non-numeric metric value', async () => {
    await expectToolError(client.callTool({
        name: 'compare_models',
        arguments: {
          models: [
            { name: 'a', metrics: { accuracy: 'high' } },
            { name: 'b', metrics: { accuracy: 0.8 } }
          ]
        }
      }));
  });
});

describe('tools/call: generate_readiness_report', () => {
  const findings = [
    {
      id: 'A',
      severity: 'critical',
      category: 'security',
      title: 'Credential in source',
      description: 'A credential was detected.',
      recommendation: 'Rotate it.',
      confidence: 'high'
    }
  ];

  it('produces each documented format', async () => {
    for (const format of ['summary', 'detailed', 'deployment-checklist'] as const) {
      const result = (await client.callTool({
        name: 'generate_readiness_report',
        arguments: { findings, score: 42, format }
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(textOf(result).length).toBeGreaterThan(50);
    }
  });

  it('accepts an empty finding set', async () => {
    const result = (await client.callTool({
      name: 'generate_readiness_report',
      arguments: { findings: [], score: 100 }
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Production Ready');
  });

  it('rejects an out-of-range score', async () => {
    await expectToolError(client.callTool({ name: 'generate_readiness_report', arguments: { findings, score: 500 } }));
  });

  it('rejects an invalid severity', async () => {
    await expectToolError(client.callTool({
        name: 'generate_readiness_report',
        arguments: {
          findings: [{ ...findings[0], severity: 'catastrophic' }],
          score: 50
        }
      }));
  });

  it('produces a checklist with blockers for critical findings', async () => {
    const result = (await client.callTool({
      name: 'generate_readiness_report',
      arguments: { findings, score: 42, format: 'deployment-checklist' }
    })) as CallToolResult;
    expect(textOf(result)).toContain('Blockers');
    expect(textOf(result)).toContain('Items COUE cannot verify');
  });
});

describe('error handling', () => {
  it('rejects an unknown tool name', async () => {
    await expectToolError(client.callTool({ name: 'nonexistent_tool', arguments: {} }));
  });

  it('returns an actionable error, never a stack trace', async () => {
    const oversized = [{ path: 'big.py', content: 'x'.repeat(120_001) }];
    try {
      const result = (await client.callTool({
        name: 'audit_project',
        arguments: { files: oversized }
      })) as CallToolResult;
      // Either schema validation rejects it, or COUE returns a clean tool error.
      if (result.isError) {
        const text = textOf(result);
        expect(text).toContain('Reason:');
        expect(text).toContain('Recommendation:');
        expect(text).not.toContain('    at ');
      }
    } catch (err) {
      expect(String(err)).not.toContain('    at Object');
    }
  });
});

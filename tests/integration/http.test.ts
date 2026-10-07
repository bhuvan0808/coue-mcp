import { describe, expect, it } from 'vitest';

import app from '../../src/index.js';
import { LIMITS } from '../../src/utils/limits.js';

/**
 * HTTP-layer tests.
 *
 * The Worker is a Hono app exporting a standard fetch handler, so it can be
 * driven directly with Request objects without starting a server.
 */

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://coue.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' }
  }
};

describe('health endpoint', () => {
  it('returns the documented shape', async () => {
    const response = await app.fetch(new Request('https://coue.example.com/health'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok', service: 'coue', version: '1.0.0' });
  });

  it('exposes no infrastructure or environment detail', async () => {
    const response = await app.fetch(new Request('https://coue.example.com/health'));
    const text = await response.text();
    for (const leak of ['cloudflare', 'account', 'env', 'secret', 'token', 'region', 'colo']) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
  });

  it('sets hardening headers', async () => {
    const response = await app.fetch(new Request('https://coue.example.com/health'));
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('service description endpoint', () => {
  it('describes the service without exposing internals', async () => {
    const response = await app.fetch(new Request('https://coue.example.com/'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['service']).toBe('coue');
    expect(body['authentication']).toBe('none');
    expect(body['tools']).toHaveLength(4);
  });
});

describe('unknown routes', () => {
  it('returns a helpful 404', async () => {
    const response = await app.fetch(new Request('https://coue.example.com/nope'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(String(body['message'])).toContain('/mcp');
  });

  it('does not serve a path-traversal style request', async () => {
    const response = await app.fetch(
      new Request('https://coue.example.com/../../etc/passwd')
    );
    expect([400, 404]).toContain(response.status);
  });
});

describe('mcp endpoint', () => {
  it('completes an initialize handshake', async () => {
    const response = await app.fetch(mcpRequest(INITIALIZE));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const result = body['result'] as Record<string, unknown>;
    expect(result).toBeDefined();
    const serverInfo = result['serverInfo'] as Record<string, unknown>;
    expect(serverInfo['name']).toBe('coue');
    expect(serverInfo['version']).toBe('1.0.0');
  });

  it('issues no session id, confirming stateless operation', async () => {
    const response = await app.fetch(mcpRequest(INITIALIZE));
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('lists tools without a prior session', async () => {
    const response = await app.fetch(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const result = body['result'] as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(4);
  });

  it('rejects malformed JSON without exposing internals', async () => {
    const response = await app.fetch(mcpRequest('{ not json at all'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    const text = await response.text();
    expect(text).not.toContain('    at ');
    expect(text.toLowerCase()).not.toContain('stack');
  });

  it('rejects an oversized declared body before parsing it', async () => {
    const response = await app.fetch(
      mcpRequest(INITIALIZE, {
        'content-length': String(LIMITS.MAX_REQUEST_BODY_BYTES + 1)
      })
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(String(error['message'])).toContain('maximum supported size');
  });

  it('rejects an unexpected field in the JSON-RPC envelope', async () => {
    // The envelope is validated strictly, so an unrecognized top-level field
    // is refused rather than ignored. The refusal must stay clean.
    const response = await app.fetch(
      mcpRequest({ ...INITIALIZE, unexpectedField: { nested: true } })
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('    at ');
    expect(text.toLowerCase()).not.toContain('cloudflare');
  });

  it('tolerates an unexpected field inside tool arguments', async () => {
    const response = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'check_ml_project',
          arguments: { framework: 'pytorch', somethingElse: 'ignored' }
        }
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['result']).toBeDefined();
  });

  it('is not polluted by a __proto__ key in the request body', async () => {
    await app.fetch(
      mcpRequest(
        '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{"__proto__":{"polluted":true}}}'
      )
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects an unsupported method', async () => {
    const response = await app.fetch(
      new Request('https://coue.example.com/mcp', { method: 'PUT' })
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('answers a CORS preflight', async () => {
    const response = await app.fetch(
      new Request('https://coue.example.com/mcp', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'POST'
        }
      })
    );
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('runs a full audit over HTTP', async () => {
    const response = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'audit_project',
          arguments: {
            files: [
              { path: 'requirements.txt', content: 'torch\nfastapi\n' },
              {
                path: 'app.py',
                content: 'import torch\nfrom fastapi import FastAPI\napp = FastAPI()\n'
              }
            ],
            projectName: 'http-test'
          }
        }
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const result = body['result'] as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(result.content[0]?.text).toContain('COUE Production Readiness Audit');
    expect(typeof result.structuredContent['score']).toBe('number');
  });

  it('handles repeated requests independently', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      )
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
    }
  });
});

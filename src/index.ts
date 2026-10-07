import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { PRIVACY_SUMMARY } from './privacy/policy.js';
import { SERVER_VERSION, createCoueServer } from './mcp/server.js';
import { LIMITS } from './utils/limits.js';

/**
 * COUE Worker entry point.
 *
 * The server is stateless: every request builds a fresh MCP server and
 * transport, handles the request, and discards both. Nothing from a request
 * survives it, which is what makes the privacy posture in docs/privacy.md
 * true by construction rather than by policy.
 */

const app = new Hono();

/**
 * CORS.
 *
 * Claude reaches the server from Anthropic's infrastructure rather than from a
 * browser, so these headers exist for browser-based MCP tooling such as the
 * MCP Inspector. The MCP session and protocol headers must be exposed for a
 * browser client to read them.
 */
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'mcp-session-id',
      'mcp-protocol-version',
      'Last-Event-ID'
    ],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    maxAge: 86400
  })
);

/** Security headers on every response. */
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  // COUE serves JSON and SSE only; nothing should ever be rendered as a document.
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
});

/**
 * Health endpoint.
 *
 * Deliberately minimal. It reveals the service name and version and nothing
 * about the account, the environment, or the infrastructure.
 */
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'coue',
    version: SERVER_VERSION
  })
);

/** Service description, useful for anyone who opens the URL directly. */
app.get('/', (c) =>
  c.json({
    service: 'coue',
    description: 'AI/ML production readiness auditing for Claude.',
    version: SERVER_VERSION,
    mcpEndpoint: '/mcp',
    transport: 'streamable-http',
    authentication: 'none',
    tools: ['audit_project', 'check_ml_project', 'compare_models', 'generate_readiness_report'],
    privacy: PRIVACY_SUMMARY,
    documentation: 'https://github.com/bhuvan0808/coue-mcp'
  })
);

/**
 * Rejects a request body larger than COUE's application limit before the
 * transport reads it.
 *
 * The transport enforces its own bound as well; this one is lower and returns
 * a message a user can act on.
 */
app.use('/mcp', async (c, next) => {
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    const size = Number.parseInt(declared, 10);
    if (Number.isFinite(size) && size > LIMITS.MAX_REQUEST_BODY_BYTES) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message:
              `Request body exceeds the maximum supported size of ${LIMITS.MAX_REQUEST_BODY_BYTES} bytes. ` +
              'Reduce the project to the source, configuration, dependency, test, and deployment files relevant to the machine-learning application.'
          },
          id: null
        },
        413
      );
    }
  }
  await next();
  return undefined;
});

/**
 * MCP endpoint.
 *
 * `sessionIdGenerator` is left undefined, which puts the transport in
 * stateless mode: no session is issued, no session is validated, and no state
 * is held between requests. This is what allows the Worker to scale
 * horizontally with no coordination.
 */
app.all('/mcp', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: LIMITS.MAX_REQUEST_BODY_BYTES
  });

  const server = createCoueServer();

  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    // Operational diagnostics only. The request body, which holds the user's
    // source code, is never logged.
    console.error(
      JSON.stringify({
        event: 'mcp_request_failed',
        method: c.req.method,
        errorName: err instanceof Error ? err.name : 'unknown'
      })
    );

    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message:
            'COUE could not process the request. Retry the request; if the problem persists, report it at https://github.com/bhuvan0808/coue-mcp/issues without including your source code.'
        },
        id: null
      },
      500
    );
  } finally {
    // Release the per-request server and transport promptly.
    await server.close().catch(() => undefined);
  }
});

app.notFound((c) =>
  c.json(
    {
      error: 'not_found',
      message: 'COUE serves the MCP endpoint at /mcp and a health check at /health.'
    },
    404
  )
);

export default app;

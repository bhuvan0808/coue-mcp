<p align="center">
  <img src="assets/logo.svg" alt="coue" width="420">
</p>

<h1 align="center">COUE</h1>

<p align="center"><strong>AI/ML Production Readiness for Claude</strong></p>

<p align="center">
  A remote MCP server that audits AI and machine-learning projects for production readiness.
</p>

---

## What is COUE?

COUE is a Model Context Protocol server that gives Claude a specialized, deterministic
engineering capability: analyzing AI/ML projects for the issues that cause production
incidents.

You connect it to Claude once, then ask things like:

> Audit this machine-learning project before I deploy it.

> Find the biggest production risks in this ML project.

> Compare these three models and recommend the best one for production.

> Turn these findings into a deployment checklist.

The division of labour is deliberate:

> **Claude provides the reasoning. COUE provides the specialized engineering analysis.**

There is no language model inside COUE. Every result is produced by deterministic static
analysis, so the same input always yields the same output, and Claude explains and
contextualizes it.

## Why COUE?

General-purpose code review notices general-purpose problems. The failures that take an
ML service down are usually specific to ML, and they are easy to miss by reading code:

- A model loaded **inside the request handler**, so every request pays the full load cost
  and memory multiplies under concurrency.
- A service that passes every application health check while its **accuracy quietly
  degrades**, because nothing monitors the model as distinct from the service.
- An artifact at a **mutable path**, so a deployment cannot be tied to the run that
  produced it, and a rollback has nothing to roll back to.
- A training run with **no seed**, so a regression cannot be separated from variance.
- Unpinned dependencies plus a floating `:latest` base image, so **a rebuild is a
  different system**.

COUE checks all of these, and reports what it genuinely could not determine instead of
guessing.

## How it works

```
                         Claude
                           |
                           | MCP (Streamable HTTP)
                           v
                    HTTPS /mcp endpoint
                           |
                           v
                    +-------------+
                    |    COUE     |
                    | MCP Server  |
                    +------+------+
                           |
                    Analysis Service
                           |
   +--------+--------+-----+-----+--------+---------+
   |        |        |           |        |         |
Security Deps    Docker   Model-Serving Testing  Repro /
                                                 Observability /
                                                 Deployment
   |        |        |           |        |         |
   +--------+--------+-----+-----+--------+---------+
                           |
                     Scoring Engine
                           |
                           v
                  Structured Findings
                           |
                           v
                         Claude
```

The MCP protocol layer is separate from the analysis engine. Tool handlers call a service
layer and format its output; they contain no analysis logic.

## Features

- **Eight analysis categories** with a transparent, weighted score.
- **Evidence-based detection.** A framework is reported only when an actual import or
  dependency declaration is observed, never because a file is named after it.
- **Explicit `UNKNOWN`.** A check COUE could not evaluate is reported as unknown and
  excluded from the score, rather than counted as a failure.
- **Conservative secret detection.** Credential locations are reported; values never are.
- **No code execution.** COUE is a static analyzer and never runs, imports, or installs
  anything it is given.
- **No network access** during analysis, and no third-party API dependency at all.
- **Stateless and authless.** Nothing is stored; nothing to sign in to.

## Tools

| Tool | Purpose |
| --- | --- |
| `audit_project` | Analyzes supplied project files across all eight categories and returns a scored, prioritized set of findings. |
| `check_ml_project` | Evaluates a structured description of an ML system when the files are not available. Omitted fields are `UNKNOWN`, never `false`. |
| `compare_models` | Ranks model configurations under an explicit optimization criterion and explains the trade-offs. |
| `generate_readiness_report` | Turns findings into a summary, a detailed report, or a deployment checklist. |

All four are read-only, deterministic, and stateless.

## Supported frameworks

Detected from real imports and dependency declarations:

**Python** · PyTorch · TensorFlow · Keras · scikit-learn · Hugging Face Transformers ·
Ultralytics / YOLO · ONNX Runtime · XGBoost · LightGBM · FastAPI · Flask

**Node** · TypeScript · Express

**Infrastructure** · Docker · Docker Compose · Kubernetes manifests · GitHub Actions ·
GitLab CI · Terraform and other IaC

## Example prompts

```
Audit this ML project for production readiness.

Check whether this model-serving architecture has production risks.

Compare these three models and tell me which is best for production if latency matters most.

Turn these findings into a deployment checklist.
```

## Example output

Running COUE against the deliberately flawed project in
[`examples/demo-ml-project/`](examples/demo-ml-project/):

```
COUE Production Readiness Audit
================================

Score:  37/100
Status: Not Production Ready

"demo-ml-project" scores 37/100 (Not Production Ready). 2 critical issues were
found and should be resolved before deployment. COUE detected Docker, FastAPI,
PyTorch.

Category scores
---------------
dependencies     6
security         11
testing          7
docker           0
modelServing     0
reproducibility  5
observability    2
deployment       7

Findings: 38 total (2 critical, 9 high, 22 medium, 5 low)

CRITICAL
--------
1. [CRITICAL] Model appears to be loaded on every request
   Category: model-serving · Confidence: medium · ID: SERVE-MODEL-PER-REQUEST
   The handler for POST /predict calls a model-loading function inside the
   request body, with no visible cache or initialization guard. Every request
   then re-reads the model artifact and re-initializes it, which adds the full
   load time to each request's latency and multiplies memory use under
   concurrency. (observed in app.py:35)
   Fix: Load the model once at process startup, store it on the application
   state, and reference it from the handler.

Could not be determined
-----------------------
UNKNOWN  [dependencies] Whether declared dependencies contain known vulnerabilities
         COUE performs offline static analysis and does not consult a
         vulnerability database. Run a dedicated scanner such as pip-audit or
         npm audit in CI.
```

## Scoring

| Category | Weight |
| --- | ---: |
| Security | 20 |
| Model Serving | 15 |
| Dependencies | 15 |
| Testing | 10 |
| Reproducibility | 10 |
| Docker | 10 |
| Observability | 10 |
| Deployment | 10 |
| **Total** | **100** |

| Score | Status |
| --- | --- |
| 90–100 | Production Ready |
| 75–89 | Mostly Ready |
| 60–74 | Needs Attention |
| 40–59 | High Risk |
| 0–39 | Not Production Ready |

Findings deduct from their category's budget by severity, scaled by confidence.
Deductions saturate, so a category floors at zero rather than going negative, and a
single low-severity finding cannot meaningfully move the total.

**A category COUE could not assess is removed from the denominator**, not scored as
zero. The score is reported out of what was actually assessable, so "we could not see
it" never reads as "it is broken".

> **COUE's readiness score is an engineering heuristic derived from static analysis of
> the files supplied. It is not a security certification, a compliance certification, or
> a guarantee of production safety.**

## Security

- COUE **never executes** submitted code. No `python`, `node`, `pip`, `npm`, `bash`,
  `docker`, or any other process is invoked against an analyzed project. This is enforced
  by a test that scans the source for process and dynamic-evaluation calls.
- COUE **never fetches a URL**. There is no `fetch_url` tool, no URL parameter, and no
  outbound request during analysis. This is also enforced by a test.
- Detected credential values are **never returned, logged, or stored**. Findings carry the
  file, the line, and the kind of credential only.
- Strict request, file, and output limits apply; see [`src/utils/limits.ts`](src/utils/limits.ts).
- Submitted paths are normalized, so traversal sequences cannot be echoed into a result.
- Caller-supplied objects are copied through a null-prototype filter to prevent prototype
  pollution.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Privacy

COUE is stateless. Files are analyzed in memory within the request that supplied them and
discarded when it completes. There is no database, object store, cache, or queue. Request
bodies are never logged. COUE does not access Claude conversation history, Claude memory,
or any external account.

Full detail: [docs/privacy.md](docs/privacy.md).

## Limitations

COUE performs **static analysis of the files you give it**. It therefore:

- does not execute application code, and cannot observe runtime behaviour;
- does not perform dynamic or penetration testing;
- does not guarantee security, and does not certify regulatory compliance;
- does not consult a vulnerability database, so it never claims a dependency is
  vulnerable — run `pip-audit`, `npm audit`, or an SCA tool alongside it;
- cannot verify production infrastructure unless the relevant configuration is supplied;
- cannot determine whether an undocumented operational process exists;
- matches on naming and framework idioms, so an unconventional project may yield
  false negatives.

Where COUE cannot determine something, it says so rather than guessing.

## Architecture

```
src/
  index.ts                     Worker entry point, HTTP layer, limits
  mcp/
    server.ts                  MCP server, tool registration, annotations
    formatters.ts              Text renderings of each result
  analysis/
    audit-service.ts           Orchestrates analyzers for audit_project
    ml-check-service.ts        Metadata checks for check_ml_project
    compare-models.ts          Ranking engine for compare_models
    report-service.ts          Report rendering for generate_readiness_report
    project-detector.ts        Evidence-based ecosystem/framework detection
    scoring.ts                 Weighted scoring engine
    findings.ts                Finding model, sorting, dedupe, redaction entry
    security.ts  dependencies.ts  docker.ts  model-serving.ts
    testing.ts   reproducibility.ts  observability.ts  deployment.ts
  schemas/                     Zod input schemas for the four tools
  utils/
    limits.ts                  Application limits, path and key safety
    redaction.ts               Secret masking
    errors.ts                  Typed, actionable errors
  privacy/
    policy.ts                  Privacy posture, asserted by tests
```

## Local development

```bash
npm install
npm run dev          # wrangler dev on http://localhost:8787
```

Verify the endpoints:

```bash
curl http://localhost:8787/health
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --method tools/list
```

## Testing

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint, zero warnings
npm test             # vitest
npm run build        # typecheck + wrangler dry-run build
npm run verify       # all of the above
```

The suite covers tool schemas, valid and invalid inputs, project detection, scoring,
severity classification, secret redaction, every analyzer, error handling, request and
output limits, prototype pollution, path traversal, and MCP protocol behaviour against a
real MCP client.

## Deployment

COUE runs on Cloudflare Workers.

```bash
npx wrangler login
npm run deploy
```

Then confirm:

```bash
curl https://<your-worker-url>/health
```

## Claude setup

COUE requires no authentication, so connecting it is a single step.

1. In Claude, go to **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Enter the COUE endpoint URL, ending in `/mcp`.
4. Open a conversation, enable COUE from **+ → Connectors**, and ask it to audit a project.

## Roadmap

**v1.0** — ML project audit; security, dependency, Docker, model-serving, testing,
reproducibility, observability, and deployment analysis; production readiness scoring.

**v1.1** — MCP Apps readiness dashboard; more framework-specific checks; more deployment
checks.

**v2.0** — Optional authenticated private repository integrations; CI/CD integration;
pull-request auditing; model registry integrations; cloud deployment analysis; continuous
readiness monitoring.

MCP Apps are deliberately not part of v1. The core connector works entirely through
normal MCP tools and text results.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE).

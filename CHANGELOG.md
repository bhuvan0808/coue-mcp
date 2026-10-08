# Changelog

All notable changes to COUE are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-08

Initial release.

### Notes on positioning

- Public copy is host-neutral. COUE is positioned as an MCP server that works with
  any client rather than as a Claude-specific connector, so the same listing copy serves
  both the Anthropic and OpenAI directories. The `claude` keyword was dropped from
  `package.json`, and the README setup section now covers ChatGPT, Claude, and Claude Code.

### Added

- Terms of Service (`docs/terms.md`) and a customer-facing support page
  (`docs/support.md`). Both are required for an OpenAI directory submission; the terms
  also close a real gap, since COUE is a public service that previously published none.
- `GET /.well-known/openai-apps-challenge`, serving the OpenAI domain-verification token
  as plain text from the `OPENAI_APPS_CHALLENGE` binding. Returns 404 until the token is
  configured, so a stale or placeholder value can never be served. Verified end to end
  against the deployed Worker.
- `openai-plugin/`: the Agent Plugins package (`plugin.json`, `mcp.json`, icon and logo)
  declaring COUE as a remote Streamable HTTP server with all four required listing URLs.
- `docs/openai-submission.md`: the OpenAI submission packet, including the required five
  positive and three negative review cases and a demo-video outline.
- Tests pinning the plugin package: required URLs present and HTTPS, version lockstep
  with the server, read-only capability matching the tool annotations, assets resolving,
  no credentials in the package, and no vendor-specific positioning in listing copy.
- A landing page at `/`, content-negotiated so a browser gets HTML and tooling keeps the
  JSON service descriptor. It gives the service a human-readable HTTPS home usable as the
  `websiteURL` in a directory listing, with no external resource, no script, and a
  tightened Content-Security-Policy scoped to the document.

### Added

**MCP server**

- Remote MCP server over Streamable HTTP, served at `/mcp`.
- Stateless operation: a fresh server and transport per request, with no session state.
- Health endpoint at `/health` and a service description at `/`.
- No authentication required.

**Tools**

- `audit_project` — analyzes supplied project files across eight categories and returns a
  scored, prioritized set of findings.
- `check_ml_project` — evaluates a structured description of an ML system, reporting any
  omitted field as `UNKNOWN` rather than as a failure.
- `compare_models` — ranks model configurations under an explicit optimization criterion
  and reports the trade-offs.
- `generate_readiness_report` — renders findings as a summary, a detailed report, or a
  deployment checklist.

All four are annotated `readOnlyHint: true` and `destructiveHint: false`.

**Analysis engine**

- Evidence-based detection of Python and Node ecosystems, and of PyTorch, TensorFlow,
  Keras, scikit-learn, Hugging Face Transformers, Ultralytics/YOLO, ONNX Runtime,
  XGBoost, LightGBM, FastAPI, Flask, Express, and Docker.
- Security analysis: credential patterns, unsafe deserialization, dynamic evaluation,
  shell invocation, debug servers, disabled TLS verification.
- Dependency analysis: pinning, lockfiles, manifest consistency, development and
  production separation, package metadata.
- Docker analysis: base image pinning, non-root user, health checks, exposed ports,
  secrets in layers, cache hygiene, multi-stage opportunities, model artifact handling,
  compose privilege escalation.
- Model-serving analysis: per-request model loading, training in request paths, health
  and readiness endpoints, input validation, error and timeout handling, model version
  identifiers, hard-coded paths, unchecked GPU assumptions.
- Reproducibility analysis: seeding, configuration externalization, dataset and model
  versioning, experiment tracking, evaluation metrics, artifact provenance.
- Testing analysis: presence, runner detection, assertion density, coverage of
  inference, preprocessing, API, validation, and health paths, and CI execution.
- Observability analysis: structured logging, metrics, latency, error tracking, and
  model drift monitoring treated as distinct from application monitoring.
- Deployment analysis: production server, container entry point, environment
  configuration, graceful shutdown, Kubernetes resources and probes, CI/CD, and
  documentation.

**Scoring**

- Transparent weighted model totalling 100 across eight categories.
- Severity-based deductions scaled by confidence, saturating at the category floor.
- Categories that could not be assessed are excluded from the denominator rather than
  scored as zero.

**Security and privacy**

- No execution of submitted code, enforced by test.
- No outbound network access during analysis, enforced by test.
- Credential values never returned, logged, or stored, enforced by test.
- Path normalization, prototype-pollution filtering, and strict request, file, and
  output limits.
- Privacy posture defined in one place and asserted against the implementation.

**Project**

- 229 automated tests across unit, integration, security, and protocol suites.
- Demo project with documented intentional flaws, used as a test fixture.
- Logo and icon assets.
- README, privacy policy, security policy, and contributing guide.

[1.0.0]: https://github.com/bhuvan0808/coue-mcp/releases/tag/v1.0.0

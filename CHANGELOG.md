# Changelog

All notable changes to COUE are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-07

Initial release.

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

- 194 automated tests across unit, integration, security, and protocol suites.
- Demo project with documented intentional flaws, used as a test fixture.
- Logo and icon assets.
- README, privacy policy, security policy, and contributing guide.

[1.0.0]: https://github.com/bhuvan0808/coue-mcp/releases/tag/v1.0.0

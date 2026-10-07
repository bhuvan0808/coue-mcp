# Demo ML Project

A deliberately imperfect image-classification service, used as a fixture by
COUE's test suite. **Do not use this as a template.**

Every issue below is intentional. COUE's automated tests assert that it
detects them.

## Known intentional issues

| Area | Issue |
| --- | --- |
| Dependencies | `torch`, `uvicorn`, `numpy`, `pillow` are unpinned; no lockfile; `pytest` is in the runtime manifest |
| Security | `torch.load` deserializes an artifact from a mutable path (code-execution risk) |
| Docker | `FROM python:latest`; runs as root; no `HEALTHCHECK`; no `.dockerignore`; exposes PostgreSQL's port |
| Model serving | The model is loaded on every request; training runs in a request handler; no health or readiness endpoint; no input validation; no error handling; CUDA assumed without a check |
| Reproducibility | No random seed; no experiment tracking; no evaluation metrics; artifact written to a fixed mutable path |
| Testing | One test, covering model construction only |
| Observability | No logging, metrics, latency tracking, or drift monitoring |
| Deployment | Development server used as the entry point; no graceful shutdown |

## A deliberate non-finding

`app.py` contains `API_KEY = "EXAMPLE_API_KEY_NOT_REAL"`. COUE does **not**
report this, and that is the correct outcome: the value carries an obvious
placeholder marker, and COUE's credential detection is tuned to suppress those
rather than produce a false positive. A single noisy false positive costs the
user trust in every other finding in the report.

The project's own test suite asserts that this line is not reported.

## Usage

```
Audit this ML project for production readiness.
```

Then attach the files in this directory.

## Expected result

COUE scores this project in the **Not Production Ready** or **High Risk** band
and reports critical findings for the per-request model load and the training
call inside a request handler.

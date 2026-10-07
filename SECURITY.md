# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |

COUE is deployed as a single hosted service. Fixes are rolled out to the deployed
endpoint; there is no supported self-hosted release stream yet.

## Reporting a vulnerability

Please report security issues **privately** through GitHub Security Advisories:

**https://github.com/bhuvan0808/coue-mcp/security/advisories/new**

This creates a private advisory visible only to the maintainers. Please do not open a
public issue for a security report.

If you cannot use GitHub Security Advisories, open a public issue containing only the
sentence "I would like to report a security issue" and no technical detail, and a
maintainer will arrange a private channel.

## What to include

A useful report usually contains:

- The affected endpoint or tool (`audit_project`, `check_ml_project`, `compare_models`,
  `generate_readiness_report`, `/mcp`, or `/health`).
- A description of the issue and why it matters.
- Minimal steps to reproduce, with a **minimal, synthetic** request payload.
- The impact you believe it has.
- Any suggested remediation.

## What NOT to include

Please do **not** include:

- Real credentials, API keys, tokens, or private keys. Use a clearly fake value.
- Proprietary or confidential source code. Reduce the payload to a minimal synthetic
  reproduction.
- Personal data of any kind.
- Data belonging to a third party.

If a credential was exposed during your testing, rotate it and say so in the report
without including the value.

## Response expectations

COUE is maintained on a best-effort basis by an individual maintainer.

- Acknowledgement: within 7 days.
- Initial assessment: within 14 days.
- Fix or mitigation plan: communicated once the assessment is complete.

You will be credited in the advisory unless you ask not to be.

## Scope

**In scope**

- The COUE MCP server and its deployed `/mcp` and `/health` endpoints.
- The analysis engine, including incorrect handling of hostile input.
- Any path by which COUE could be made to execute submitted code, make an outbound
  request, return a detected credential value, or persist submitted content.
- Denial of service achievable within the documented request limits.

**Out of scope**

- Vulnerabilities in Cloudflare Workers itself. Report those to
  [Cloudflare](https://www.cloudflare.com/disclosure/).
- Vulnerabilities in projects that COUE analyzes. COUE reports on them; it does not own
  them.
- Findings that COUE misses, or false positives it produces. These are correctness
  issues — please open a normal issue for them.
- Volumetric denial of service against the hosted endpoint.
- Missing security headers with no demonstrated impact.

## Security design

COUE is built so that several classes of vulnerability are structurally absent:

- **No code execution.** COUE never runs, imports, installs, or deserializes submitted
  content. A test scans the source for process and dynamic-evaluation calls.
- **No arbitrary network access.** There is no URL parameter and no outbound request
  during analysis. A test enforces this across the analysis engine.
- **No persistence.** Nothing is stored, so there is nothing to exfiltrate after a
  request completes.
- **No authentication.** COUE holds no credentials and no user accounts, so there is no
  session, token, or account to compromise.
- **Credential redaction.** Detected credential values never leave the process.

If you find a way around any of these, it is a high-severity report and we want to hear
about it.

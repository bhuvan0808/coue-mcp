# COUE Support

COUE is a free, open-source static-analysis service. Support is provided through GitHub.

**Support channel:** https://github.com/bhuvan0808/coue-mcp/issues

---

## Before you open an issue

Most problems fall into one of these categories. Checking first usually saves a round
trip.

### The connector will not connect

1. Confirm the Service is up:

   ```
   curl https://coue-mcp.coue-mcp.workers.dev/health
   ```

   A healthy response is:

   ```json
   {"status":"ok","service":"coue","version":"1.0.0"}
   ```

2. Confirm you used the URL **ending in `/mcp`**, not the bare hostname.
3. Confirm authentication is set to **none**. COUE requires no credentials, and selecting
   an authentication mode will cause the connection to fail.

### A tool call failed

COUE returns an explanation rather than a generic error. Read the message first: it names
the field that was wrong, or the limit that was exceeded.

Common cases:

| Message mentions | Cause | Fix |
| --- | --- | --- |
| `Too small: expected array to have >=1 items` | No files were supplied | Attach at least one project file |
| `exceeds the maximum supported size` | Request body over 1.5 MB | Submit fewer or smaller files |
| `exceeds the supported maximum of 120000 characters` | One file is too large | Omit datasets, notebooks with stored output, and model weights |
| `exceeds the supported maximum of 60` | Too many files | Submit only the relevant source, config, dependency, test, and deployment files |

### The analysis missed something, or reported something wrong

This is a correctness issue, and a useful one to report. See **Reporting a problem**
below.

Note two deliberate behaviours that are not bugs:

- **COUE reports `UNKNOWN` rather than guessing.** If the files do not demonstrate
  something, COUE says it could not determine it, and excludes that check from the score
  instead of counting it as a failure.
- **COUE does not report known vulnerabilities.** It has no network access and consults no
  vulnerability database, by design. Run `pip-audit`, `npm audit`, or an SCA tool
  alongside it.

### The score seems wrong

The scoring model is published in full in the
[README](../README.md#scoring). Categories COUE could not assess are excluded from the
denominator rather than scored as zero, so two audits of different scope are not directly
comparable. The summary always states which categories were excluded.

---

## Reporting a problem

Open an issue at **https://github.com/bhuvan0808/coue-mcp/issues** and include:

- What you asked for, and what you expected.
- What COUE returned. The finding ID (for example `SERVE-MODEL-PER-REQUEST`) is the most
  useful single detail.
- A **minimal, synthetic** reproduction — the smallest file that triggers the behaviour.

**Please do not paste real credentials or proprietary source into an issue.** Reduce it to
a minimal synthetic example first. If a credential was exposed while testing, rotate it.

## Requesting a new check

New analyzer checks are welcome. The bar is described in
[CONTRIBUTING.md](../CONTRIBUTING.md#adding-an-analyzer-check): a check needs real
evidence, a real production consequence, an actionable fix, and tests proving it fires
when it should *and* stays quiet when it should not.

Describe the production failure you want caught, and what in the source would reveal it.

## Reporting a security vulnerability

**Do not open a public issue.** Follow [SECURITY.md](../SECURITY.md), which uses GitHub
Security Advisories for private disclosure.

## Response times

COUE is maintained on a best-effort basis by an individual maintainer.

| Report type | Target first response |
| --- | --- |
| Security vulnerability | 7 days |
| Service outage | 7 days |
| Bug report | 14 days |
| Feature or check request | Best effort |

These are targets, not guarantees. The Service is provided free of charge and without an
uptime commitment, as set out in the [Terms of Service](terms.md).

## Service status

COUE has no separate status page. The health endpoint is the source of truth:

```
https://coue-mcp.coue-mcp.workers.dev/health
```

If it returns a healthy response and your client still cannot connect, the problem is
most likely in the connector configuration — see **The connector will not connect** above.

## Other documentation

- [README](../README.md) — what COUE does, the tools, scoring, and limitations
- [Privacy Policy](privacy.md) — what COUE does with submitted content
- [Terms of Service](terms.md)
- [CONTRIBUTING](../CONTRIBUTING.md)
- [SECURITY](../SECURITY.md)

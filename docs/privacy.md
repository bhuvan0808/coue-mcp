# COUE Privacy Policy

**Effective date:** 7 October 2026
**Version:** 1.0.0

COUE is a stateless, unauthenticated static-analysis service. This document describes
exactly what it receives, what it does with it, and what it keeps.

The statements below are asserted against the implementation by COUE's automated test
suite (`tests/security/hardening.test.ts`) and are reproduced from a single source of
truth at [`src/privacy/policy.ts`](../src/privacy/policy.ts).

---

## 1. What COUE receives

COUE receives only what you send it in a tool call:

- File paths and file contents you choose to submit for an audit.
- Structured project metadata you supply to `check_ml_project`.
- Model names and numeric metrics you supply to `compare_models`.
- Findings you supply to `generate_readiness_report`.

COUE does not read your filesystem, clone a repository, or discover files on its own.
Everything it analyzes is content you explicitly passed to a tool.

## 2. How COUE processes it

- All analysis happens **in memory**, within the single HTTP request that supplied the
  data.
- Analysis is **static**. COUE never executes, imports, installs, interprets, or
  deserializes submitted code. It never runs `python`, `node`, `pip`, `npm`, `bash`,
  `docker`, or any other process against an analyzed project.
- COUE makes **no outbound network requests** while analyzing a project. It has no
  third-party API dependency.

## 3. What COUE stores

**Nothing.**

- COUE operates no database, no object storage, no cache, and no queue.
- Submitted file contents, paths, metadata, and findings are discarded when the request
  completes.
- Request bodies are never written to logs.
- Detected credential values are never returned, never logged, and never stored.

Each request constructs a fresh server instance and discards it when the request ends.
There is no cross-request state, by construction rather than by policy.

## 4. What COUE never accesses

- Claude conversation history
- Claude memory
- User files other than those explicitly supplied to a tool call
- Any external account, repository, or cloud provider
- Any third-party API

## 5. Logging

COUE emits operational log records containing the tool name, a coarse outcome, a
duration, and counts such as the number of files analyzed.

COUE does **not** log file paths, file contents, findings, metric values, or any value
matching a credential pattern.

**Third-party infrastructure.** COUE is hosted on Cloudflare Workers. Cloudflare, as the
hosting provider, processes request metadata such as source IP address, timestamp, and
response status as part of serving the request, under
[its own terms](https://www.cloudflare.com/privacypolicy/). COUE does not configure
additional retention beyond the platform default, and does not have access to submitted
request bodies after the request completes. COUE makes no claim about Cloudflare's
internal retention beyond what Cloudflare documents.

## 6. Data COUE does not request

| Category | Status |
| --- | --- |
| Personal data | Not intentionally requested |
| Sensitive data | Not intentionally requested |
| Authentication credentials | Not required — COUE is unauthenticated |
| Financial data | Not required |
| Health data | Not required |
| External account access | None |
| User project source | Processed for the requested audit and not intentionally retained |
| Conversation history | Not accessed |
| Claude memory | Not accessed |

**Note on submitted content.** Because COUE analyzes whatever files you send, you control
what it sees. If a file you submit contains personal data, COUE processes it in memory
for that request like any other text and discards it. COUE does not seek out, classify,
extract, or retain personal data. As with any analysis tool, submit only what is
necessary — source, configuration, dependency, test, and deployment files.

## 7. Training

Submitted content is **never used to train any model**. COUE contains no model, performs
no learning, and sends no data to any model provider.

## 8. Credential handling

When COUE detects a value matching a credential pattern, it reports:

- the file,
- the line number,
- the kind of credential.

It never reports, stores, or logs the value itself. All evidence returned in a finding
passes through a redaction step first. COUE cannot confirm whether a detected value is
live, and says so in the finding.

## 9. Children

COUE is a developer tool and is not directed at children.

## 10. Changes

Material changes to this policy will be recorded in
[CHANGELOG.md](../CHANGELOG.md) and reflected in the version number above.

## 11. Contact

Questions or concerns about this policy:

**https://github.com/bhuvan0808/coue-mcp/issues**

Please do not include source code or credentials in a public issue.

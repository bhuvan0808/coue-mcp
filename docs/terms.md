# COUE Terms of Service

**Effective date:** 7 October 2026
**Version:** 1.0.0

These terms govern your use of COUE, a hosted static-analysis service reachable as a
Model Context Protocol (MCP) server at `https://coue-mcp.coue-mcp.workers.dev/mcp`
("the Service").

By connecting to or calling the Service, you agree to these terms. If you do not agree,
do not use the Service.

---

## 1. What the Service does

COUE analyzes files and structured metadata that you submit, and returns an assessment of
the production readiness of an AI or machine-learning project. It performs deterministic
static analysis across security, dependencies, testing, container configuration, model
serving, reproducibility, observability, and deployment.

COUE does not execute, run, install, deploy, or modify anything you submit. It reads text
and returns findings.

## 2. The Service is provided as-is

**The Service is provided "as is" and "as available", without warranty of any kind,
express or implied**, including but not limited to warranties of merchantability, fitness
for a particular purpose, accuracy, and non-infringement.

Specifically, and without limiting the above:

- COUE's readiness score is an **engineering heuristic**, not a certification. It is not a
  security certification, a compliance certification, an audit opinion, or a guarantee of
  production safety.
- COUE performs **static analysis only**. It cannot observe runtime behaviour and does not
  perform dynamic or penetration testing.
- COUE **does not consult a vulnerability database** and makes no claim about whether any
  dependency contains a known vulnerability.
- COUE analyzes **only the files you supply**. A finding it does not report is not evidence
  that the corresponding issue does not exist. Where COUE cannot determine something, it
  reports `UNKNOWN`.
- COUE may produce **false positives and false negatives**.

## 3. You remain responsible for your systems

You are solely responsible for decisions you make about your own software, including
whether to deploy it. COUE's output is information to inform your engineering judgement,
not a substitute for it.

**Do not treat a COUE result as sign-off.** Review findings yourself, and apply your own
security review, testing, and change-management processes.

## 4. Acceptable use

You may use the Service for any lawful purpose, subject to the following. You agree not
to:

- Submit content you do not have the right to submit.
- Submit credentials, secrets, personal data, or other sensitive information that is not
  necessary for the analysis you are requesting.
- Attempt to cause the Service to execute code, make outbound network requests, or access
  systems beyond its documented function.
- Attempt to gain unauthorized access to the Service or its underlying infrastructure.
- Use the Service in a way that degrades it for others, including by circumventing the
  documented request, file, and size limits.
- Resell or redistribute the Service as a standalone product.

COUE reserves the right to rate-limit, block, or refuse requests that appear abusive.

## 5. Limits

The Service enforces documented limits on request size, file count, file size, and total
submitted content. These are published in the repository and may change. Requests that
exceed a limit are refused with an explanatory message.

## 6. Privacy

The [COUE Privacy Policy](privacy.md) forms part of these terms. In summary: COUE
analyzes submitted content in memory within a single request and discards it when the
request completes. It operates no database or storage, makes no outbound network requests
during analysis, never returns or logs a detected credential value, and never uses
submitted content to train any model.

## 7. Availability and changes

The Service is offered free of charge and with no uptime commitment. It may be modified,
suspended, rate-limited, or discontinued at any time, with or without notice.

These terms may be updated. Material changes will be recorded in the
[changelog](../CHANGELOG.md) and reflected in the version number above. Continued use
after a change constitutes acceptance of the updated terms.

## 8. Limitation of liability

**To the maximum extent permitted by law, the maintainers of COUE shall not be liable for
any indirect, incidental, special, consequential, exemplary, or punitive damages, or for
any loss of profits, revenue, data, goodwill, or business opportunity**, arising out of or
relating to your use of or inability to use the Service, whether based in contract, tort,
negligence, strict liability, or any other legal theory, and whether or not the
maintainers were advised of the possibility of such damages.

**To the maximum extent permitted by law, total aggregate liability arising out of or
relating to the Service shall not exceed one hundred United States dollars (USD 100).**

Some jurisdictions do not allow the exclusion of certain warranties or the limitation of
certain liabilities. In those jurisdictions, the exclusions and limitations above apply
only to the extent permitted.

## 9. Indemnity

You agree to indemnify and hold harmless the maintainers of COUE from any claim or demand
arising out of your use of the Service, your submitted content, or your violation of these
terms.

## 10. Open-source licence

COUE's source code is published under the [Apache License 2.0](../LICENSE). These terms
govern your use of the **hosted Service**; the Apache License governs your use of the
**source code**. Where they differ in respect of the source code, the Apache License
controls.

## 11. Third-party infrastructure

The Service is hosted on Cloudflare Workers. Your use of the Service is also subject to
Cloudflare's terms as the infrastructure provider. COUE does not control and is not
responsible for that infrastructure.

## 12. Termination

You may stop using the Service at any time by disconnecting it from your MCP client.
Access may be terminated or restricted if these terms are breached.

## 13. Governing law

These terms are governed by the laws of India, without regard to conflict-of-law
principles. Nothing in this clause deprives you of the protection of mandatory consumer
law in your place of residence.

## 14. Contact

Questions about these terms:

**https://github.com/bhuvan0808/coue-mcp/issues**

Please do not include source code, credentials, or personal data in a public issue.

# OpenAI App Directory — Submission Packet

Everything the OpenAI plugin submission flow asks for, prepared in order.

Submit at the **OpenAI Platform → Plugins** area. The package lives in
[`openai-plugin/`](../openai-plugin/).

> **Fields marked `TO BE PROVIDED` require your decision.** They are blank deliberately
> rather than filled with a guess.

---

## Prerequisites

| Requirement | Status |
| --- | --- |
| Public HTTPS MCP endpoint | Yes — `https://coue-mcp.coue-mcp.workers.dev/mcp` |
| Streamable HTTP transport | Yes |
| Website URL | Yes |
| Support URL | Yes |
| Privacy policy URL | Yes |
| Terms of service URL | Yes |
| Domain verification route | Built — serves the token once configured |
| Five positive + three negative cases | Below |
| Icon and logo | `openai-plugin/assets/` |
| Demo video | `TO BE PROVIDED` — see **Demo video** below |
| Publisher verification | `TO BE PROVIDED` — you must complete this |

---

## Package

```
openai-plugin/
  plugin.json          Agent Plugins manifest + extensions.com.openai
  mcp.json             Declares the remote Streamable HTTP server
  assets/
    icon.png           512×512, composer icon
    logo.png           1024px wordmark
```

`plugin.json` declares:

| Field | Value |
| --- | --- |
| `name` | `coue` |
| `version` | `1.0.0` |
| `displayName` | COUE |
| `shortDescription` | AI/ML production readiness auditing. |
| `developerName` | Bhuvan Boddu |
| `category` | Developer Tools |
| `capabilities` | `["Read"]` — every tool is read-only |
| `brandColor` | `#FF7A00` |

All four required listing URLs are set and are HTTPS:

| Field | URL |
| --- | --- |
| `websiteURL` | https://github.com/bhuvan0808/coue-mcp |
| `supportURL` | https://github.com/bhuvan0808/coue-mcp/blob/main/docs/support.md |
| `privacyPolicyURL` | https://github.com/bhuvan0808/coue-mcp/blob/main/docs/privacy.md |
| `termsOfServiceURL` | https://github.com/bhuvan0808/coue-mcp/blob/main/docs/terms.md |

---

## Domain verification

The portal issues a challenge token that must be served as **plain text, exactly as
given**, from the MCP hostname:

```
https://coue-mcp.coue-mcp.workers.dev/.well-known/openai-apps-challenge
```

The route is implemented in [`src/index.ts`](../src/index.ts). It reads the token from
the `OPENAI_APPS_CHALLENGE` binding and returns `404` until that is set, so a stale or
placeholder value can never be served.

**When the portal gives you the token, run:**

```bash
npx wrangler secret put OPENAI_APPS_CHALLENGE
# paste the token when prompted
```

Then confirm it serves correctly before clicking **Verify Domain**:

```bash
curl https://coue-mcp.coue-mcp.workers.dev/.well-known/openai-apps-challenge
# must print the token and nothing else
```

> `workers.dev` is not a domain you own, so the challenge must sit on the exact MCP
> hostname rather than a parent domain. The route above does that. If you later move COUE
> to a custom domain, re-run verification against the new hostname.

---

## Review cases

OpenAI requires **exactly five positive and three negative cases**.

### Positive 1 — Full project audit

**Prompt**

```
Audit this ML project for production readiness.
```

*(attach the files from [`examples/demo-ml-project/`](../examples/demo-ml-project/))*

**Tool:** `audit_project`

**Expected behaviour**

COUE analyzes the supplied files without executing them, detects the ecosystem and
frameworks from real imports and dependency declarations, and returns a readiness score
with prioritized findings. For the demo project it returns a score in the **Not
Production Ready** band (37/100) and reports two critical findings: a model loaded on
every request, and training running inside a request handler. The result also lists
checks it could not determine, marked `UNKNOWN`.

### Positive 2 — ML architecture assessment from a description

**Prompt**

```
My ML service has a health endpoint and input validation, but the model is loaded
per request and there is no drift monitoring. Check it for production risks.
```

**Tool:** `check_ml_project`

**Expected behaviour**

COUE evaluates the described system and returns a per-check `PASS` / `FAIL` / `UNKNOWN`
status. It reports the per-request model load as a **critical** failure and the absent
drift monitoring as a failure, passes the health endpoint and input validation, and marks
every field that was not described as `UNKNOWN` — excluded from the score rather than
counted as a failure. The score is computed only over the checks that were answered.

### Positive 3 — Model comparison

**Prompt**

```
Compare these three models and recommend the best one for production if latency
matters most: ModelA accuracy 0.95 latency 400ms, ModelB accuracy 0.93 latency
120ms, ModelC accuracy 0.88 latency 25ms.
```

**Tool:** `compare_models`

**Expected behaviour**

COUE ranks the three under the `latency` criterion, returns a composite score and the
trade-offs for each, and recommends ModelC. The recommendation is explicitly qualified as
"best under the latency optimization criterion, on the metrics supplied" and states that
this is not a claim the model is best in general. Where the top two are close, COUE says
so and advises deciding against the real latency budget.

### Positive 4 — Deployment checklist

**Prompt**

```
Turn these production-readiness findings into a deployment checklist.
```

*(following a prior `audit_project` call in the same conversation)*

**Tool:** `generate_readiness_report`

**Expected behaviour**

COUE returns a checklist grouped by priority — blockers, required, recommended, optional
— with each item stating the action, the rationale, and the originating finding ID. It
also appends a section of items static analysis cannot verify (tested rollback, load-tested
resource limits, assigned on-call owner, verified alert thresholds) for manual
confirmation.

### Positive 5 — Security-focused audit

**Prompt**

```
Audit this project specifically for production security risks.
```

*(attach project files)*

**Tool:** `audit_project` with `focus: ["security"]`

**Expected behaviour**

COUE restricts the audit to the security category and reports detectable issues with
evidence, severity, and a recommendation. Where a credential-shaped value is detected,
COUE reports **the file, the line, and the kind of credential only** — never the value
itself. It also states explicitly that dependency vulnerability status could not be
independently verified, because it consults no vulnerability database.

---

### Negative 1 — Request to execute code

**Prompt**

```
Run the Python code in this project and tell me whether it works.
```

**Expected behaviour**

COUE must not execute the project, and exposes no tool capable of doing so. The assistant
should explain that COUE performs static analysis only — it reads source as text and never
runs, imports, installs, or deserializes it — and should offer a static audit instead.

This is a structural property, not a policy: the server has no process-invocation or
dynamic-evaluation path, and a test in the suite scans the source to enforce that.

### Negative 2 — Request for a CVE determination

**Prompt**

```
Check whether this dependency has a known CVE.
```

**Expected behaviour**

COUE must not claim a dependency is or is not vulnerable. It has no network access and
consults no vulnerability database. Every audit returns an explicit `UNKNOWN` for this,
reading: *"Dependency security status could not be independently verified by COUE."* The
assistant should relay that limitation and suggest a dedicated scanner such as
`pip-audit`, `npm audit`, or an SCA tool.

### Negative 3 — Request to deploy or verify at runtime

**Prompt**

```
Deploy this application to AWS and verify that it works.
```

**Expected behaviour**

COUE must not claim to deploy anything or to verify runtime behaviour, and exposes no tool
that modifies any system. Every tool is annotated `readOnlyHint: true` and
`destructiveHint: false`. The assistant should explain that COUE's capability is static
production-readiness analysis, and may offer a pre-deployment readiness checklist instead.

---

## Demo video

**Status: `TO BE PROVIDED`.** A demo video URL is required and cannot be generated from
the repository.

Suggested ~60-second take, which needs no editing beyond a screen recording:

| Time | Action |
| --- | --- |
| 0:00–0:08 | Show the COUE connector enabled in ChatGPT. State that it needs no account or API key. |
| 0:08–0:20 | Attach the files from `examples/demo-ml-project/` and send *"Audit this ML project for production readiness."* |
| 0:20–0:35 | Show the result: score 37/100, Not Production Ready, and the two critical findings. Point out the per-request model load. |
| 0:35–0:48 | Send *"Turn these findings into a deployment checklist."* Show the grouped checklist and the "items COUE cannot verify" section. |
| 0:48–1:00 | Scroll to the `UNKNOWN` section and note that COUE reports what it could not determine instead of guessing. |

Record at 1080p or better and host where the portal can reach it.

---

## Listing copy

**Name**

```
COUE
```

**Short description**

```
AI/ML production readiness auditing.
```

**Long description** — as set in `plugin.json` (1,764 characters).

**Category:** Developer Tools — or the closest option the portal offers. Do not invent a
category.

**Capabilities:** Read. All four tools are read-only.

---

## Submission flow

1. Open the OpenAI Platform → Plugins area.
2. Upload the package from `openai-plugin/`.
3. Select your verified developer identity — **requires individual or business
   verification, which only you can complete**.
4. Add the MCP server: `https://coue-mcp.coue-mcp.workers.dev/mcp`.
5. Complete domain verification — set the `OPENAI_APPS_CHALLENGE` secret as above, then
   click **Verify Domain**.
6. Scan the MCP tools. Expect four, all read-only.
7. Resolve any automated findings.
8. Enter the five positive and three negative cases above.
9. Add the demo video URL.
10. Submit for review. You will receive a Case ID — keep it for any support request.
11. After approval, choose **Publish**.

> **Steps 3 and 11, and any legal attestation in the flow, require your personal
> authorization.** They have not been and must not be completed on your behalf.

---

## What you must provide

| Item | Why it cannot be prepared for you |
| --- | --- |
| Publisher verification | Requires your identity or business documents |
| Demo video URL | Requires a screen recording |
| Confirmation of publisher name | `plugin.json` currently says "Bhuvan Boddu" — change it if you want a brand name |
| Support email, if the portal asks | Not inferable; the support URL is a GitHub page |
| Legal attestations | Yours to accept |

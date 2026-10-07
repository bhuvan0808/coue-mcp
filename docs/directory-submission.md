# Claude Connector Directory — Submission Packet

Everything the submission portal at **https://claude.ai/directory/manage** asks for,
prepared in the order the portal asks for it.

Submit by choosing **Submit new → MCP connector**.

> **Fields marked `TO BE PROVIDED` require your decision.** They have been left blank
> deliberately rather than filled with a guess.

---

## Prerequisites

| Requirement | Status |
| --- | --- |
| Remote server reachable over HTTPS | Yes — `https://coue-mcp.coue-mcp.workers.dev/mcp` |
| Authentication works for Claude's client | Yes — `none` is supported by default |
| Every tool has `title` + `readOnlyHint`/`destructiveHint` | Yes, all four |
| Tested in Claude as a custom connector | See the testing log at the end |
| Listing materials ready | Yes, below |
| Test account for reviewers | Not applicable — see **Test & launch** |
| Account can submit | Any paid Claude plan |

---

## Step 1 — Connection

| Field | Value |
| --- | --- |
| Server URL | `https://coue-mcp.coue-mcp.workers.dev/mcp` |
| Users connect to different URLs? | **No** — single universal URL |

Transport is Streamable HTTP. The server is stateless and issues no session ID.

---

## Step 2 — Tools

Tools sync automatically from the connected server. Expect exactly four, all grouped as
**read-only**:

| Tool | Title | `readOnlyHint` | `destructiveHint` |
| --- | --- | --- | --- |
| `audit_project` | Audit ML project files | `true` | `false` |
| `check_ml_project` | Check ML practices from metadata | `true` | `false` |
| `compare_models` | Compare trained models | `true` | `false` |
| `generate_readiness_report` | Generate readiness report | `true` | `false` |

No tools should be flagged for missing titles or annotations. COUE exposes no prompts and
no resources.

---

## Step 3 — Listing

**Server name** (≤100 characters)

```
COUE
```

**One-liner** (≤200 characters)

```
AI/ML production readiness auditing for Claude.
```

**Description** (≤2,000 characters)

```
COUE analyzes AI and machine-learning projects for production readiness. It checks dependencies, security, Docker, model-serving patterns, testing, reproducibility, observability, and deployment practices, then returns a prioritized readiness score and actionable recommendations.

COUE performs deterministic static analysis. It contains no language model: Claude supplies the reasoning and explanation, while COUE supplies the specialized engineering analysis. The same project always produces the same result.

It is built around the failures that actually take machine-learning services down, which general-purpose code review tends to miss: a model loaded inside the request handler rather than at startup, so every request pays the full load cost; a service that passes every application health check while its accuracy quietly degrades, because nothing monitors the model as distinct from the service; a model artifact at a mutable path, so a deployment cannot be traced to the run that produced it; a training run with no seed, so a regression cannot be separated from random variance; unpinned dependencies on a floating base image, so a rebuild produces a different system.

Where COUE cannot determine something from the files it was given, it reports UNKNOWN and excludes that check from the score, rather than treating absence of evidence as failure.

COUE is unauthenticated and stateless. It analyzes files in memory within a single request and discards them when the request completes. It operates no database or storage, makes no outbound network requests during analysis, never executes submitted code, and never returns or logs a detected credential value. It does not access conversation history, Claude memory, or any external account.

The readiness score is an engineering heuristic derived from static analysis. It is not a security certification, a compliance certification, or a guarantee of production safety.
```

**Categories** (choose 1–5 from the portal's list; pick the closest available)

Suggested, in order of fit — select only from what the portal actually offers:
1. Developer Tools
2. Productivity

> Do not invent a category. If none of the above appear, choose the closest option the
> portal presents.

**Documentation URL**

```
https://github.com/bhuvan0808/coue-mcp#readme
```

**Privacy policy URL**

```
https://github.com/bhuvan0808/coue-mcp/blob/main/docs/privacy.md
```

**Support contact**

```
https://github.com/bhuvan0808/coue-mcp/issues
```

**Icon**

```
assets/icon-512.png     (512×512 PNG, four orange dots on white)
```

Alternatives in the repository: `assets/icon-1024.png`, `assets/icon.svg`.

**URL slug** (permanent once published)

```
coue
```

---

## Step 4 — Use cases

**Primary use cases**

1. **Audit an ML project before deployment.**
   Prompt: *"Audit this machine-learning project for production readiness and identify
   the highest-priority issues."*

2. **Find production risks in an ML application.**
   Prompt: *"Check this ML application for security, dependency, Docker, model-serving,
   and observability risks."*

3. **Compare candidate models for production.**
   Prompt: *"Compare these three models and recommend the best option based on accuracy
   and inference latency."*

4. **Turn an audit into a deployment checklist.**
   Prompt: *"Turn these findings into a deployment checklist."*

**What users need before connecting**

```
Nothing. COUE requires no account, no sign-in, no API key, and no paid plan of any kind.
Users supply the project files they want analyzed in the conversation.
```

**Does the connector read data, write data, or both?**

```
Reads only. All four tools are read-only and annotated as such. COUE does not write to,
modify, or delete anything, in any system.
```

---

## Step 5 — Company

| Field | Value |
| --- | --- |
| Company name | `Bhuvan Boddu` (individual developer — confirm the exact name you want listed) |
| Company website | `https://github.com/bhuvan0808/coue-mcp` |
| Primary contact | `TO BE PROVIDED` — the email address you want Anthropic to use for review updates |

> The primary contact is where Anthropic sends review correspondence. Choose the address
> you want associated with this listing; it has been left blank rather than assumed.

---

## Step 6 — Data handling

| Question | Answer |
| --- | --- |
| Is the underlying API your own, proxied from a partner, or a third party's? | **Your own.** COUE calls no external API. All analysis runs inside the COUE server itself. |
| Does the connector handle personal health data? | **No.** |
| Does the connector contain sponsored content? | **No.** |

Supporting statements, all of which match the implementation and are asserted by the
test suite:

| Category | Answer |
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
| Training on submitted content | Never |

---

## Step 7 — Authentication

Select:

```
No authentication
```

`none` is listed as **"Supported by default"** in Anthropic's authentication
documentation, and is compatible with a universal URL.

**Why COUE is unauthenticated:** it needs no access to any user account, private data,
repository, or cloud provider. It analyzes only the content passed to it in a tool call.
Adding authentication would mean collecting credentials COUE has no use for.

No tools prompt for authentication on demand, so lazy authentication does not apply.

**Allowed link URIs:** not applicable. COUE does not use the `ui/open-link` capability.

---

## Step 8 — Test & launch

COUE is unauthenticated, so there is no account to create and no credentials to supply.
Enter setup and access instructions along these lines:

```
COUE requires no authentication, no account, and no test credentials.

To connect:
1. Settings > Connectors > Add custom connector
2. Enter the server URL ending in /mcp
3. No sign-in step appears; the connector shows Connected immediately

To exercise the tools, a ready-made demo project with deliberately introduced
production issues is published at:
https://github.com/bhuvan0808/coue-mcp/tree/main/examples/demo-ml-project

Paste those files into a conversation and ask:

  "Audit this ML project for production readiness."

COUE should return a score in the Not Production Ready band and report critical
findings for a model loaded on every request and for training running inside a
request handler.

Two tools need no files at all:

  "Compare these models for production: ModelA with accuracy 0.95 and latency
   400ms, ModelB with accuracy 0.93 and latency 120ms, ModelC with accuracy 0.88
   and latency 25ms. Latency matters most."

  "My ML service has a health endpoint and input validation, but the model is
   loaded per request and there is no drift monitoring. Check it."

Health check (no authentication required):
  GET https://coue-mcp.coue-mcp.workers.dev/health  ->  {"status":"ok","service":"coue","version":"1.0.0"}
```

You must also confirm you have run every tool yourself, via MCP Inspector or as a custom
connector. See the testing log below.

---

## Step 9 — Compliance

Seven acknowledgments, all required. COUE's position on each:

| Acknowledgment | COUE |
| --- | --- |
| Directory guidelines | Reviewed against the pre-submission checklist |
| First-party API usage | COUE calls no external API; all analysis is internal |
| Financial transactions | None. COUE transfers no money, cryptocurrency, or assets |
| AI media generation | None. COUE generates no images, video, or audio |
| Prompt injection | No tool description instructs Claude how to behave; enforced by test |
| Conversation data collection | None. COUE collects no conversation data and queries no memory, history, or user files |
| Public documentation | Published at the documentation URL above |

> **These acknowledgments are legal attestations. Tick them yourself.** They have not
> been and must not be accepted on your behalf.

---

## Step 10 — Review and submit

Check everything, then submit. Status and reviewer feedback appear in the portal.
Escalations go to `mcp-review@anthropic.com`.

---

## Review-criteria self-assessment

Checked against Anthropic's connector pre-submission checklist.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Read and write tools separated | Pass | All four tools are read-only; no catch-all tool with a method parameter |
| API docs referenced in custom query tools | N/A | No tool accepts freeform endpoints, query strings, or request bodies |
| Tool annotations present | Pass | All four declare `title`, `readOnlyHint: true`, `destructiveHint: false` |
| Tool names ≤64 characters | Pass | Longest is `generate_readiness_report` (25) |
| Narrow, accurate descriptions | Pass | Each states what it does, what it takes, and what it returns |
| No prompt-injection patterns | Pass | Enforced by test: no override language, forced tool use, external instruction retrieval, concealment, role tags, or encoded content |
| Every tool returns successfully on valid parameters | Pass | Covered by the integration suite |
| Actionable error messages | Pass | Validation errors name the offending field and the expected value; no generic "Bad Request" |
| Responses reasonably sized | Pass | Default 10 findings; full demo audit well under 100,000 characters against a ~150,000 limit |
| No conversation data collected | Pass | No memory, history, summary, or user-file access |
| First-party API | Pass | No external API is called |
| No financial transactions | Pass | Out of scope |
| No AI media generation | Pass | Out of scope |
| Test credentials | N/A | Unauthenticated; setup instructions supplied instead |
| Public documentation | Pass | README and privacy policy are public |

---

## Testing log

Record actual results here before submitting. **Do not mark a row as passed until it has
genuinely been run.**

### Automated

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | Pass |
| Lint | `npm run lint` | Pass, zero warnings |
| Tests | `npm test` | Pass, 194 tests across 5 files |
| Build | `npm run build` | Pass |

### MCP Inspector

| Method | Result |
| --- | --- |
| `initialize` | Pass (local and production) |
| `tools/list` | Pass (local and production) — four tools, annotations correct |
| `tools/call` × 4 | Pass (local and production) |

### Real Claude custom connector

| Prompt | Expected tool | Result |
| --- | --- | --- |
| "Audit this ML project for production readiness." | `audit_project` | `TO BE RECORDED` |
| "Check whether this model-serving architecture has production risks." | `audit_project` or `check_ml_project` | `TO BE RECORDED` |
| "Compare these three models and tell me which is best for production if latency matters most." | `compare_models` | `TO BE RECORDED` |
| "Turn these findings into a deployment checklist." | `generate_readiness_report` | `TO BE RECORDED` |

Anthropic's documentation states there is no staging environment: connectors are tested
in production, against the real Claude client, by adding the deployed URL as a custom
connector under **Settings → Connectors**.

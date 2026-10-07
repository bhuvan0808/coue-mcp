# Contributing to COUE

Thanks for your interest in improving COUE.

## Getting started

```bash
git clone https://github.com/bhuvan0808/coue-mcp.git
cd coue-mcp
npm install
npm run dev
```

Verify your setup:

```bash
curl http://localhost:8787/health
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --method tools/list
```

## Before you open a pull request

```bash
npm run verify   # typecheck, lint, test, build
```

All four must pass.

## The rules that matter most

COUE makes a small number of promises to its users. A change that breaks one of them
will not be merged, however useful it is otherwise.

1. **Never execute analyzed content.** No process invocation, no dynamic evaluation, no
   deserialization, no dynamic import of anything a user submitted. COUE is a static
   analyzer.
2. **Never make an outbound request during analysis.** No `fetch`, no URL parameters, no
   third-party API.
3. **Never return, log, or store a detected credential value.** Report the file, the
   line, and the kind. Nothing else.
4. **Never turn "not detected" into "does not exist".** If the files do not prove it, the
   answer is `UNKNOWN`, and it is excluded from the score rather than counted as a
   failure.
5. **Never fabricate.** No invented file names, line numbers, evidence, or CVEs. If
   evidence is unavailable, omit the field.

Tests enforce 1, 2, and 3 directly.

## Adding an analyzer check

A good check has all of these:

- **Evidence.** It fires on something actually observed, not on a filename or a guess.
- **A real consequence.** The description explains what goes wrong in production, not
  just that a convention was not followed.
- **An actionable fix.** The recommendation tells someone what to change.
- **An honest confidence.** Use `low` for a heuristic match; it deducts less from the
  score.
- **A test for both directions.** One that proves it fires when it should, and one that
  proves it does not fire when it should not. The second matters more: a false positive
  costs the user trust in every other finding.

Prefer a missed finding over a wrong one.

## Writing tool descriptions

Tool descriptions are read by Claude and reviewed by Anthropic. They must describe
capability only. Never write a description that instructs Claude how to behave, tells it
to call another tool, references the system prompt, or contains encoded content. The
integration test suite checks for these patterns.

## Style

- TypeScript, strict mode, no `any`.
- Comments explain *why*, not *what*. Match the density of the surrounding code.
- User-facing strings are plain, specific, and free of hedging.

## Reporting bugs

Open an issue with a minimal, **synthetic** reproduction. Never paste real credentials or
proprietary source into an issue.

For security issues, follow [SECURITY.md](SECURITY.md) instead.

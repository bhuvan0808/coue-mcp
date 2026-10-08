import { SERVER_VERSION } from './mcp/server.js';

/**
 * Landing page.
 *
 * `/` is content-negotiated: machines get the JSON service descriptor, and a
 * browser gets this page. It exists so the service has a human-readable HTTPS
 * home that can be used as the `websiteURL` in a directory listing, without
 * depending on a separate host or a purchased domain.
 *
 * Everything is inline: no external stylesheet, font, script, or image, which
 * keeps it compatible with the restrictive Content-Security-Policy the Worker
 * already sets on every response.
 */

const MCP_URL = 'https://coue-mcp.coue-mcp.workers.dev/mcp';
const REPO = 'https://github.com/bhuvan0808/coue-mcp';

export function renderLandingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>COUE</title>
<meta name="description" content="AI/ML production readiness auditing. A remote MCP server that audits machine-learning projects for the issues that cause production incidents.">
<style>
  :root {
    --orange: #FF7A00;
    --fg: #16161a;
    --muted: #5c5c66;
    --bg: #ffffff;
    --card: #faf9f8;
    --line: #e6e4e1;
    --code-bg: #f5f3f1;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --fg: #ececf0; --muted: #a0a0ab; --bg: #121214;
      --card: #1a1a1e; --line: #2c2c32; --code-bg: #1e1e23;
    }
  }
  :root[data-theme="dark"] {
    --fg: #ececf0; --muted: #a0a0ab; --bg: #121214;
    --card: #1a1a1e; --line: #2c2c32; --code-bg: #1e1e23;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 72px 16px 96px; }
  header { margin-bottom: 44px; }
  .mark { display: flex; align-items: center; gap: 18px; margin-bottom: 26px; }
  .dots { display: flex; gap: 9px; }
  .dots i { width: 15px; height: 15px; border-radius: 50%; background: var(--orange); display: block; }
  .word { font-size: 38px; font-weight: 700; letter-spacing: -.035em; color: var(--orange); }
  h1 { font-size: 27px; font-weight: 650; letter-spacing: -.02em; margin: 0 0 12px; }
  .lede { font-size: 17px; color: var(--muted); margin: 0; max-width: 60ch; }
  h2 { font-size: 13px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase;
       color: var(--muted); margin: 44px 0 14px; }
  p { margin: 0 0 14px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 9px;
        padding: 13px 15px; overflow-x: auto; font-size: 13.5px; margin: 0 0 14px; }
  .endpoint { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
              background: var(--card); border: 1px solid var(--line); border-radius: 11px;
              padding: 15px 17px; margin-bottom: 10px; }
  .endpoint code { font-size: 14px; font-weight: 600; word-break: break-all; }
  .pill { font-size: 11px; font-weight: 650; letter-spacing: .055em; text-transform: uppercase;
          color: var(--orange); border: 1px solid var(--orange); border-radius: 999px;
          padding: 2.5px 9px; white-space: nowrap; }
  .grid { display: grid; gap: 11px; grid-template-columns: repeat(auto-fit, minmax(228px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 11px; padding: 16px 17px; }
  .card h3 { margin: 0 0 5px; font-size: 14px; font-weight: 650; }
  .card h3 code { color: var(--orange); font-size: 13px; }
  .card p { margin: 0; font-size: 13.5px; color: var(--muted); line-height: 1.55; }
  ul { margin: 0 0 14px; padding-left: 20px; }
  li { margin-bottom: 7px; }
  a { color: var(--orange); text-decoration: none; border-bottom: 1px solid transparent; }
  a:hover { border-bottom-color: currentColor; }
  footer { margin-top: 56px; padding-top: 22px; border-top: 1px solid var(--line);
           font-size: 13.5px; color: var(--muted); }
  footer a { margin-right: 17px; display: inline-block; }
  .note { font-size: 13.5px; color: var(--muted); border-left: 2.5px solid var(--orange);
          padding-left: 14px; margin: 0 0 14px; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="mark">
      <span class="dots"><i></i><i></i><i></i><i></i></span>
      <span class="word">coue</span>
    </div>
    <h1>AI/ML production readiness auditing</h1>
    <p class="lede">
      A remote MCP server that audits machine-learning projects for the issues that cause
      production incidents. Deterministic static analysis, no language model, no account.
    </p>
  </header>

  <h2>MCP endpoint</h2>
  <div class="endpoint">
    <code>${MCP_URL}</code>
    <span class="pill">No auth</span>
  </div>
  <p class="note">
    Streamable HTTP. Works with any MCP client, including ChatGPT, Claude, and Claude Code.
  </p>

  <h2>Tools</h2>
  <div class="grid">
    <div class="card">
      <h3><code>audit_project</code></h3>
      <p>Analyzes supplied project files across eight categories and returns a scored,
         prioritized set of findings.</p>
    </div>
    <div class="card">
      <h3><code>check_ml_project</code></h3>
      <p>Evaluates a structured description of an ML system when the files are not
         available.</p>
    </div>
    <div class="card">
      <h3><code>compare_models</code></h3>
      <p>Ranks model configurations under an explicit optimization criterion and explains
         the trade-offs.</p>
    </div>
    <div class="card">
      <h3><code>generate_readiness_report</code></h3>
      <p>Turns findings into a summary, a detailed report, or a deployment checklist.</p>
    </div>
  </div>

  <h2>What it catches</h2>
  <ul>
    <li>A model loaded <strong>inside the request handler</strong>, so every request pays
        the full load cost and memory multiplies under concurrency.</li>
    <li>A service that passes every application health check while its
        <strong>accuracy quietly degrades</strong>, because nothing monitors the model as
        distinct from the service.</li>
    <li>An artifact at a <strong>mutable path</strong>, so a deployment cannot be traced to
        the run that produced it.</li>
    <li>A training run with <strong>no seed</strong>, so a regression cannot be separated
        from variance.</li>
    <li>Unpinned dependencies on a floating base image, so <strong>a rebuild is a different
        system</strong>.</li>
  </ul>

  <h2>Try it</h2>
  <pre>claude mcp add --transport http coue ${MCP_URL}</pre>
  <p>Then attach a project and ask:</p>
  <pre>Audit this ML project for production readiness.</pre>

  <h2>Privacy</h2>
  <p>
    COUE analyzes the files you send in memory and discards them when the request
    completes. It operates no database or storage, makes no outbound network calls during
    analysis, never executes submitted code, and never returns or logs a detected
    credential value. It does not access conversation history, assistant memory, or any
    external account.
  </p>

  <h2>Limitations</h2>
  <p>
    COUE performs static analysis of the files it is given. It does not execute code,
    perform penetration testing, or consult a vulnerability database, so it never claims a
    dependency is vulnerable. Where it cannot determine something, it reports
    <code>UNKNOWN</code> rather than guessing.
  </p>
  <p class="note">
    The readiness score is an engineering heuristic. It is not a security certification, a
    compliance certification, or a guarantee of production safety.
  </p>

  <footer>
    <a href="${REPO}">GitHub</a>
    <a href="${REPO}#readme">Docs</a>
    <a href="${REPO}/blob/main/docs/privacy.md">Privacy</a>
    <a href="${REPO}/blob/main/docs/terms.md">Terms</a>
    <a href="${REPO}/blob/main/docs/support.md">Support</a>
    <div style="margin-top:14px">COUE v${SERVER_VERSION} &middot; Apache-2.0</div>
  </footer>

</div>
</body>
</html>`;
}

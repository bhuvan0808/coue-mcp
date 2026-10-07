import { emptyResult, makeFinding, type AnalyzerResult } from './findings.js';
import { isJsTs, isPython, isTestFile, type ProjectProfile, type SourceFile } from './project-detector.js';

/**
 * Security analysis.
 *
 * Two concerns: credential-like values committed to source, and unsafe code
 * patterns common in ML services (pickle deserialization, `eval`, shell
 * injection, debug servers).
 *
 * Detection is deliberately conservative. A false positive costs the user
 * trust in every other finding, so each rule requires a distinctive shape
 * rather than a generic keyword.
 *
 * COUE reports the file, the line, and the *kind* of credential. It never
 * returns, stores, or logs the value itself.
 */

interface SecretRule {
  id: string;
  /** Human-readable name of what was matched. */
  label: string;
  pattern: RegExp;
  /** High-confidence rules match a provider-specific, unambiguous shape. */
  confidence: 'high' | 'medium';
}

/**
 * Credential patterns.
 *
 * Provider-prefixed rules are `high` confidence: the prefix plus length is
 * distinctive enough that a match is almost certainly a real credential shape.
 * Generic assignment rules are `medium`.
 */
const SECRET_RULES: SecretRule[] = [
  {
    id: 'SEC-AWS-KEY',
    label: 'AWS access key ID',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-GITHUB-TOKEN',
    label: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{30,})\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-SLACK-TOKEN',
    label: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{12,}\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-GOOGLE-KEY',
    label: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-STRIPE-KEY',
    label: 'Stripe secret key',
    pattern: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-LLM-KEY',
    label: 'LLM provider API key',
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-HF-TOKEN',
    label: 'Hugging Face access token',
    pattern: /\bhf_[A-Za-z0-9]{34,}\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-PRIVATE-KEY',
    label: 'private key block',
    pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
    confidence: 'high'
  },
  {
    id: 'SEC-JWT',
    label: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/,
    confidence: 'high'
  },
  {
    id: 'SEC-DB-URL',
    label: 'database connection string with embedded password',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:/@"']+:[^\s:/@"']+@[^\s"']+/,
    confidence: 'high'
  },
  {
    id: 'SEC-GENERIC-SECRET',
    label: 'hard-coded credential assignment',
    // Requires a credential-ish name, an assignment, a quoted value of
    // meaningful length, and no obvious placeholder marker.
    pattern:
      /\b(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|password|passwd)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    confidence: 'medium'
  },
  {
    id: 'SEC-BEARER',
    label: 'hard-coded bearer token',
    pattern: /["']Bearer\s+[A-Za-z0-9._~+/=-]{20,}["']/,
    confidence: 'medium'
  }
];

/**
 * Markers that indicate a value is an intentional placeholder rather than a
 * real credential. A line containing one of these is not reported.
 */
const PLACEHOLDER_MARKERS = [
  'example',
  'placeholder',
  'your_',
  'your-',
  'yourkey',
  'changeme',
  'change_me',
  'dummy',
  'fake',
  'not_real',
  'notreal',
  'replace_me',
  'replaceme',
  'xxxxx',
  'test_key',
  'sample',
  '<your',
  'todo',
  'redacted',
  'insert_',
  'os.environ',
  'os.getenv',
  'process.env',
  'getenv(',
  '${',
  '{{'
];

function looksLikePlaceholder(line: string): boolean {
  const lower = line.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

/** Files whose contents are expected to carry sample credentials. */
function isCredentialExemptFile(file: SourceFile): boolean {
  const p = file.path.toLowerCase();
  return (
    p.endsWith('.example') ||
    p.endsWith('.sample') ||
    p.endsWith('.template') ||
    p.includes('.env.example') ||
    p.includes('.env.sample') ||
    p.includes('/docs/') ||
    p.endsWith('readme.md')
  );
}

/** Unsafe code patterns relevant to ML services. */
interface CodeRule {
  id: string;
  title: string;
  description: string;
  recommendation: string;
  severity: 'critical' | 'high' | 'medium';
  confidence: 'high' | 'medium';
  pattern: RegExp;
  applies: (file: SourceFile) => boolean;
}

const CODE_RULES: CodeRule[] = [
  {
    id: 'SEC-PICKLE-LOAD',
    title: 'Model or data loaded with an unsafe deserializer',
    description:
      'Python pickle deserialization executes arbitrary code contained in the serialized payload. When the artifact can be influenced by anything outside the deployment pipeline, this is a remote code execution path.',
    recommendation:
      'Load model artifacts from a trusted, integrity-checked location only. Prefer a safe serialization format such as safetensors or ONNX, and verify an artifact checksum before loading.',
    severity: 'high',
    confidence: 'medium',
    pattern: /\b(?:pickle|cPickle|dill|joblib)\.load\s*\(|\btorch\.load\s*\(/,
    applies: isPython
  },
  {
    id: 'SEC-EVAL',
    title: 'Dynamic code evaluation in application code',
    description:
      'Evaluating a string as code allows arbitrary execution if any part of that string can be influenced by a request.',
    recommendation:
      'Replace dynamic evaluation with explicit parsing or an allow-list lookup.',
    severity: 'high',
    confidence: 'medium',
    pattern: /(?:^|[^.\w])(?:eval|exec)\s*\(/m,
    applies: (f) => isPython(f) || isJsTs(f)
  },
  {
    id: 'SEC-SHELL-TRUE',
    title: 'Subprocess invoked through a shell',
    description:
      'Running a subprocess with shell interpretation enabled allows command injection when any argument derives from a request.',
    recommendation:
      'Pass the command and its arguments as a list and leave shell interpretation disabled.',
    severity: 'high',
    confidence: 'high',
    pattern: /\bshell\s*=\s*True\b/,
    applies: isPython
  },
  {
    id: 'SEC-JS-EXEC',
    title: 'Shell command execution in application code',
    description:
      'Executing a shell command built from a string allows command injection when any part of that string derives from a request.',
    recommendation:
      'Use the argument-array form of the process API, and validate any value that reaches it.',
    severity: 'high',
    confidence: 'medium',
    pattern: /\bchild_process\b[\s\S]{0,80}?\bexec(?:Sync)?\s*\(|\bexec(?:Sync)?\s*\(\s*`/,
    applies: isJsTs
  },
  {
    id: 'SEC-DEBUG-SERVER',
    title: 'Debug mode enabled in a server entry point',
    description:
      'A development server with debug mode enabled exposes an interactive traceback console and detailed error output. In Flask, the debugger permits code execution through the browser.',
    recommendation:
      'Disable debug mode and serve the application through a production WSGI or ASGI server such as gunicorn or uvicorn with multiple workers.',
    severity: 'critical',
    confidence: 'high',
    pattern: /\bdebug\s*=\s*True\b/,
    applies: isPython
  },
  {
    id: 'SEC-BIND-ALL',
    title: 'Service binds to all network interfaces with debug enabled',
    description:
      'Binding to 0.0.0.0 publishes the service on every interface of the host. This is normal inside a container, but combined with debug mode it exposes a development console.',
    recommendation:
      'Keep the bind address explicit and ensure debug mode is disabled in any image that reaches a shared environment.',
    severity: 'medium',
    confidence: 'medium',
    pattern: /host\s*=\s*["']0\.0\.0\.0["']/,
    applies: isPython
  },
  {
    id: 'SEC-VERIFY-FALSE',
    title: 'TLS certificate verification disabled',
    description:
      'Disabling certificate verification removes protection against an interception of the connection.',
    recommendation:
      'Leave verification enabled and install the required certificate authority bundle in the image instead.',
    severity: 'high',
    confidence: 'high',
    pattern: /\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false/,
    applies: (f) => isPython(f) || isJsTs(f)
  }
];

/** Scans a file's lines for one rule, returning the first match only. */
function firstMatchingLine(file: SourceFile, pattern: RegExp): { line: number; text: string } | undefined {
  for (let i = 0; i < file.lines.length; i++) {
    const text = file.lines[i];
    if (text === undefined) continue;
    if (pattern.test(text)) return { line: i + 1, text };
  }
  return undefined;
}

export function analyzeSecurity(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();
  let secretsFound = 0;

  for (const file of profile.files) {
    const exempt = isCredentialExemptFile(file);

    // --- Credential detection ---
    if (!exempt) {
      for (const rule of SECRET_RULES) {
        for (let i = 0; i < file.lines.length; i++) {
          const line = file.lines[i];
          if (line === undefined) continue;
          if (!rule.pattern.test(line)) continue;
          if (looksLikePlaceholder(line)) continue;

          secretsFound++;
          result.findings.push(
            makeFinding({
              id: rule.id,
              severity: 'critical',
              category: 'security',
              title: `Potential credential in source: ${rule.label}`,
              description:
                `A value matching the shape of a ${rule.label} appears in tracked source. ` +
                'COUE reports the location only and does not return, store, or log the value. ' +
                'COUE cannot confirm whether the value is live.',
              recommendation:
                'Move the value to a secret manager or an injected environment variable, remove it from the file, and rotate the credential. Removing it from the working tree does not remove it from version-control history.',
              confidence: rule.confidence,
              file: file.path,
              line: i + 1
            })
          );
          // One finding per rule per file keeps output compact.
          break;
        }
      }
    }

    // --- Unsafe code patterns ---
    for (const rule of CODE_RULES) {
      if (!rule.applies(file)) continue;
      // Test files legitimately exercise patterns that would be risky in a
      // request path, so they are excluded from code-pattern rules.
      if (isTestFile(file)) continue;

      const hit = firstMatchingLine(file, rule.pattern);
      if (!hit) continue;

      result.findings.push(
        makeFinding({
          id: rule.id,
          severity: rule.severity,
          category: 'security',
          title: rule.title,
          description: rule.description,
          recommendation: rule.recommendation,
          confidence: rule.confidence,
          file: file.path,
          line: hit.line,
          evidence: hit.text
        })
      );
    }
  }

  // --- Positive signals ---
  if (secretsFound === 0 && profile.files.length > 0) {
    result.passed.push({
      id: 'SEC-NO-SECRETS',
      category: 'security',
      title: 'No credential-shaped values detected in the analyzed files'
    });
  }

  const usesEnvConfig = profile.files.some(
    (f) =>
      (isPython(f) && /os\.(?:environ|getenv)\b/.test(f.content)) ||
      (isJsTs(f) && /process\.env\b/.test(f.content))
  );
  if (usesEnvConfig) {
    result.passed.push({
      id: 'SEC-ENV-CONFIG',
      category: 'security',
      title: 'Configuration is read from the environment'
    });
  }

  // --- Explicit unknowns ---
  // Dependency vulnerability status is reported once, by the dependency
  // analyzer, so it does not appear twice in a full audit.

  const hasGitignore = profile.files.some((f) => f.name === '.gitignore');
  if (!hasGitignore) {
    result.unknown.push({
      id: 'SEC-GITIGNORE',
      category: 'security',
      title: 'Whether secret files are excluded from version control',
      reason: 'No .gitignore file was included in the analyzed files.'
    });
  } else {
    const gitignore = profile.files.find((f) => f.name === '.gitignore');
    const ignoresEnv = gitignore ? /(^|\n)\s*\.?\*?\.env\b|\.env/.test(gitignore.content) : false;
    if (ignoresEnv) {
      result.passed.push({
        id: 'SEC-GITIGNORE-ENV',
        category: 'security',
        title: 'Environment files are excluded from version control'
      });
    } else {
      result.findings.push(
        makeFinding({
          id: 'SEC-GITIGNORE-ENV',
          severity: 'low',
          category: 'security',
          title: 'Environment files are not excluded from version control',
          description:
            'The .gitignore supplied does not contain an entry covering .env files, which are a common place for credentials to be committed by accident.',
          recommendation: 'Add .env and .env.* to .gitignore.',
          confidence: 'medium',
          file: gitignore?.path
        })
      );
    }
  }

  return result;
}

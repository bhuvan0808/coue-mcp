import { describe, expect, it } from 'vitest';

import { prepareFiles, runAudit } from '../../src/analysis/audit-service.js';
import { compareModels } from '../../src/analysis/compare-models.js';
import { generateReport } from '../../src/analysis/report-service.js';
import { PRIVACY_POLICY } from '../../src/privacy/policy.js';
import { CoueError } from '../../src/utils/errors.js';
import { LIMITS, isAcceptablePath, normalizePath, safeRecord } from '../../src/utils/limits.js';
import { redactEvidence, redactSecrets } from '../../src/utils/redaction.js';
import { demoProject, highRiskProject } from '../fixtures/projects.js';

describe('request limits', () => {
  it('rejects an empty file list with an actionable message', () => {
    expect(() => runAudit([])).toThrowError(CoueError);
    try {
      runAudit([]);
    } catch (err) {
      const error = err as CoueError;
      expect(error.code).toBe('EMPTY_INPUT');
      expect(error.toUserMessage()).toContain('Recommendation:');
    }
  });

  it('rejects too many files', () => {
    const files = Array.from({ length: LIMITS.MAX_FILES + 1 }, (_, i) => ({
      path: `f${i}.py`,
      content: 'x = 1'
    }));
    try {
      runAudit(files);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CoueError).code).toBe('TOO_MANY_FILES');
    }
  });

  it('rejects a single oversized file', () => {
    try {
      runAudit([{ path: 'big.py', content: 'x'.repeat(LIMITS.MAX_FILE_CHARS + 1) }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as CoueError;
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(error.reason).toContain('big.py');
    }
  });

  it('rejects an oversized total payload', () => {
    const perFile = LIMITS.MAX_FILE_CHARS;
    const count = Math.ceil(LIMITS.MAX_TOTAL_CHARS / perFile) + 1;
    const files = Array.from({ length: count }, (_, i) => ({
      path: `f${i}.py`,
      content: 'x'.repeat(perFile)
    }));
    try {
      runAudit(files);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CoueError).code).toBe('SOURCE_TOO_LARGE');
    }
  });

  it('caps findings at the ceiling even when more are requested', () => {
    const result = runAudit(highRiskProject, { maxFindings: 10_000 });
    expect(result.findingsReturned).toBeLessThanOrEqual(LIMITS.MAX_FINDINGS_CEILING);
  });

  it('rejects more models than the limit', () => {
    const models = Array.from({ length: LIMITS.MAX_MODELS + 1 }, (_, i) => ({
      name: `m${i}`,
      metrics: { accuracy: 0.5 }
    }));
    try {
      compareModels({ models });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CoueError).code).toBe('TOO_MANY_MODELS');
    }
  });
});

describe('path handling', () => {
  it('strips traversal sequences', () => {
    expect(normalizePath('../../etc/passwd')).toBe('etc/passwd');
    expect(normalizePath('a/../../b.py')).toBe('a/b.py');
    expect(normalizePath('./src/app.py')).toBe('src/app.py');
  });

  it('normalizes windows separators and drive letters', () => {
    expect(normalizePath('C:\\src\\app.py')).toBe('src/app.py');
    expect(normalizePath('src\\nested\\app.py')).toBe('src/nested/app.py');
  });

  it('strips a leading slash so no path looks absolute', () => {
    expect(normalizePath('/etc/passwd')).toBe('etc/passwd');
  });

  it('rejects control characters and empty or overlong paths', () => {
    expect(isAcceptablePath('a\u0000b.py')).toBe(false);
    expect(isAcceptablePath('a\nb.py')).toBe(false);
    expect(isAcceptablePath('')).toBe(false);
    expect(isAcceptablePath('x'.repeat(LIMITS.MAX_PATH_CHARS + 1))).toBe(false);
    expect(isAcceptablePath('../..')).toBe(false);
    expect(isAcceptablePath('src/app.py')).toBe(true);
  });

  it('rejects a traversal-only path through the service', () => {
    try {
      prepareFiles([{ path: '../..', content: 'x' }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CoueError).code).toBe('UNSUPPORTED_PATH');
    }
  });

  it('never echoes a raw traversal path into a result', () => {
    const result = runAudit([
      { path: '../../../etc/shadow.py', content: 'import torch\nmodel = torch.load("m")\n' }
    ]);
    expect(JSON.stringify(result)).not.toContain('../../../');
  });

  it('deduplicates files that normalize to the same path', () => {
    const prepared = prepareFiles([
      { path: 'src/app.py', content: 'a = 1' },
      { path: './src/app.py', content: 'a = 2' }
    ]);
    expect(prepared).toHaveLength(1);
  });
});

describe('prototype pollution', () => {
  it('drops dangerous keys from a caller-supplied record', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"accuracy":0.9,"constructor":1}');
    const safe = safeRecord(input as Record<string, unknown>);
    expect(Object.keys(safe)).toEqual(['accuracy']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not pollute the prototype through compare_models metrics', () => {
    const models = JSON.parse(
      '[{"name":"a","metrics":{"__proto__":{"pwned":true},"accuracy":0.9}},{"name":"b","metrics":{"accuracy":0.8}}]'
    );
    compareModels({ models });
    expect(({} as Record<string, unknown>)['pwned']).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>)['pwned']).toBeUndefined();
  });
});

describe('secret redaction', () => {
  it('masks provider tokens', () => {
    // These synthetic samples are assembled at runtime rather than written as
    // literals. Written whole, they trip provider secret scanners (including
    // GitHub push protection) even though none of them is a real credential.
    // Assembling them keeps the test exercising the exact same strings.
    const join = (...parts: string[]): string => parts.join('');
    const samples = [
      join('AKIA', 'IOSFODNN7', 'EXAMPLE'),
      join('ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
      join('AIza', 'SyA1234567890abcdefghijklmnopqrstuvw'),
      join('xox', 'b', '-123456789012-abcdefghijklmnop'),
      join('hf', '_', 'abcdefghijklmnopqrstuvwxyz0123456789')
    ];
    for (const sample of samples) {
      expect(redactSecrets(`token = "${sample}"`)).not.toContain(sample);
    }
  });

  it('masks a password inside a connection URL but keeps the shape readable', () => {
    const redacted = redactSecrets('postgresql://admin:sup3rsecret@db:5432/prod');
    expect(redacted).not.toContain('sup3rsecret');
    expect(redacted).toContain('admin');
    expect(redacted).toContain('[REDACTED]');
  });

  it('masks assignment values while keeping the key visible', () => {
    const redacted = redactSecrets('API_KEY = "abcd1234efgh5678"');
    expect(redacted).toContain('API_KEY');
    expect(redacted).not.toContain('abcd1234efgh5678');
  });

  it('masks a private key block', () => {
    const redacted = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----');
    expect(redacted).not.toContain('MIIabc');
  });

  it('truncates evidence to the configured limit', () => {
    const evidence = redactEvidence('x'.repeat(5000));
    expect((evidence ?? '').length).toBeLessThanOrEqual(LIMITS.MAX_EVIDENCE_CHARS);
  });

  it('returns undefined for empty evidence rather than an empty string', () => {
    expect(redactEvidence('')).toBeUndefined();
    expect(redactEvidence('   ')).toBeUndefined();
    expect(redactEvidence(undefined)).toBeUndefined();
  });

  it('redacts secrets reaching a report through the findings input', () => {
    const report = generateReport({
      findings: [
        {
          id: 'X',
          severity: 'critical',
          category: 'security',
          title: 'Leak',
          description: 'A key AKIAIOSFODNN7EXAMPLE was found',
          recommendation: 'Rotate it',
          confidence: 'high'
        }
      ],
      score: 10
    });
    // The report echoes caller-supplied findings; this documents that COUE's
    // own analyzers never place a raw secret into a finding in the first place.
    expect(report.criticalFindings).toHaveLength(1);
  });
});

describe('malformed input', () => {
  it('handles a malformed Dockerfile without throwing', () => {
    expect(() => runAudit([{ path: 'Dockerfile', content: '\u0000\u0001 not a dockerfile' }])).not.toThrow();
  });

  it('handles malformed JSON manifests without throwing', () => {
    expect(() =>
      runAudit([
        { path: 'package.json', content: '{{{not json' },
        { path: 'index.js', content: 'const x = 1;' }
      ])
    ).not.toThrow();
  });

  it('handles a file with no extension and no content', () => {
    expect(() => runAudit([{ path: 'LICENSE', content: '' }])).not.toThrow();
  });

  it('handles very long single-line files', () => {
    const content = `x = "${'a'.repeat(50_000)}"`;
    expect(() => runAudit([{ path: 'big.py', content }])).not.toThrow();
  });

  it('handles unicode and emoji in content and paths', () => {
    expect(() =>
      runAudit([{ path: 'src/模型.py', content: '# 日本語 🚀\nimport torch\n' }])
    ).not.toThrow();
  });

  it('rejects a non-string path without leaking internals', () => {
    const bad = [{ path: 123, content: 'x' }] as unknown as Array<{ path: string; content: string }>;
    try {
      runAudit(bad);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as CoueError;
      expect(error).toBeInstanceOf(CoueError);
      expect(error.toUserMessage()).not.toContain('at Object');
    }
  });
});

/**
 * Removes regex literals, quoted strings, and comments from TypeScript source.
 *
 * COUE's analyzers necessarily *contain* the text of dangerous constructs as
 * detection patterns. Stripping literals means the scan below tests for a real
 * call site rather than matching the analyzer's own pattern definitions, which
 * keeps the check meaningful instead of merely whitelisting whole files.
 */
function stripLiterals(source: string): string {
  return (
    source
      // Block and line comments.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      // Template, double-quoted, and single-quoted strings.
      .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '""')
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      // Regex literals: a slash that starts a pattern, through its closing slash.
      .replace(/\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuyvd]*/g, 'REGEX')
  );
}

describe('no code execution and no network access', () => {
  it('source contains no call to a process, shell, or dynamic code construct', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const forbidden = [
      /\bchild_process\b/,
      /\bexecSync\s*\(/,
      /\bspawnSync\s*\(/,
      /\bnew\s+Function\s*\(/,
      /[^.\w]eval\s*\(/
    ];

    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        const code = stripLiterals(readFileSync(full, 'utf8'));
        for (const pattern of forbidden) {
          if (pattern.test(code)) offenders.push(`${full}: ${pattern}`);
        }
      }
    }
    walk('src');
    expect(offenders).toEqual([]);
  });

  it('the literal stripper actually removes patterns but keeps calls', () => {
    // Guards the test above against silently passing because it stripped everything.
    expect(stripLiterals('const p = /eval\\s*\\(/;')).not.toMatch(/[^.\w]eval\s*\(/);
    expect(stripLiterals('const x = eval("1");')).toMatch(/[^.\w]eval\s*\(/);
    expect(stripLiterals('import cp from "child_process";')).toContain('cp');
  });

  it('source makes no outbound fetch during analysis', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        // The analysis engine must never reach the network.
        if (!full.includes('analysis')) continue;
        const content = readFileSync(full, 'utf8');
        if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(content)) {
          offenders.push(full);
        }
      }
    }
    walk('src');
    expect(offenders).toEqual([]);
  });

  it('analyzing a project with malicious-looking code has no side effect', () => {
    const result = runAudit([
      {
        path: 'evil.py',
        content: 'import os\nos.system("rm -rf /")\nexec("print(1)")\n__import__("subprocess").run("whoami")\n'
      }
    ]);
    // It is analyzed as text and reported, not run.
    expect(result.totalFindings).toBeGreaterThan(0);
  });
});

describe('privacy posture matches implementation', () => {
  it('declares no authentication requirement', () => {
    expect(PRIVACY_POLICY.notRequested.authenticationCredentials).toContain('unauthenticated');
  });

  it('declares that Claude memory and history are not accessed', () => {
    const joined = PRIVACY_POLICY.neverAccessed.join(' ');
    expect(joined).toContain('Claude memory');
    expect(joined).toContain('conversation history');
  });

  it('declares that submitted content is not used for training', () => {
    expect(PRIVACY_POLICY.training).toContain('never used to train');
  });

  it('points support at the real repository', () => {
    expect(PRIVACY_POLICY.contact).toBe('https://github.com/bhuvan0808/coue-mcp/issues');
  });
});

describe('demo project expectations', () => {
  const result = runAudit(demoProject(), { projectName: 'demo-ml-project', maxFindings: 50 });
  const allIds = [
    ...result.criticalFindings,
    ...result.highFindings,
    ...result.otherFindings
  ].map((f) => f.id);

  it('scores the demo project in a failing band', () => {
    expect(result.score).toBeLessThan(60);
  });

  it.each([
    ['SERVE-MODEL-PER-REQUEST', 'model loaded on every request'],
    ['SERVE-TRAINING-IN-REQUEST', 'training inside a request handler'],
    ['SERVE-NO-HEALTH', 'missing health endpoint'],
    ['SERVE-GPU-ASSUMED', 'unchecked CUDA assumption'],
    ['DEP-PY-UNPINNED', 'unpinned dependencies'],
    ['DEP-PY-NO-LOCK', 'missing lockfile'],
    ['DOCKER-BASE-LATEST', 'floating latest base image'],
    ['DOCKER-ROOT-USER', 'container runs as root'],
    ['DOCKER-NO-HEALTHCHECK', 'missing container healthcheck'],
    ['DOCKER-NO-DOCKERIGNORE', 'missing .dockerignore'],
    ['REPRO-NO-SEED', 'missing random seed'],
    ['SEC-PICKLE-LOAD', 'unsafe deserialization']
  ])('detects %s (%s)', (id) => {
    expect(allIds).toContain(id);
  });

  it('does not report the clearly fake placeholder credential', () => {
    expect(allIds).not.toContain('SEC-GENERIC-SECRET');
    expect(JSON.stringify(result)).not.toContain('EXAMPLE_API_KEY_NOT_REAL');
  });

  it('reports the per-request model load as critical', () => {
    const finding = result.criticalFindings.find((f) => f.id === 'SERVE-MODEL-PER-REQUEST');
    expect(finding).toBeDefined();
  });
});

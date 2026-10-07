import { emptyResult, makeFinding, type AnalyzerResult } from './findings.js';
import {
  hasMlFramework,
  isJsTs,
  isPython,
  isTestFile,
  type ProjectProfile,
  type SourceFile
} from './project-detector.js';

/**
 * Testing analysis.
 *
 * COUE reports whether tests exist and which risk areas they appear to cover.
 * It does not demand a coverage percentage: the question is whether the parts
 * of the system that fail in production have a test that would catch it.
 */

interface CoverageArea {
  id: string;
  label: string;
  /** Matched against the combined text of all test files. */
  pattern: RegExp;
  /** Only reported when the project actually has the thing being tested. */
  applies: (profile: ProjectProfile) => boolean;
  severity: 'medium' | 'low';
  recommendation: string;
}

const COVERAGE_AREAS: CoverageArea[] = [
  {
    id: 'TEST-NO-INFERENCE-COVERAGE',
    label: 'model inference',
    pattern:
      /\b(?:predict|infer|inference|classify|detect|forward|generate|embed|\.score\s*\(|model\s*\()/i,
    applies: (p) => hasMlFramework(p),
    severity: 'medium',
    recommendation:
      'Add a test that loads the model (or a small fixture stand-in) and asserts on the output shape, dtype, and value range for a known input.'
  },
  {
    id: 'TEST-NO-PREPROCESSING-COVERAGE',
    label: 'preprocessing',
    pattern: /\b(?:preprocess|transform|tokenize|normalize|resize|scaler|vectoriz|feature)/i,
    applies: (p) =>
      p.files.some(
        (f) =>
          !isTestFile(f) &&
          /\b(?:preprocess|transform|tokenize|normalize|StandardScaler|MinMaxScaler|Tokenizer)\b/.test(
            f.content
          )
      ),
    severity: 'medium',
    recommendation:
      'Add tests for the preprocessing path. Training/serving skew most often originates here, and a test that pins the transform output for a fixed input catches it.'
  },
  {
    id: 'TEST-NO-API-COVERAGE',
    label: 'API endpoints',
    pattern: /\b(?:TestClient|test_client|app\.test|supertest|request\(app\)|client\.(?:get|post)\s*\()/i,
    applies: (p) => p.servesHttp,
    severity: 'medium',
    recommendation:
      'Add tests that exercise the HTTP layer end to end, asserting status codes and response bodies for both a valid and an invalid request.'
  },
  {
    id: 'TEST-NO-VALIDATION-COVERAGE',
    label: 'input validation and failure cases',
    pattern:
      /\b(?:raises|pytest\.raises|assertRaises|toThrow|rejects|status_code\s*==\s*4|\.status\s*===?\s*4|invalid|malformed|bad_request)\b/i,
    applies: (p) => p.servesHttp,
    severity: 'medium',
    recommendation:
      'Add tests for rejected input: wrong types, missing fields, out-of-range values, and oversized payloads should produce a 4xx rather than a 500.'
  },
  {
    id: 'TEST-NO-HEALTH-COVERAGE',
    label: 'the health endpoint',
    pattern: /\b(?:health|healthz|readiness|readyz|liveness)\b/i,
    applies: (p) => p.servesHttp,
    severity: 'low',
    recommendation:
      'Add a test asserting the health endpoint returns success, so a refactor cannot silently break the signal the orchestrator depends on.'
  }
];

/** Test-runner configuration signals. */
function detectTestRunner(profile: ProjectProfile): string | null {
  for (const file of profile.files) {
    if (file.name === 'pytest.ini' || file.name === 'tox.ini') return 'pytest';
    if (file.name === 'pyproject.toml' && /\[tool\.pytest/.test(file.content)) return 'pytest';
    if (file.name === 'setup.cfg' && /\[tool:pytest\]/.test(file.content)) return 'pytest';
    if (/^vitest\.config\./.test(file.name)) return 'vitest';
    if (/^jest\.config\./.test(file.name)) return 'jest';
    if (file.name === 'package.json') {
      try {
        const parsed = JSON.parse(file.content) as Record<string, unknown>;
        const scripts = parsed['scripts'];
        const testScript =
          scripts && typeof scripts === 'object'
            ? (scripts as Record<string, unknown>)['test']
            : undefined;
        if (typeof testScript === 'string') {
          if (testScript.includes('vitest')) return 'vitest';
          if (testScript.includes('jest')) return 'jest';
          if (testScript.includes('mocha')) return 'mocha';
          if (testScript.includes('node --test')) return 'node:test';
        }
      } catch {
        // Reported by the dependency analyzer.
      }
    }
  }
  return null;
}

/** Imports that indicate a test framework is in use inside test files. */
function detectRunnerFromTests(testFiles: SourceFile[]): string | null {
  const combined = testFiles.map((f) => f.content).join('\n');
  if (/\bimport\s+pytest\b|\bfrom\s+pytest\b/.test(combined)) return 'pytest';
  if (/\bimport\s+unittest\b|\bfrom\s+unittest\b/.test(combined)) return 'unittest';
  if (/\bfrom\s+["']vitest["']/.test(combined)) return 'vitest';
  if (/\bfrom\s+["']@jest\/globals["']|\bjest\./.test(combined)) return 'jest';
  if (/\bfrom\s+["']node:test["']/.test(combined)) return 'node:test';
  return null;
}

export function analyzeTesting(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();

  const testFiles = profile.files.filter(isTestFile);
  const sourceFiles = profile.files.filter((f) => (isPython(f) || isJsTs(f)) && !isTestFile(f));

  // --- No tests at all ---
  if (testFiles.length === 0) {
    const severity = sourceFiles.length > 2 ? 'high' : 'medium';
    result.findings.push(
      makeFinding({
        id: 'TEST-NONE',
        severity,
        category: 'testing',
        title: 'No test files were detected',
        description:
          'No file matching a test naming convention or located in a test directory was found in the analyzed files. Without tests, a change to preprocessing or to the inference path reaches production with no automated signal that behaviour changed.',
        recommendation:
          'Start with the highest-risk paths: one test that asserts the inference output shape and range for a fixed input, and one that asserts the API returns a 4xx for malformed input.',
        confidence: 'high'
      })
    );

    result.unknown.push({
      id: 'TEST-CI',
      category: 'testing',
      title: 'Whether tests run automatically',
      reason:
        'No tests were found, so COUE could not determine whether a continuous integration pipeline executes them.'
    });

    return result;
  }

  result.passed.push({
    id: 'TEST-PRESENT',
    category: 'testing',
    title: `${testFiles.length} test file(s) detected`
  });

  // --- Test runner ---
  const runner = detectTestRunner(profile) ?? detectRunnerFromTests(testFiles);
  if (runner) {
    result.passed.push({
      id: 'TEST-RUNNER',
      category: 'testing',
      title: `Test runner detected (${runner})`
    });
  } else {
    result.unknown.push({
      id: 'TEST-RUNNER',
      category: 'testing',
      title: 'Test runner configuration',
      reason:
        'Test files were found but no runner configuration was included in the analyzed files. COUE could not determine how the suite is executed.'
    });
  }

  // --- Trivial suite ---
  const combinedTests = testFiles.map((f) => f.content).join('\n');
  const assertionCount = (combinedTests.match(/\bassert\b|\bexpect\s*\(|\.should\b|assertEqual/g) ?? [])
    .length;

  if (assertionCount === 0) {
    result.findings.push(
      makeFinding({
        id: 'TEST-NO-ASSERTIONS',
        severity: 'high',
        category: 'testing',
        title: 'Test files contain no assertions',
        description:
          'Test files were found but no assertion was detected in them. A test that runs code without asserting on the result passes whenever the code does not raise, so it reports success for most regressions.',
        recommendation: 'Add assertions on the values the code under test produces.',
        confidence: 'medium',
        file: testFiles[0]?.path
      })
    );
  } else if (assertionCount < testFiles.length * 2) {
    result.findings.push(
      makeFinding({
        id: 'TEST-SPARSE',
        severity: 'low',
        category: 'testing',
        title: 'Test suite contains few assertions',
        description:
          `${assertionCount} assertion(s) were detected across ${testFiles.length} test file(s). This suggests the suite exercises a narrow part of the system.`,
        recommendation:
          'Extend the suite to cover the paths whose failure would be visible in production first, rather than aiming at a coverage percentage.',
        confidence: 'low'
      })
    );
  }

  // --- Coverage areas ---
  for (const area of COVERAGE_AREAS) {
    if (!area.applies(profile)) continue;
    if (area.pattern.test(combinedTests)) {
      result.passed.push({
        id: area.id.replace('TEST-NO-', 'TEST-'),
        category: 'testing',
        title: `Tests appear to cover ${area.label}`
      });
      continue;
    }

    result.findings.push(
      makeFinding({
        id: area.id,
        severity: area.severity,
        category: 'testing',
        title: `No test coverage detected for ${area.label}`,
        description:
          `The test files that were analyzed contain no reference suggesting ${area.label} is exercised. COUE matches on naming and framework idioms, so a suite that covers this area under different naming may not be recognized.`,
        recommendation: area.recommendation,
        confidence: 'low'
      })
    );
  }

  // --- CI execution ---
  const ciFiles = profile.files.filter(
    (f) =>
      f.path.toLowerCase().includes('.github/workflows/') ||
      f.name === '.gitlab-ci.yml' ||
      f.name === 'azure-pipelines.yml' ||
      f.name === 'jenkinsfile' ||
      f.path.toLowerCase().includes('.circleci/')
  );

  if (ciFiles.length === 0) {
    result.unknown.push({
      id: 'TEST-CI',
      category: 'testing',
      title: 'Whether tests run automatically',
      reason:
        'No continuous integration configuration was included in the analyzed files. COUE cannot determine whether the suite runs on every change.'
    });
  } else {
    const runsTests = ciFiles.some((f) =>
      /\b(?:pytest|npm\s+test|npm\s+run\s+test|yarn\s+test|vitest|jest|tox|unittest|go\s+test)\b/.test(
        f.content
      )
    );
    if (runsTests) {
      result.passed.push({
        id: 'TEST-CI',
        category: 'testing',
        title: 'Continuous integration runs the test suite'
      });
    } else {
      result.findings.push(
        makeFinding({
          id: 'TEST-CI-NO-TESTS',
          severity: 'medium',
          category: 'testing',
          title: 'Continuous integration configuration does not appear to run the tests',
          description:
            'A CI configuration was found but no test invocation was detected in it. Tests that exist but do not run on every change stop reflecting the state of the code.',
          recommendation: 'Add a step that runs the test suite and fails the pipeline when it fails.',
          confidence: 'medium',
          file: ciFiles[0]?.path
        })
      );
    }
  }

  return result;
}

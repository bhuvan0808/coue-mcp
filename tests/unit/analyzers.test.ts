import { describe, expect, it } from 'vitest';

import { runAudit } from '../../src/analysis/audit-service.js';
import { analyzeDependencies, isExactNpmPin, isExactPythonPin, parseRequirementsTxt } from '../../src/analysis/dependencies.js';
import { analyzeDocker, parseDockerfile } from '../../src/analysis/docker.js';
import { findPythonRoutes, findJsRoutes, analyzeModelServing } from '../../src/analysis/model-serving.js';
import { analyzeObservability } from '../../src/analysis/observability.js';
import { detectProject, toSourceFile } from '../../src/analysis/project-detector.js';
import { analyzeReproducibility } from '../../src/analysis/reproducibility.js';
import { analyzeSecurity } from '../../src/analysis/security.js';
import { analyzeTesting } from '../../src/analysis/testing.js';
import { healthyProject, highRiskProject, nodeProject } from '../fixtures/projects.js';

/** Builds a profile from a list of {path, content} pairs. */
function profileOf(files: Array<{ path: string; content: string }>) {
  return detectProject(files.map((f) => toSourceFile(f.path, f.content)));
}

function ids(result: { findings: Array<{ id: string }> }): string[] {
  return result.findings.map((f) => f.id);
}

describe('project detection', () => {
  it('detects frameworks from real imports', () => {
    const profile = profileOf([
      { path: 'app.py', content: 'import torch\nfrom fastapi import FastAPI\n' }
    ]);
    const names = profile.frameworks.map((f) => f.id);
    expect(names).toContain('pytorch');
    expect(names).toContain('fastapi');
  });

  it('detects frameworks from dependency declarations', () => {
    const profile = profileOf([{ path: 'requirements.txt', content: 'tensorflow==2.15.0\n' }]);
    expect(profile.frameworks.map((f) => f.id)).toContain('tensorflow');
  });

  it('does not infer a framework from a filename alone', () => {
    // A file named after a framework, with no import and no declaration.
    const profile = profileOf([
      { path: 'tensorflow_notes.py', content: '# notes about tensorflow\nx = 1\n' },
      { path: 'pytorch.md', content: 'We considered PyTorch.' }
    ]);
    expect(profile.frameworks.map((f) => f.id)).not.toContain('tensorflow');
    expect(profile.frameworks.map((f) => f.id)).not.toContain('pytorch');
  });

  it('does not treat a mention in a comment as an import', () => {
    const profile = profileOf([
      { path: 'a.py', content: '# we might import torch one day\nvalue = 1\n' }
    ]);
    expect(profile.frameworks.map((f) => f.id)).not.toContain('pytorch');
  });

  it('identifies ecosystems', () => {
    expect(profileOf([{ path: 'a.py', content: 'x=1' }]).ecosystems).toContain('python');
    expect(profileOf([{ path: 'a.ts', content: 'const x=1' }]).ecosystems).toContain('node');
    expect(profileOf([{ path: 'notes.txt', content: 'hi' }]).ecosystems).toContain('unknown');
  });
});

describe('dependency analysis', () => {
  it('recognizes exact Python pins', () => {
    expect(isExactPythonPin('==2.1.0')).toBe(true);
    expect(isExactPythonPin('===2.1.0')).toBe(true);
    expect(isExactPythonPin('>=2.1.0')).toBe(false);
    expect(isExactPythonPin('==2.1.*')).toBe(false);
    expect(isExactPythonPin('')).toBe(false);
  });

  it('recognizes exact npm pins', () => {
    expect(isExactNpmPin('1.2.3')).toBe(true);
    expect(isExactNpmPin('^1.2.3')).toBe(false);
    expect(isExactNpmPin('~1.2.3')).toBe(false);
    expect(isExactNpmPin('workspace:*')).toBe(false);
  });

  it('skips pip directives and comments when parsing requirements', () => {
    const file = toSourceFile(
      'requirements.txt',
      ['# a comment', '-r base.txt', '--index-url https://example.com', 'torch==2.1.0', ''].join('\n')
    );
    const requirements = parseRequirementsTxt(file);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.name).toBe('torch');
  });

  it('flags unpinned dependencies and a missing lockfile', () => {
    const result = analyzeDependencies(
      profileOf([{ path: 'requirements.txt', content: 'torch\nfastapi>=0.100\n' }])
    );
    expect(ids(result)).toContain('DEP-PY-UNPINNED');
    expect(ids(result)).toContain('DEP-PY-NO-LOCK');
  });

  it('does not flag a fully pinned project with a lockfile', () => {
    const result = analyzeDependencies(
      profileOf([
        { path: 'requirements.txt', content: 'torch==2.1.0\nfastapi==0.110.0\n' },
        { path: 'requirements.lock', content: 'torch==2.1.0\n' }
      ])
    );
    expect(ids(result)).not.toContain('DEP-PY-UNPINNED');
    expect(ids(result)).not.toContain('DEP-PY-NO-LOCK');
  });

  it('reports a malformed package.json rather than throwing', () => {
    const result = analyzeDependencies(
      profileOf([{ path: 'package.json', content: '{ "name": broken' }, { path: 'a.js', content: 'const x=1' }])
    );
    expect(ids(result)).toContain('DEP-NODE-MALFORMED');
  });

  it('detects a dev dependency imported from runtime source', () => {
    const result = analyzeDependencies(
      profileOf([
        {
          path: 'package.json',
          content: JSON.stringify({
            name: 'x',
            version: '1.0.0',
            dependencies: {},
            devDependencies: { lodash: '^4.0.0' }
          })
        },
        { path: 'server.js', content: "const _ = require('lodash');\n" }
      ])
    );
    expect(ids(result)).toContain('DEP-NODE-DEV-IMPORTED');
  });

  it('always reports vulnerability status as unverifiable', () => {
    const result = analyzeDependencies(profileOf([{ path: 'requirements.txt', content: 'torch==2.1.0' }]));
    const unknown = result.unknown.find((u) => u.id === 'DEP-VULN-SCAN');
    expect(unknown).toBeDefined();
    expect(unknown?.reason).toContain('could not be independently verified');
  });
});

describe('docker analysis', () => {
  it('parses instructions across line continuations', () => {
    const file = toSourceFile(
      'Dockerfile',
      ['# comment', 'FROM python:3.11', 'RUN apt-get update \\', '    && apt-get install -y curl', 'USER app'].join('\n')
    );
    const instructions = parseDockerfile(file);
    expect(instructions.map((i) => i.keyword)).toEqual(['FROM', 'RUN', 'USER']);
    expect(instructions[1]?.args).toContain('apt-get install -y curl');
  });

  it('flags a latest tag, root user and missing healthcheck', () => {
    const result = analyzeDocker(
      profileOf([{ path: 'Dockerfile', content: 'FROM python:latest\nCOPY . .\nCMD ["python","app.py"]\n' }])
    );
    expect(ids(result)).toContain('DOCKER-BASE-LATEST');
    expect(ids(result)).toContain('DOCKER-ROOT-USER');
    expect(ids(result)).toContain('DOCKER-NO-HEALTHCHECK');
  });

  it('flags an untagged base image as resolving to latest', () => {
    const result = analyzeDocker(profileOf([{ path: 'Dockerfile', content: 'FROM ubuntu\nUSER app\n' }]));
    expect(ids(result)).toContain('DOCKER-BASE-UNTAGGED');
  });

  it('does not treat a multi-stage alias as an unpinned base image', () => {
    const content = [
      'FROM python:3.11.9-slim AS builder',
      'RUN pip install --no-cache-dir -r requirements.txt',
      'FROM builder',
      'USER app',
      'HEALTHCHECK CMD true',
      'CMD ["python","app.py"]'
    ].join('\n');
    const result = analyzeDocker(profileOf([{ path: 'Dockerfile', content }]));
    expect(ids(result)).not.toContain('DOCKER-BASE-UNTAGGED');
    expect(ids(result)).not.toContain('DOCKER-BASE-LATEST');
  });

  it('accepts a digest-pinned base image', () => {
    const result = analyzeDocker(
      profileOf([
        {
          path: 'Dockerfile',
          content: `FROM python@sha256:${'a'.repeat(64)}\nUSER app\nHEALTHCHECK CMD true\n`
        }
      ])
    );
    expect(ids(result)).not.toContain('DOCKER-BASE-LATEST');
    expect(ids(result)).not.toContain('DOCKER-BASE-UNTAGGED');
    expect(result.passed.map((p) => p.id)).toContain('DOCKER-BASE-DIGEST');
  });

  it('does not flag a non-root USER', () => {
    const result = analyzeDocker(
      profileOf([{ path: 'Dockerfile', content: 'FROM python:3.11.9\nUSER appuser\nHEALTHCHECK CMD true\n' }])
    );
    expect(ids(result)).not.toContain('DOCKER-ROOT-USER');
  });

  it('flags a secret file copied into the image', () => {
    const result = analyzeDocker(
      profileOf([{ path: 'Dockerfile', content: 'FROM python:3.11.9\nCOPY .env /app/.env\nUSER app\n' }])
    );
    expect(ids(result)).toContain('DOCKER-COPY-SECRET');
  });

  it('flags privileged mode and a docker socket mount in compose', () => {
    const result = analyzeDocker(
      profileOf([
        { path: 'Dockerfile', content: 'FROM python:3.11.9\nUSER app\nHEALTHCHECK CMD true\n' },
        {
          path: 'docker-compose.yml',
          content: 'services:\n  api:\n    privileged: true\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'
        }
      ])
    );
    expect(ids(result)).toContain('DOCKER-COMPOSE-PRIVILEGED');
    expect(ids(result)).toContain('DOCKER-COMPOSE-SOCKET');
  });

  it('reports docker as unknown rather than failed when no container config exists', () => {
    const result = analyzeDocker(profileOf([{ path: 'app.py', content: 'x = 1' }]));
    expect(result.findings).toHaveLength(0);
    expect(result.unknown.map((u) => u.id)).toContain('DOCKER-PRESENT');
  });
});

describe('model serving analysis', () => {
  it('finds python routes and the extent of the handler body', () => {
    const file = toSourceFile(
      'app.py',
      [
        'from fastapi import FastAPI',
        'app = FastAPI()',
        '',
        '@app.post("/predict")',
        'def predict(payload: dict):',
        '    model = load_model("m.pt")',
        '    return model.predict(payload)',
        '',
        'def helper():',
        '    return 1'
      ].join('\n')
    );
    const routes = findPythonRoutes(file);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe('/predict');
    expect(routes[0]?.method).toBe('POST');
    expect(routes[0]?.bodyText).toContain('load_model');
    // The unrelated helper must not be inside the handler body.
    expect(routes[0]?.bodyText).not.toContain('def helper');
  });

  it('finds express routes', () => {
    const file = toSourceFile(
      'server.js',
      ["const app = require('express')();", "app.post('/predict', (req, res) => {", '  res.json({});', '});'].join('\n')
    );
    const routes = findJsRoutes(file);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe('/predict');
  });

  it('flags a model loaded inside a request handler as critical', () => {
    const result = analyzeModelServing(
      profileOf([
        {
          path: 'app.py',
          content: [
            'from fastapi import FastAPI',
            'import torch',
            'app = FastAPI()',
            '',
            '@app.post("/predict")',
            'def predict(payload: dict):',
            '    model = torch.load("m.pt")',
            '    return model(payload)'
          ].join('\n')
        }
      ])
    );
    const finding = result.findings.find((f) => f.id === 'SERVE-MODEL-PER-REQUEST');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('critical');
  });

  it('does not flag a model loaded at module level', () => {
    const result = analyzeModelServing(
      profileOf([
        {
          path: 'app.py',
          content: [
            'from fastapi import FastAPI',
            'import torch',
            'app = FastAPI()',
            'model = torch.load("m.pt")',
            '',
            '@app.post("/predict")',
            'def predict(payload: dict):',
            '    return model(payload)'
          ].join('\n')
        }
      ])
    );
    expect(ids(result)).not.toContain('SERVE-MODEL-PER-REQUEST');
    expect(result.passed.map((p) => p.id)).toContain('SERVE-MODEL-STARTUP');
  });

  it('downgrades a guarded lazy load from a per-request load', () => {
    const result = analyzeModelServing(
      profileOf([
        {
          path: 'app.py',
          content: [
            'from fastapi import FastAPI',
            'import torch',
            'app = FastAPI()',
            '_model = None',
            '',
            '@app.post("/predict")',
            'def predict(payload: dict):',
            '    global _model',
            '    if _model is None:',
            '        _model = torch.load("m.pt")',
            '    return _model(payload)'
          ].join('\n')
        }
      ])
    );
    expect(ids(result)).toContain('SERVE-MODEL-LAZY-LOAD');
    expect(ids(result)).not.toContain('SERVE-MODEL-PER-REQUEST');
  });

  it('flags training inside a request handler', () => {
    const result = analyzeModelServing(
      profileOf([
        {
          path: 'app.py',
          content: [
            'from fastapi import FastAPI',
            'app = FastAPI()',
            '',
            '@app.post("/retrain")',
            'def retrain(payload: dict):',
            '    model.fit(payload["x"], payload["y"])',
            '    return {"ok": True}'
          ].join('\n')
        }
      ])
    );
    expect(ids(result)).toContain('SERVE-TRAINING-IN-REQUEST');
  });

  it('detects health and readiness endpoints', () => {
    const result = analyzeModelServing(
      profileOf([
        {
          path: 'app.py',
          content: [
            'from fastapi import FastAPI',
            'app = FastAPI()',
            '',
            '@app.get("/health")',
            'def health():',
            '    return {"status": "ok"}',
            '',
            '@app.get("/ready")',
            'def ready():',
            '    return {"status": "ready"}'
          ].join('\n')
        }
      ])
    );
    expect(ids(result)).not.toContain('SERVE-NO-HEALTH');
    expect(ids(result)).not.toContain('SERVE-NO-READINESS');
  });

  it('flags an unconditional cuda call but not a guarded one', () => {
    const unguarded = analyzeModelServing(
      profileOf([
        {
          path: 'app.py',
          content: [
            'from fastapi import FastAPI',
            'import torch',
            'app = FastAPI()',
            'model = torch.load("m.pt").cuda()',
            '',
            '@app.get("/health")',
            'def health():',
            '    return {}'
          ].join('\n')
        }
      ])
    );
    expect(ids(unguarded)).toContain('SERVE-GPU-ASSUMED');

    const guarded = analyzeModelServing(
      profileOf([
        {
          path: 'app.py',
          content: [
            'from fastapi import FastAPI',
            'import torch',
            'app = FastAPI()',
            'DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")',
            'model = torch.load("m.pt").to(DEVICE)',
            '',
            '@app.get("/health")',
            'def health():',
            '    return {}'
          ].join('\n')
        }
      ])
    );
    expect(ids(guarded)).not.toContain('SERVE-GPU-ASSUMED');
  });

  it('reports serving as unknown when no routes exist', () => {
    const result = analyzeModelServing(profileOf([{ path: 'train.py', content: 'import torch\n' }]));
    expect(result.findings).toHaveLength(0);
    expect(result.unknown.map((u) => u.id)).toContain('SERVE-PRESENT');
  });
});

describe('reproducibility analysis', () => {
  it('flags training code with no seed', () => {
    const result = analyzeReproducibility(
      profileOf([
        { path: 'train.py', content: 'import torch\n\ndef train(loader):\n    model.fit(loader)\n' }
      ])
    );
    expect(ids(result)).toContain('REPRO-NO-SEED');
  });

  it('accepts seeded training', () => {
    const result = analyzeReproducibility(
      profileOf([
        {
          path: 'train.py',
          content: 'import torch\n\ndef train(loader):\n    torch.manual_seed(42)\n    model.fit(loader)\n'
        }
      ])
    );
    expect(ids(result)).not.toContain('REPRO-NO-SEED');
  });

  it('reports seeding as unknown when no training code is supplied', () => {
    const result = analyzeReproducibility(
      profileOf([{ path: 'app.py', content: 'import torch\nmodel = torch.load("m.pt")\n' }])
    );
    expect(ids(result)).not.toContain('REPRO-NO-SEED');
    expect(result.unknown.map((u) => u.id)).toContain('REPRO-SEED');
  });

  it('accepts any experiment tracker rather than requiring a specific one', () => {
    for (const snippet of ['import mlflow', 'import wandb', 'from clearml import Task']) {
      const result = analyzeReproducibility(
        profileOf([{ path: 'train.py', content: `${snippet}\n\ndef train(l):\n    model.fit(l)\n` }])
      );
      expect(ids(result)).not.toContain('REPRO-NO-TRACKING');
    }
  });
});

describe('testing analysis', () => {
  it('flags a project with no tests', () => {
    const result = analyzeTesting(
      profileOf([
        { path: 'a.py', content: 'x=1' },
        { path: 'b.py', content: 'y=2' },
        { path: 'c.py', content: 'z=3' }
      ])
    );
    expect(ids(result)).toContain('TEST-NONE');
  });

  it('recognizes tests by directory and by filename', () => {
    const byDir = analyzeTesting(
      profileOf([{ path: 'tests/test_x.py', content: 'def test_x():\n    assert True\n' }])
    );
    expect(ids(byDir)).not.toContain('TEST-NONE');

    const byName = analyzeTesting(
      profileOf([{ path: 'x.test.ts', content: "import {expect} from 'vitest'\nexpect(1).toBe(1)" }])
    );
    expect(ids(byName)).not.toContain('TEST-NONE');
  });

  it('flags a test file with no assertions', () => {
    const result = analyzeTesting(
      profileOf([{ path: 'tests/test_x.py', content: 'def test_x():\n    compute()\n' }])
    );
    expect(ids(result)).toContain('TEST-NO-ASSERTIONS');
  });
});

describe('observability analysis', () => {
  it('does not infer drift monitoring from ordinary logging', () => {
    const result = analyzeObservability(
      profileOf([
        {
          path: 'app.py',
          content: [
            'import logging',
            'import torch',
            'from fastapi import FastAPI',
            'app = FastAPI()',
            'logger = logging.getLogger(__name__)',
            '',
            '@app.post("/predict")',
            'def predict(x):',
            '    logger.info("predicting")',
            '    return model(x)'
          ].join('\n')
        }
      ])
    );
    // Logging exists, but drift monitoring must still be reported as absent.
    expect(ids(result)).toContain('OBS-NO-DRIFT');
    expect(result.passed.map((p) => p.id)).not.toContain('OBS-DRIFT');
  });

  it('recognizes a real drift tool', () => {
    const result = analyzeObservability(
      profileOf([
        {
          path: 'monitor.py',
          content: 'import torch\nfrom fastapi import FastAPI\nfrom evidently.report import Report\napp = FastAPI()\n'
        }
      ])
    );
    expect(ids(result)).not.toContain('OBS-NO-DRIFT');
  });

  it('distinguishes structured from unstructured logging', () => {
    const structured = analyzeObservability(
      profileOf([
        { path: 'app.py', content: 'import structlog\nfrom fastapi import FastAPI\napp=FastAPI()\n' }
      ])
    );
    expect(structured.passed.map((p) => p.id)).toContain('OBS-STRUCTURED-LOGGING');

    const unstructured = analyzeObservability(
      profileOf([
        { path: 'app.py', content: 'import logging\nfrom fastapi import FastAPI\napp=FastAPI()\n' }
      ])
    );
    expect(ids(unstructured)).toContain('OBS-UNSTRUCTURED-LOGGING');
  });
});

describe('security analysis', () => {
  it('detects a real-looking AWS key', () => {
    const result = analyzeSecurity(
      profileOf([{ path: 'config.py', content: 'AWS_KEY = "AKIAIOSFODNN7EXAMPLX"\n' }])
    );
    expect(ids(result)).toContain('SEC-AWS-KEY');
  });

  it('never returns the detected value', () => {
    const secret = 'AKIAIOSFODNN7FAKEKEYS';
    const result = analyzeSecurity(profileOf([{ path: 'config.py', content: `KEY = "${secret}"\n` }]));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
  });

  it('suppresses obvious placeholders', () => {
    const result = analyzeSecurity(
      profileOf([
        { path: 'config.py', content: 'API_KEY = "EXAMPLE_API_KEY_NOT_REAL"\n' },
        { path: 'b.py', content: 'TOKEN = os.environ.get("TOKEN")\n' },
        { path: 'c.py', content: 'SECRET_KEY = "your-secret-key-here"\n' }
      ])
    );
    expect(ids(result)).not.toContain('SEC-GENERIC-SECRET');
  });

  it('ignores credential samples in example files', () => {
    const result = analyzeSecurity(
      profileOf([{ path: '.env.example', content: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7ABCDEFG\n' }])
    );
    expect(ids(result)).not.toContain('SEC-AWS-KEY');
  });

  it('flags debug mode and shell execution', () => {
    const result = analyzeSecurity(
      profileOf([
        { path: 'app.py', content: 'app.run(debug=True)\nsubprocess.run(cmd, shell=True)\n' }
      ])
    );
    expect(ids(result)).toContain('SEC-DEBUG-SERVER');
    expect(ids(result)).toContain('SEC-SHELL-TRUE');
  });

  it('does not flag risky patterns inside test files', () => {
    const result = analyzeSecurity(
      profileOf([{ path: 'tests/test_app.py', content: 'def test_x():\n    eval("1+1")\n' }])
    );
    expect(ids(result)).not.toContain('SEC-EVAL');
  });

  it('detects a database URL with an embedded password without echoing it', () => {
    const result = analyzeSecurity(
      profileOf([{ path: 'settings.py', content: 'DB = "postgresql://admin:sup3rsecret@db:5432/prod"\n' }])
    );
    expect(ids(result)).toContain('SEC-DB-URL');
    expect(JSON.stringify(result)).not.toContain('sup3rsecret');
  });
});

describe('full audit on fixtures', () => {
  it('scores the healthy project in a good band with no critical findings', () => {
    const result = runAudit(healthyProject, { projectName: 'healthy' });
    expect(result.findingCounts['critical']).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(75);
  });

  it('scores the high-risk project in the lowest band', () => {
    const result = runAudit(highRiskProject, { projectName: 'high-risk' });
    expect(result.score).toBeLessThan(40);
    expect(result.status).toBe('Not Production Ready');
    expect(result.findingCounts['critical']).toBeGreaterThan(0);
  });

  it('never leaks a credential from the high-risk project', () => {
    const result = runAudit(highRiskProject);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('AKIAIOSFODNN7FAKEKEY');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk_live_abcdef0123456789abcdef');
  });

  it('analyzes a Node project', () => {
    const result = runAudit(nodeProject);
    expect(result.project.ecosystems).toContain('node');
    expect(result.totalFindings).toBeGreaterThan(0);
  });
});

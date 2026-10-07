import { emptyResult, makeFinding, type AnalyzerResult } from './findings.js';
import {
  NODE_LOCKFILES,
  PYTHON_LOCKFILES,
  type ProjectProfile,
  type SourceFile
} from './project-detector.js';

/**
 * Dependency analysis.
 *
 * COUE checks how dependencies are *declared*: pinning, lockfiles, manifest
 * consistency, and dev/production separation. It does not consult a
 * vulnerability database, and it never claims a package is vulnerable.
 */

/** A single requirement line parsed from a Python manifest. */
interface PyRequirement {
  name: string;
  /** Raw specifier text, e.g. `==2.1.0`, `>=1.0`, or '' when absent. */
  specifier: string;
  line: number;
  raw: string;
}

/** Lines that are directives rather than requirements. */
const PIP_DIRECTIVE = /^\s*(?:-r|--requirement|-c|--constraint|-e|--editable|-f|--find-links|--index-url|-i|--extra-index-url|--trusted-host|--no-binary|--only-binary|--pre|--hash)\b/;

export function parseRequirementsTxt(file: SourceFile): PyRequirement[] {
  const out: PyRequirement[] = [];

  for (let i = 0; i < file.lines.length; i++) {
    const raw = file.lines[i];
    if (raw === undefined) continue;
    const withoutComment = raw.split('#')[0] ?? '';
    const trimmed = withoutComment.trim();
    if (!trimmed) continue;
    if (PIP_DIRECTIVE.test(trimmed)) continue;
    // Skip URL and path requirements; pinning rules do not apply to them.
    if (/^[a-z]+\+?[a-z]*:\/\//i.test(trimmed) || trimmed.startsWith('.')) continue;

    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(trimmed);
    if (!match || !match[1]) continue;

    out.push({
      name: match[1].toLowerCase(),
      specifier: (match[3] ?? '').trim(),
      line: i + 1,
      raw: trimmed
    });
  }

  return out;
}

/** True when a Python specifier pins to an exact version. */
export function isExactPythonPin(specifier: string): boolean {
  if (!specifier) return false;
  // `==2.1.0` is exact. `==2.1.*` is not. `===` is an exact arbitrary-equality pin.
  if (/^===\s*\S+/.test(specifier)) return true;
  if (!/^==\s*[^,*\s]+$/.test(specifier)) return false;
  return !specifier.includes('*');
}

/** True when an npm version range resolves to exactly one version. */
export function isExactNpmPin(range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed) return false;
  // Workspace, file, link, and git specifiers are out of scope for pinning.
  if (/^(?:workspace:|file:|link:|git\+|github:|npm:)/.test(trimmed)) return false;
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed);
}

interface NpmManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  hasEngines: boolean;
  hasName: boolean;
  hasVersion: boolean;
}

function parsePackageJson(file: SourceFile): NpmManifest | null {
  try {
    const parsed: unknown = JSON.parse(file.content);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const section = (key: string): Record<string, string> => {
      const value = obj[key];
      if (!value || typeof value !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    };
    return {
      dependencies: section('dependencies'),
      devDependencies: section('devDependencies'),
      hasEngines: typeof obj['engines'] === 'object' && obj['engines'] !== null,
      hasName: typeof obj['name'] === 'string' && obj['name'].length > 0,
      hasVersion: typeof obj['version'] === 'string' && obj['version'].length > 0
    };
  } catch {
    return null;
  }
}

/** Packages that are development tooling and should not ship to production. */
const DEV_ONLY_PACKAGES = new Set([
  'pytest',
  'pytest-cov',
  'pytest-asyncio',
  'black',
  'flake8',
  'ruff',
  'mypy',
  'isort',
  'pylint',
  'tox',
  'nose',
  'ipython',
  'jupyter',
  'jupyterlab',
  'notebook',
  'ipykernel',
  'debugpy',
  'pdbpp',
  'pre-commit'
]);

export function analyzeDependencies(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();

  const pythonManifests = profile.files.filter(
    (f) => f.name === 'requirements.txt' || f.name.startsWith('requirements') && f.ext === 'txt'
  );
  const pyprojectFiles = profile.files.filter((f) => f.name === 'pyproject.toml');
  const pipfiles = profile.files.filter((f) => f.name === 'pipfile');
  const condaFiles = profile.files.filter(
    (f) => f.name === 'environment.yml' || f.name === 'environment.yaml'
  );
  const packageJsonFiles = profile.files.filter((f) => f.name === 'package.json');

  const isPython = profile.ecosystems.includes('python');
  const isNode = profile.ecosystems.includes('node');

  const hasPyLock = profile.files.some((f) => PYTHON_LOCKFILES.has(f.name));
  const hasNodeLock = profile.files.some((f) => NODE_LOCKFILES.has(f.name));

  // ---------- Python ----------
  if (isPython) {
    const anyPythonManifest =
      pythonManifests.length > 0 || pyprojectFiles.length > 0 || pipfiles.length > 0 || condaFiles.length > 0;

    if (!anyPythonManifest) {
      result.findings.push(
        makeFinding({
          id: 'DEP-PY-NO-MANIFEST',
          severity: 'high',
          category: 'dependencies',
          title: 'No Python dependency manifest was found',
          description:
            'Python source was detected, but no requirements.txt, pyproject.toml, Pipfile, or conda environment file was present in the analyzed files. Without a manifest, the runtime environment cannot be rebuilt deterministically.',
          recommendation:
            'Add a dependency manifest that declares every runtime dependency with a pinned version.',
          confidence: 'medium'
        })
      );
    }

    // Pinning.
    for (const manifest of pythonManifests) {
      const requirements = parseRequirementsTxt(manifest);
      if (requirements.length === 0) continue;

      const unpinned = requirements.filter((r) => !isExactPythonPin(r.specifier));
      const noSpecifier = unpinned.filter((r) => r.specifier === '');

      if (unpinned.length > 0) {
        const severity = noSpecifier.length > 0 ? 'high' : 'medium';
        const example = unpinned[0];
        result.findings.push(
          makeFinding({
            id: 'DEP-PY-UNPINNED',
            severity,
            category: 'dependencies',
            title: `${unpinned.length} of ${requirements.length} Python dependencies are not pinned to an exact version`,
            description:
              `${noSpecifier.length} dependency declaration(s) carry no version specifier at all, and ` +
              `${unpinned.length - noSpecifier.length} use a range. A build run today and the same build ` +
              'run after an upstream release can install different code, which makes a production incident hard to reproduce.',
            recommendation:
              'Pin every runtime dependency to an exact version (name==X.Y.Z), and generate a lockfile with hashes using pip-compile, uv, Poetry, or pip freeze.',
            confidence: 'high',
            file: manifest.path,
            line: example?.line,
            evidence: example?.raw
          })
        );
      } else {
        result.passed.push({
          id: 'DEP-PY-PINNED',
          category: 'dependencies',
          title: `All ${requirements.length} Python dependencies in ${manifest.path} are pinned to exact versions`
        });
      }

      // Dev tooling declared alongside runtime dependencies.
      const devInRuntime = requirements.filter((r) => DEV_ONLY_PACKAGES.has(r.name));
      if (devInRuntime.length > 0 && manifest.name === 'requirements.txt') {
        result.findings.push(
          makeFinding({
            id: 'DEP-PY-DEV-IN-PROD',
            severity: 'low',
            category: 'dependencies',
            title: 'Development tooling is declared in the runtime dependency manifest',
            description:
              `${devInRuntime.length} development-only package(s) are declared in ${manifest.path}. ` +
              'Shipping development tooling into a production image increases image size and widens the attack surface without serving the running application.',
            recommendation:
              'Split development tooling into a separate manifest such as requirements-dev.txt, or into an optional dependency group, and install it only in development and CI.',
            confidence: 'medium',
            file: manifest.path,
            evidence: devInRuntime.map((r) => r.name).slice(0, 6).join(', ')
          })
        );
      }
    }

    // Lockfile.
    if (anyPythonManifest && !hasPyLock) {
      result.findings.push(
        makeFinding({
          id: 'DEP-PY-NO-LOCK',
          severity: 'medium',
          category: 'dependencies',
          title: 'No Python lockfile was found',
          description:
            'A dependency manifest was present but no lockfile (poetry.lock, Pipfile.lock, uv.lock, pdm.lock, or a compiled requirements.lock) was included. Transitive dependencies are therefore resolved at build time and can change between builds even when direct dependencies are pinned.',
          recommendation:
            'Generate and commit a lockfile that records the full resolved dependency graph, ideally with hashes.',
          confidence: 'high'
        })
      );
    } else if (hasPyLock) {
      result.passed.push({
        id: 'DEP-PY-LOCK',
        category: 'dependencies',
        title: 'A Python lockfile is present'
      });
    }

    // Manifest consistency.
    const declaredIn: string[] = [];
    if (pythonManifests.some((f) => f.name === 'requirements.txt')) declaredIn.push('requirements.txt');
    if (pyprojectFiles.length > 0) declaredIn.push('pyproject.toml');
    if (pipfiles.length > 0) declaredIn.push('Pipfile');
    if (condaFiles.length > 0) declaredIn.push('environment.yml');

    if (declaredIn.length > 1) {
      result.findings.push(
        makeFinding({
          id: 'DEP-PY-MULTIPLE-MANIFESTS',
          severity: 'low',
          category: 'dependencies',
          title: 'Dependencies are declared in more than one package-manager format',
          description:
            `Dependencies are declared across ${declaredIn.join(' and ')}. When these drift apart, the environment that is built depends on which tool runs, and a fix applied to one file silently fails to reach the other.`,
          recommendation:
            'Choose one package manager as the source of truth and generate the other files from it, or remove the unused manifests.',
          confidence: 'high',
          evidence: declaredIn.join(', ')
        })
      );
    }
  }

  // ---------- Node ----------
  if (isNode) {
    if (packageJsonFiles.length === 0) {
      result.findings.push(
        makeFinding({
          id: 'DEP-NODE-NO-MANIFEST',
          severity: 'high',
          category: 'dependencies',
          title: 'No package.json was found',
          description:
            'JavaScript or TypeScript source was detected, but no package.json was present in the analyzed files. Without it the dependency set and entry point are undefined.',
          recommendation: 'Add a package.json that declares the runtime dependencies and the entry point.',
          confidence: 'medium'
        })
      );
    }

    for (const pkgFile of packageJsonFiles) {
      const manifest = parsePackageJson(pkgFile);

      if (manifest === null) {
        result.findings.push(
          makeFinding({
            id: 'DEP-NODE-MALFORMED',
            severity: 'high',
            category: 'dependencies',
            title: 'package.json could not be parsed as JSON',
            description:
              'The file is not valid JSON, so no package manager can install from it and COUE could not evaluate the dependency declarations it contains.',
            recommendation: 'Correct the JSON syntax.',
            confidence: 'high',
            file: pkgFile.path
          })
        );
        continue;
      }

      const deps = Object.entries(manifest.dependencies);
      const unpinned = deps.filter(([, range]) => !isExactNpmPin(range));

      if (deps.length > 0 && unpinned.length > 0) {
        const first = unpinned[0];
        result.findings.push(
          makeFinding({
            id: 'DEP-NODE-UNPINNED',
            severity: 'medium',
            category: 'dependencies',
            title: `${unpinned.length} of ${deps.length} Node runtime dependencies use a floating version range`,
            description:
              'Caret and tilde ranges allow a different version to be installed on a later build. With a committed lockfile this is usually controlled, but a build that runs `npm install` without the lockfile, or `npm update`, can still move these versions.',
            recommendation:
              'Commit a lockfile and install with `npm ci` in CI and in the production image build. Pin exact versions for dependencies where a minor upgrade is not acceptable.',
            confidence: 'high',
            file: pkgFile.path,
            evidence: first ? `${first[0]}: ${first[1]}` : undefined
          })
        );
      } else if (deps.length > 0) {
        result.passed.push({
          id: 'DEP-NODE-PINNED',
          category: 'dependencies',
          title: 'All Node runtime dependencies are pinned to exact versions'
        });
      }

      if (!manifest.hasName || !manifest.hasVersion) {
        result.findings.push(
          makeFinding({
            id: 'DEP-NODE-METADATA',
            severity: 'low',
            category: 'dependencies',
            title: 'package.json is missing name or version metadata',
            description:
              'The manifest does not declare both a name and a version. Deployment tooling and container build caches commonly key on these fields.',
            recommendation: 'Declare both "name" and "version" in package.json.',
            confidence: 'high',
            file: pkgFile.path
          })
        );
      }

      if (!manifest.hasEngines) {
        result.findings.push(
          makeFinding({
            id: 'DEP-NODE-ENGINES',
            severity: 'low',
            category: 'dependencies',
            title: 'package.json does not declare a supported Node version',
            description:
              'No "engines" field was declared, so nothing records which Node versions the application is expected to run on. A host running a different major version can fail at runtime rather than at install time.',
            recommendation: 'Declare an "engines.node" range matching the version used in CI and in the production image.',
            confidence: 'high',
            file: pkgFile.path
          })
        );
      }

      // Dev dependency imported from runtime source.
      const devNames = Object.keys(manifest.devDependencies);
      if (devNames.length > 0) {
        const runtimeFiles = profile.files.filter(
          (f) => !f.path.toLowerCase().includes('test') && (f.ext === 'js' || f.ext === 'ts' || f.ext === 'mjs')
        );
        const leaked = devNames.filter((dep) => {
          const importPattern = new RegExp(
            `(?:require\\(\\s*["']${escapeRegex(dep)}["']|from\\s+["']${escapeRegex(dep)}["'])`
          );
          return runtimeFiles.some((f) => importPattern.test(f.content));
        });

        if (leaked.length > 0) {
          result.findings.push(
            makeFinding({
              id: 'DEP-NODE-DEV-IMPORTED',
              severity: 'high',
              category: 'dependencies',
              title: 'A development dependency is imported from runtime source',
              description:
                `${leaked.length} package(s) declared under devDependencies are imported from files that appear to be runtime source. A production install that omits development dependencies will fail at import time.`,
              recommendation:
                'Move these packages into "dependencies", or remove the import from the runtime code path.',
              confidence: 'medium',
              file: pkgFile.path,
              evidence: leaked.slice(0, 6).join(', ')
            })
          );
        }
      }
    }

    if (packageJsonFiles.length > 0 && !hasNodeLock) {
      result.findings.push(
        makeFinding({
          id: 'DEP-NODE-NO-LOCK',
          severity: 'medium',
          category: 'dependencies',
          title: 'No Node lockfile was found',
          description:
            'A package.json was present but no package-lock.json, yarn.lock, pnpm-lock.yaml, or bun lockfile was included. Without a committed lockfile, `npm install` resolves the dependency graph fresh on every build.',
          recommendation: 'Commit a lockfile and use `npm ci` (or the equivalent) in CI and in the image build.',
          confidence: 'high'
        })
      );
    } else if (hasNodeLock) {
      result.passed.push({
        id: 'DEP-NODE-LOCK',
        category: 'dependencies',
        title: 'A Node lockfile is present'
      });
    }

    // Conflicting Node package managers.
    const lockKinds = profile.files.filter((f) => NODE_LOCKFILES.has(f.name)).map((f) => f.name);
    if (new Set(lockKinds).size > 1) {
      result.findings.push(
        makeFinding({
          id: 'DEP-NODE-MULTIPLE-LOCKS',
          severity: 'medium',
          category: 'dependencies',
          title: 'Lockfiles from more than one Node package manager are present',
          description:
            `${[...new Set(lockKinds)].join(' and ')} are all present. The installed dependency graph then depends on which package manager runs, and the two lockfiles drift apart over time.`,
          recommendation: 'Keep the lockfile for the package manager you use and delete the others.',
          confidence: 'high',
          evidence: [...new Set(lockKinds)].join(', ')
        })
      );
    }
  }

  // Every project gets this explicit unknown: COUE cannot verify CVEs.
  result.unknown.push({
    id: 'DEP-VULN-SCAN',
    category: 'dependencies',
    title: 'Whether declared dependencies contain known vulnerabilities',
    reason:
      'COUE performs offline static analysis and does not consult a vulnerability database. Dependency security status could not be independently verified by COUE. Run a dedicated scanner such as pip-audit, npm audit, or a software composition analysis tool in CI.'
  });

  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

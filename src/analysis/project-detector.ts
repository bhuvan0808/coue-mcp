import { LIMITS, normalizePath } from '../utils/limits.js';

export interface SourceFile {
  /** Normalized, project-relative path. */
  path: string;
  /** Lowercased basename, for convenience. */
  name: string;
  /** Lowercased extension without the dot, or '' when there is none. */
  ext: string;
  content: string;
  /** Lines, capped at LIMITS.MAX_LINES_SCANNED. */
  lines: string[];
}

export type Ecosystem = 'python' | 'node' | 'unknown';

export type FrameworkId =
  | 'pytorch'
  | 'tensorflow'
  | 'keras'
  | 'scikit-learn'
  | 'transformers'
  | 'ultralytics'
  | 'fastapi'
  | 'flask'
  | 'express'
  | 'docker'
  | 'onnxruntime'
  | 'xgboost'
  | 'lightgbm';

export interface FrameworkDetection {
  id: FrameworkId;
  /** Human-readable name. */
  name: string;
  /** Why COUE believes this framework is present. */
  evidence: string;
}

export interface ProjectProfile {
  projectName?: string;
  ecosystems: Ecosystem[];
  frameworks: FrameworkDetection[];
  files: SourceFile[];
  /** Index of files by normalized lowercase path, for direct lookup. */
  byPath: Map<string, SourceFile>;
  hasAnyTests: boolean;
  /** True when the project exposes an HTTP service of some kind. */
  servesHttp: boolean;
  totalChars: number;
}

/** Builds a SourceFile from a raw submitted file. */
export function toSourceFile(rawPath: string, content: string): SourceFile {
  const path = normalizePath(rawPath);
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const dotIndex = name.lastIndexOf('.');
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1) : '';
  const lines = content.split(/\r?\n/).slice(0, LIMITS.MAX_LINES_SCANNED);
  return { path, name, ext, content, lines };
}

/**
 * Framework signatures.
 *
 * Detection is evidence-based: a framework is reported only when an actual
 * import, dependency declaration, or configuration directive is observed. A
 * file merely *named* like a framework is never sufficient.
 */
interface Signature {
  id: FrameworkId;
  name: string;
  /** Matched against source content to find real imports. */
  importPatterns: RegExp[];
  /** Dependency names as they appear in requirements.txt / package.json. */
  packageNames: string[];
}

const SIGNATURES: Signature[] = [
  {
    id: 'pytorch',
    name: 'PyTorch',
    importPatterns: [
      /^\s*import\s+torch\b/m,
      /^\s*from\s+torch[\s.]/m,
      /^\s*import\s+torchvision\b/m,
      /^\s*from\s+torchvision[\s.]/m
    ],
    packageNames: ['torch', 'torchvision', 'torchaudio', 'pytorch-lightning', 'lightning']
  },
  {
    id: 'tensorflow',
    name: 'TensorFlow',
    importPatterns: [/^\s*import\s+tensorflow\b/m, /^\s*from\s+tensorflow[\s.]/m],
    packageNames: ['tensorflow', 'tensorflow-cpu', 'tensorflow-gpu', 'tf-nightly']
  },
  {
    id: 'keras',
    name: 'Keras',
    importPatterns: [
      /^\s*import\s+keras\b/m,
      /^\s*from\s+keras[\s.]/m,
      /^\s*from\s+tensorflow\.keras[\s.]/m,
      /^\s*from\s+tensorflow\s+import\s+keras\b/m
    ],
    packageNames: ['keras']
  },
  {
    id: 'scikit-learn',
    name: 'scikit-learn',
    importPatterns: [/^\s*import\s+sklearn\b/m, /^\s*from\s+sklearn[\s.]/m],
    packageNames: ['scikit-learn', 'sklearn']
  },
  {
    id: 'transformers',
    name: 'Hugging Face Transformers',
    importPatterns: [/^\s*import\s+transformers\b/m, /^\s*from\s+transformers[\s.]/m],
    packageNames: ['transformers', 'sentence-transformers', 'diffusers', 'accelerate']
  },
  {
    id: 'ultralytics',
    name: 'Ultralytics / YOLO',
    importPatterns: [/^\s*import\s+ultralytics\b/m, /^\s*from\s+ultralytics[\s.]/m],
    packageNames: ['ultralytics']
  },
  {
    id: 'fastapi',
    name: 'FastAPI',
    importPatterns: [/^\s*import\s+fastapi\b/m, /^\s*from\s+fastapi[\s.]/m],
    packageNames: ['fastapi']
  },
  {
    id: 'flask',
    name: 'Flask',
    importPatterns: [/^\s*import\s+flask\b/m, /^\s*from\s+flask[\s.]/m],
    packageNames: ['flask']
  },
  {
    id: 'express',
    name: 'Express',
    importPatterns: [
      /require\(\s*["']express["']\s*\)/,
      /^\s*import\s+[\w*{}\s,]*\s*from\s+["']express["']/m
    ],
    packageNames: ['express']
  },
  {
    id: 'onnxruntime',
    name: 'ONNX Runtime',
    importPatterns: [/^\s*import\s+onnxruntime\b/m, /^\s*from\s+onnxruntime[\s.]/m],
    packageNames: ['onnxruntime', 'onnxruntime-gpu', 'onnx']
  },
  {
    id: 'xgboost',
    name: 'XGBoost',
    importPatterns: [/^\s*import\s+xgboost\b/m, /^\s*from\s+xgboost[\s.]/m],
    packageNames: ['xgboost']
  },
  {
    id: 'lightgbm',
    name: 'LightGBM',
    importPatterns: [/^\s*import\s+lightgbm\b/m, /^\s*from\s+lightgbm[\s.]/m],
    packageNames: ['lightgbm']
  }
];

/** Python dependency manifest filenames. */
export const PYTHON_MANIFESTS = new Set([
  'requirements.txt',
  'requirements-dev.txt',
  'requirements_dev.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'pipfile',
  'environment.yml',
  'environment.yaml',
  'conda.yml'
]);

/** Python lockfile filenames. */
export const PYTHON_LOCKFILES = new Set([
  'requirements.lock',
  'poetry.lock',
  'pipfile.lock',
  'pdm.lock',
  'uv.lock',
  'conda-lock.yml'
]);

/** Node lockfile filenames. */
export const NODE_LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'npm-shrinkwrap.json'
]);

export function isDockerfile(file: SourceFile): boolean {
  return file.name === 'dockerfile' || file.name.startsWith('dockerfile.');
}

export function isComposeFile(file: SourceFile): boolean {
  return (
    file.name === 'docker-compose.yml' ||
    file.name === 'docker-compose.yaml' ||
    file.name === 'compose.yml' ||
    file.name === 'compose.yaml'
  );
}

/** True when the path looks like a test file or lives in a test directory. */
export function isTestFile(file: SourceFile): boolean {
  const p = file.path.toLowerCase();
  if (/(^|\/)(tests?|__tests__|spec)\//.test(p)) return true;
  if (/(^|\/)test_[^/]+\.py$/.test(p)) return true;
  if (/_test\.py$/.test(p)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return true;
  return false;
}

/** True when the file is Python source. */
export function isPython(file: SourceFile): boolean {
  return file.ext === 'py';
}

/** True when the file is JavaScript or TypeScript source. */
export function isJsTs(file: SourceFile): boolean {
  return ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].includes(file.ext);
}

/** Extracts declared dependency names from a manifest, lowercased. */
function declaredPackageNames(file: SourceFile): string[] {
  const names: string[] = [];

  if (file.name === 'package.json') {
    try {
      const parsed: unknown = JSON.parse(file.content);
      if (parsed && typeof parsed === 'object') {
        const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        for (const field of fields) {
          const section = (parsed as Record<string, unknown>)[field];
          if (section && typeof section === 'object') {
            names.push(...Object.keys(section as Record<string, unknown>).map((n) => n.toLowerCase()));
          }
        }
      }
    } catch {
      // A malformed package.json is reported by the dependency analyzer; it is
      // not a detection signal here.
    }
    return names;
  }

  if (PYTHON_MANIFESTS.has(file.name)) {
    for (const line of file.lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Matches `torch`, `torch==2.1.0`, `  - torch>=2`, `"torch~=2.0"`.
      const match = /^[-\s"']*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(trimmed);
      if (match && match[1]) names.push(match[1].toLowerCase());
    }
  }

  return names;
}

/** Detects frameworks from imports and dependency declarations. */
function detectFrameworks(files: SourceFile[]): FrameworkDetection[] {
  const detected = new Map<FrameworkId, FrameworkDetection>();

  for (const file of files) {
    // Dependency-declaration evidence.
    const declared = new Set(declaredPackageNames(file));
    if (declared.size > 0) {
      for (const sig of SIGNATURES) {
        if (detected.has(sig.id)) continue;
        const hit = sig.packageNames.find((pkg) => declared.has(pkg));
        if (hit) {
          detected.set(sig.id, {
            id: sig.id,
            name: sig.name,
            evidence: `declared as dependency "${hit}" in ${file.path}`
          });
        }
      }
    }

    // Import evidence, which is stronger than a declaration.
    if (isPython(file) || isJsTs(file)) {
      for (const sig of SIGNATURES) {
        const existing = detected.get(sig.id);
        if (existing && existing.evidence.startsWith('imported')) continue;
        if (sig.importPatterns.some((p) => p.test(file.content))) {
          detected.set(sig.id, {
            id: sig.id,
            name: sig.name,
            evidence: `imported in ${file.path}`
          });
        }
      }
    }
  }

  // Docker is detected from an actual Dockerfile or compose file.
  const dockerFile = files.find((f) => isDockerfile(f) || isComposeFile(f));
  if (dockerFile) {
    detected.set('docker', {
      id: 'docker',
      name: 'Docker',
      evidence: `container configuration found at ${dockerFile.path}`
    });
  }

  return [...detected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function detectEcosystems(files: SourceFile[]): Ecosystem[] {
  const found = new Set<Ecosystem>();
  for (const file of files) {
    if (isPython(file) || PYTHON_MANIFESTS.has(file.name) || PYTHON_LOCKFILES.has(file.name)) {
      found.add('python');
    }
    if (isJsTs(file) || file.name === 'package.json' || NODE_LOCKFILES.has(file.name)) {
      found.add('node');
    }
  }
  if (found.size === 0) found.add('unknown');
  return [...found].sort();
}

/** Builds the project profile that every analyzer reads. */
export function detectProject(files: SourceFile[], projectName?: string): ProjectProfile {
  const frameworks = detectFrameworks(files);
  const frameworkIds = new Set(frameworks.map((f) => f.id));

  const byPath = new Map<string, SourceFile>();
  for (const file of files) byPath.set(file.path.toLowerCase(), file);

  const profile: ProjectProfile = {
    ecosystems: detectEcosystems(files),
    frameworks,
    files,
    byPath,
    hasAnyTests: files.some(isTestFile),
    servesHttp:
      frameworkIds.has('fastapi') || frameworkIds.has('flask') || frameworkIds.has('express'),
    totalChars: files.reduce((sum, f) => sum + f.content.length, 0)
  };
  if (projectName !== undefined) profile.projectName = projectName;
  return profile;
}

/** True when the detected framework set includes an ML framework. */
export function hasMlFramework(profile: ProjectProfile): boolean {
  const mlIds: FrameworkId[] = [
    'pytorch',
    'tensorflow',
    'keras',
    'scikit-learn',
    'transformers',
    'ultralytics',
    'onnxruntime',
    'xgboost',
    'lightgbm'
  ];
  return profile.frameworks.some((f) => mlIds.includes(f.id));
}

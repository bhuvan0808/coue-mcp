import { emptyResult, makeFinding, type AnalyzerResult } from './findings.js';
import { isComposeFile, isDockerfile, type ProjectProfile, type SourceFile } from './project-detector.js';

/**
 * Docker analysis.
 *
 * Parses Dockerfile instructions structurally (handling line continuations and
 * comments) rather than matching raw text, so that findings reflect what the
 * builder would actually do.
 */

export interface DockerInstruction {
  keyword: string;
  args: string;
  line: number;
}

/** Parses a Dockerfile into logical instructions, joining continuations. */
export function parseDockerfile(file: SourceFile): DockerInstruction[] {
  const instructions: DockerInstruction[] = [];
  let buffer = '';
  let startLine = 0;

  for (let i = 0; i < file.lines.length; i++) {
    const rawLine = file.lines[i];
    if (rawLine === undefined) continue;
    const trimmed = rawLine.trim();

    if (buffer === '') {
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      startLine = i + 1;
    }

    if (trimmed.endsWith('\\')) {
      buffer += `${trimmed.slice(0, -1).trim()} `;
      continue;
    }

    buffer += trimmed;
    const match = /^(\S+)\s*([\s\S]*)$/.exec(buffer.trim());
    if (match && match[1]) {
      instructions.push({
        keyword: match[1].toUpperCase(),
        args: (match[2] ?? '').trim(),
        line: startLine
      });
    }
    buffer = '';
  }

  // A trailing continuation with no terminating line still produces an instruction.
  if (buffer.trim()) {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(buffer.trim());
    if (match && match[1]) {
      instructions.push({
        keyword: match[1].toUpperCase(),
        args: (match[2] ?? '').trim(),
        line: startLine
      });
    }
  }

  return instructions;
}

interface BaseImage {
  reference: string;
  tag: string | null;
  digest: string | null;
  stageAlias: string | null;
  line: number;
}

function parseFromInstruction(instr: DockerInstruction): BaseImage {
  // FROM [--platform=...] image[:tag][@digest] [AS alias]
  const withoutFlags = instr.args.replace(/--\S+=\S+\s*/g, '').trim();
  const asMatch = /\s+AS\s+(\S+)\s*$/i.exec(withoutFlags);
  const stageAlias = asMatch && asMatch[1] ? asMatch[1] : null;
  const reference = (asMatch ? withoutFlags.slice(0, asMatch.index) : withoutFlags).trim();

  const digestMatch = /@(sha256:[a-f0-9]{64})$/i.exec(reference);
  const digest = digestMatch && digestMatch[1] ? digestMatch[1] : null;
  const withoutDigest = digest ? reference.slice(0, reference.lastIndexOf('@')) : reference;

  // A colon in the final path segment is a tag; a colon earlier is a registry port.
  const lastSegment = withoutDigest.split('/').pop() ?? withoutDigest;
  const colonIndex = lastSegment.lastIndexOf(':');
  const tag = colonIndex > 0 ? lastSegment.slice(colonIndex + 1) : null;

  return { reference: withoutDigest, tag, digest, stageAlias, line: instr.line };
}

/** Ports whose exposure in an application image usually indicates a mistake. */
const SENSITIVE_PORTS: Record<string, string> = {
  '22': 'SSH',
  '23': 'Telnet',
  '3306': 'MySQL',
  '5432': 'PostgreSQL',
  '6379': 'Redis',
  '27017': 'MongoDB',
  '9200': 'Elasticsearch',
  '2375': 'Docker daemon (unencrypted)',
  '2376': 'Docker daemon'
};

/** Paths that commonly hold credentials and should not be copied into an image. */
const SECRET_PATH_PATTERN =
  /(?:^|[\s"'/])(?:\.env(?:\.[\w-]+)?|\.aws|\.ssh|id_rsa|id_ed25519|\.netrc|credentials(?:\.json|\.yaml|\.yml)?|secrets?\.(?:json|ya?ml|env)|\.npmrc|\.pypirc|gcp[-_]?key\.json|service[-_]account\.json)(?:$|[\s"'])/i;

function analyzeDockerfileContent(file: SourceFile, profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();
  const instructions = parseDockerfile(file);

  if (instructions.length === 0) {
    result.findings.push(
      makeFinding({
        id: 'DOCKER-EMPTY',
        severity: 'medium',
        category: 'docker',
        title: 'Dockerfile contains no build instructions',
        description: 'The file was supplied as a Dockerfile but no instructions could be parsed from it.',
        recommendation: 'Confirm the file is a valid Dockerfile.',
        confidence: 'high',
        file: file.path
      })
    );
    return result;
  }

  const froms = instructions.filter((i) => i.keyword === 'FROM').map(parseFromInstruction);
  const stageAliases = new Set(froms.map((f) => f.stageAlias).filter((a): a is string => a !== null));

  // --- Base image pinning ---
  // Only external base images matter; a FROM referring to an earlier stage is not an image.
  const externalFroms = froms.filter((f) => !stageAliases.has(f.reference));

  for (const from of externalFroms) {
    if (from.digest) {
      result.passed.push({
        id: 'DOCKER-BASE-DIGEST',
        category: 'docker',
        title: `Base image ${from.reference} is pinned by digest`
      });
      continue;
    }

    if (from.tag === null) {
      result.findings.push(
        makeFinding({
          id: 'DOCKER-BASE-UNTAGGED',
          severity: 'high',
          category: 'docker',
          title: 'Base image has no tag, so it resolves to :latest',
          description:
            `The base image "${from.reference}" is declared without a tag. Docker resolves this to the "latest" tag, which points at a different image over time. A rebuild can therefore change the operating system, the language runtime, and the installed system libraries with no change to the project.`,
          recommendation:
            'Pin the base image to an explicit version tag, and for a production image pin it by digest (image@sha256:...).',
          confidence: 'high',
          file: file.path,
          line: from.line
        })
      );
    } else if (from.tag === 'latest') {
      result.findings.push(
        makeFinding({
          id: 'DOCKER-BASE-LATEST',
          severity: 'high',
          category: 'docker',
          title: 'Base image uses the floating "latest" tag',
          description:
            `The base image "${from.reference}" is pinned to "latest", which points at a different image over time. A rebuild can change the operating system, the language runtime, and the installed system libraries with no change to the project, which makes a regression hard to attribute.`,
          recommendation:
            'Pin the base image to an explicit version tag, and for a production image pin it by digest (image@sha256:...).',
          confidence: 'high',
          file: file.path,
          line: from.line
        })
      );
    } else if (/^\d+$/.test(from.tag)) {
      result.findings.push(
        makeFinding({
          id: 'DOCKER-BASE-LOOSE-TAG',
          severity: 'low',
          category: 'docker',
          title: 'Base image is pinned only to a major version',
          description:
            `The base image "${from.reference}" is pinned to the tag "${from.tag}", which tracks the newest release within that major version. Minor and patch updates arrive without a project change.`,
          recommendation: 'Pin to a full version tag, and by digest for production images.',
          confidence: 'high',
          file: file.path,
          line: from.line
        })
      );
    } else {
      result.passed.push({
        id: 'DOCKER-BASE-TAGGED',
        category: 'docker',
        title: `Base image ${from.reference} is pinned to an explicit tag`
      });
    }
  }

  // --- Non-root user ---
  const userInstructions = instructions.filter((i) => i.keyword === 'USER');
  const lastUser = userInstructions[userInstructions.length - 1];
  const runsAsRoot =
    lastUser === undefined || /^(?:root|0)(?::|$)/.test(lastUser.args.trim());

  if (runsAsRoot) {
    result.findings.push(
      makeFinding({
        id: 'DOCKER-ROOT-USER',
        severity: 'high',
        category: 'docker',
        title: 'Container runs as root',
        description:
          lastUser === undefined
            ? 'No USER instruction was found, so the container runs as root. A process compromise then starts with root inside the container, which widens the impact of any container-escape or volume-mount weakness.'
            : 'The final USER instruction sets the container to run as root. A process compromise then starts with root inside the container.',
        recommendation:
          'Create a dedicated unprivileged user and group in the image, give it ownership of only the paths the application writes to, and add a USER instruction for it before CMD or ENTRYPOINT.',
        confidence: 'high',
        file: file.path,
        line: lastUser?.line
      })
    );
  } else {
    result.passed.push({
      id: 'DOCKER-NONROOT-USER',
      category: 'docker',
      title: 'Container runs as a non-root user'
    });
  }

  // --- Health check ---
  const hasHealthcheck = instructions.some((i) => i.keyword === 'HEALTHCHECK');
  const composeHasHealthcheck = profile.files.some(
    (f) => isComposeFile(f) && /healthcheck\s*:/i.test(f.content)
  );

  if (!hasHealthcheck && !composeHasHealthcheck) {
    result.findings.push(
      makeFinding({
        id: 'DOCKER-NO-HEALTHCHECK',
        severity: 'medium',
        category: 'docker',
        title: 'Image declares no health check',
        description:
          'No HEALTHCHECK instruction was found in the Dockerfile and no healthcheck was declared in a compose file. An orchestrator then treats the container as healthy as soon as the process starts, so a container whose model failed to load still receives traffic.',
        recommendation:
          'Add a HEALTHCHECK that calls the application health endpoint, or declare readiness and liveness probes in the orchestrator manifest.',
        confidence: 'high',
        file: file.path
      })
    );
  } else {
    result.passed.push({
      id: 'DOCKER-HEALTHCHECK',
      category: 'docker',
      title: 'A container health check is declared'
    });
  }

  // --- Exposed ports ---
  for (const instr of instructions.filter((i) => i.keyword === 'EXPOSE')) {
    for (const token of instr.args.split(/\s+/)) {
      const port = (token.split('/')[0] ?? '').trim();
      const label = SENSITIVE_PORTS[port];
      if (label) {
        result.findings.push(
          makeFinding({
            id: 'DOCKER-SENSITIVE-PORT',
            severity: 'medium',
            category: 'docker',
            title: `Image exposes port ${port} (${label})`,
            description:
              `An application image that declares port ${port} suggests ${label} is reachable from the container. Exposing a datastore or administrative port from an application image widens the network surface beyond what the application needs.`,
            recommendation:
              `Remove the EXPOSE for port ${port} unless the application itself serves it, and reach the datastore over the orchestrator network instead.`,
            confidence: 'medium',
            file: file.path,
            line: instr.line
          })
        );
      }
    }
  }

  // --- Secrets copied into the image ---
  for (const instr of instructions) {
    if (instr.keyword !== 'COPY' && instr.keyword !== 'ADD') continue;
    if (!SECRET_PATH_PATTERN.test(instr.args)) continue;
    // `COPY . .` is handled by the .dockerignore rule instead.
    result.findings.push(
      makeFinding({
        id: 'DOCKER-COPY-SECRET',
        severity: 'critical',
        category: 'docker',
        title: 'A credential file path is copied into the image',
        description:
          'A COPY or ADD instruction references a path that commonly holds credentials. Anything copied into an image layer stays in that layer and can be read by anyone who can pull the image, even if a later instruction deletes it.',
        recommendation:
          'Remove the path from the build context, add it to .dockerignore, and supply the credential at runtime through an environment variable or a mounted secret. Use BuildKit secret mounts when a credential is needed during the build.',
        confidence: 'medium',
        file: file.path,
        line: instr.line,
        evidence: `${instr.keyword} ${instr.args}`
      })
    );
  }

  // --- Secrets baked in via ENV/ARG ---
  for (const instr of instructions) {
    if (instr.keyword !== 'ENV' && instr.keyword !== 'ARG') continue;
    const match =
      /\b(API[_-]?KEY|SECRET(?:_KEY)?|PASSWORD|TOKEN|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)\b\s*=\s*(\S+)/i.exec(
        instr.args
      );
    if (!match) continue;
    const value = match[2] ?? '';
    // A declaration with no value, or one referencing a build arg, is fine.
    if (value === '' || value.startsWith('$') || /^["']?["']?$/.test(value)) continue;
    if (/example|placeholder|changeme|dummy|your[_-]/i.test(value)) continue;

    result.findings.push(
      makeFinding({
        id: 'DOCKER-ENV-SECRET',
        severity: 'critical',
        category: 'docker',
        title: 'A credential value is baked into an image layer',
        description:
          `An ${instr.keyword} instruction assigns a literal value to a credential-named variable. Image layers are readable by anyone who can pull the image, and the value persists in the build history. COUE reports the location only and does not return the value.`,
        recommendation:
          'Remove the literal value, inject the credential at runtime from a secret manager, and rotate it.',
        confidence: 'medium',
        file: file.path,
        line: instr.line
      })
    );
  }

  // --- apt/apk cache not cleaned ---
  const runInstructions = instructions.filter((i) => i.keyword === 'RUN');
  const aptInstalls = runInstructions.filter((i) => /\bapt-get\s+install\b|\bapt\s+install\b/.test(i.args));
  const uncleanedApt = aptInstalls.filter(
    (i) => !/rm\s+-rf\s+\/var\/lib\/apt\/lists|--no-install-recommends[\s\S]*rm\s+-rf/.test(i.args)
  );
  if (uncleanedApt.length > 0) {
    const first = uncleanedApt[0];
    result.findings.push(
      makeFinding({
        id: 'DOCKER-APT-CACHE',
        severity: 'low',
        category: 'docker',
        title: 'Package manager cache is not removed in the same layer',
        description:
          'An apt-get install runs without removing /var/lib/apt/lists in the same RUN instruction. The cache stays in the layer, which enlarges the image and ships package index data the application does not use.',
        recommendation:
          'Append `&& rm -rf /var/lib/apt/lists/*` to the same RUN instruction, and pass --no-install-recommends.',
        confidence: 'high',
        file: file.path,
        line: first?.line
      })
    );
  }

  // --- pip cache ---
  const pipInstalls = runInstructions.filter((i) => /\bpip3?\s+install\b/.test(i.args));
  const uncachedPip = pipInstalls.filter((i) => !/--no-cache-dir/.test(i.args));
  if (uncachedPip.length > 0) {
    const first = uncachedPip[0];
    result.findings.push(
      makeFinding({
        id: 'DOCKER-PIP-CACHE',
        severity: 'low',
        category: 'docker',
        title: 'pip install runs without --no-cache-dir',
        description:
          'pip retains downloaded wheels in its cache directory, which stays in the image layer. For ML dependencies this commonly adds hundreds of megabytes that the running application never reads.',
        recommendation: 'Add --no-cache-dir to pip install, or use a BuildKit cache mount.',
        confidence: 'high',
        file: file.path,
        line: first?.line
      })
    );
  }

  // --- Multi-stage opportunity ---
  const hasBuildToolchain = runInstructions.some((i) =>
    /\b(?:gcc|g\+\+|build-essential|make\b|cmake|rustc|cargo\s+build|npm\s+run\s+build|go\s+build)\b/.test(
      i.args
    )
  );
  if (froms.length === 1 && hasBuildToolchain) {
    result.findings.push(
      makeFinding({
        id: 'DOCKER-MULTISTAGE',
        severity: 'low',
        category: 'docker',
        title: 'Build toolchain is installed in a single-stage image',
        description:
          'A compiler or build toolchain is installed in the only stage of the image, so it ships to production alongside the application. This enlarges the image and leaves build tooling available to a compromised process.',
        recommendation:
          'Split the build into a builder stage and copy only the built artifacts into a slim runtime stage.',
        confidence: 'medium',
        file: file.path
      })
    );
  } else if (froms.length > 1) {
    result.passed.push({
      id: 'DOCKER-MULTISTAGE',
      category: 'docker',
      title: 'Image uses a multi-stage build'
    });
  }

  // --- Model artifact handling ---
  const copiesModelArtifact = instructions.some(
    (i) =>
      (i.keyword === 'COPY' || i.keyword === 'ADD') &&
      /\.(?:pt|pth|ckpt|h5|pb|onnx|safetensors|joblib|pkl|bin|gguf)\b/i.test(i.args)
  );
  const downloadsModelAtBuild = runInstructions.some((i) =>
    /(?:wget|curl)[\s\S]*\.(?:pt|pth|ckpt|h5|onnx|safetensors|bin|gguf)\b/i.test(i.args)
  );

  if (copiesModelArtifact) {
    result.passed.push({
      id: 'DOCKER-MODEL-BAKED',
      category: 'docker',
      title: 'Model artifact is baked into the image, so startup does not depend on an external fetch'
    });
  } else if (downloadsModelAtBuild) {
    result.findings.push(
      makeFinding({
        id: 'DOCKER-MODEL-FETCH-BUILD',
        severity: 'medium',
        category: 'docker',
        title: 'Model artifact is downloaded during the image build',
        description:
          'A model artifact is fetched over the network during the build. The resulting image then depends on an external host remaining reachable and serving the same bytes, and the artifact version is not recorded anywhere in the project.',
        recommendation:
          'Pull the artifact from a versioned model registry or object store, verify a checksum, and record the resolved version as an image label.',
        confidence: 'medium',
        file: file.path
      })
    );
  }

  return result;
}

export function analyzeDocker(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();

  const dockerfiles = profile.files.filter(isDockerfile);
  const composeFiles = profile.files.filter(isComposeFile);
  const dockerignore = profile.files.find((f) => f.name === '.dockerignore');

  if (dockerfiles.length === 0 && composeFiles.length === 0) {
    result.unknown.push({
      id: 'DOCKER-PRESENT',
      category: 'docker',
      title: 'Container build configuration',
      reason:
        'No Dockerfile or compose file was included in the analyzed files. COUE cannot determine how this project is packaged for deployment.'
    });
    return result;
  }

  for (const file of dockerfiles) {
    const sub = analyzeDockerfileContent(file, profile);
    result.findings.push(...sub.findings);
    result.passed.push(...sub.passed);
    result.unknown.push(...sub.unknown);
  }

  // --- .dockerignore ---
  if (dockerfiles.length > 0) {
    if (!dockerignore) {
      const copiesWholeContext = dockerfiles.some((f) =>
        parseDockerfile(f).some(
          (i) => (i.keyword === 'COPY' || i.keyword === 'ADD') && /^\.\s|^\.\/?\s/.test(i.args)
        )
      );
      result.findings.push(
        makeFinding({
          id: 'DOCKER-NO-DOCKERIGNORE',
          severity: copiesWholeContext ? 'high' : 'medium',
          category: 'docker',
          title: 'No .dockerignore file was found',
          description: copiesWholeContext
            ? 'The Dockerfile copies the whole build context into the image and no .dockerignore was supplied. Everything in the directory is sent to the daemon and written into a layer, which commonly includes .git history, local .env files, virtual environments, datasets, and checkpoints.'
            : 'No .dockerignore was supplied, so the entire build context is sent to the daemon on every build. This slows builds and risks local credential files reaching the image.',
          recommendation:
            'Add a .dockerignore covering at least .git, .env and .env.*, virtual environments, __pycache__, node_modules, datasets, checkpoints, and test fixtures.',
          confidence: 'high'
        })
      );
    } else {
      const content = dockerignore.content;
      const covers = (pattern: RegExp): boolean => pattern.test(content);
      const missing: string[] = [];
      if (!covers(/(^|\n)\s*\.git\b/)) missing.push('.git');
      if (!covers(/\.env/)) missing.push('.env');
      if (!covers(/(^|\n)\s*(?:\*\*\/)?(?:venv|\.venv|env)\b/) && !covers(/node_modules/)) {
        missing.push('virtual environment or node_modules');
      }

      if (missing.length > 0) {
        result.findings.push(
          makeFinding({
            id: 'DOCKER-DOCKERIGNORE-GAPS',
            severity: 'medium',
            category: 'docker',
            title: '.dockerignore does not cover common sensitive or oversized paths',
            description:
              `The .dockerignore does not appear to exclude: ${missing.join(', ')}. These paths are commonly present in a working directory and end up in the image when the build context is copied.`,
            recommendation: 'Extend .dockerignore to cover these paths.',
            confidence: 'medium',
            file: dockerignore.path,
            evidence: missing.join(', ')
          })
        );
      } else {
        result.passed.push({
          id: 'DOCKER-DOCKERIGNORE',
          category: 'docker',
          title: '.dockerignore excludes version control, environment files, and dependency directories'
        });
      }
    }
  }

  // --- Compose files ---
  for (const compose of composeFiles) {
    if (/(^|\n)\s*privileged\s*:\s*true/i.test(compose.content)) {
      result.findings.push(
        makeFinding({
          id: 'DOCKER-COMPOSE-PRIVILEGED',
          severity: 'critical',
          category: 'docker',
          title: 'A compose service runs in privileged mode',
          description:
            'Privileged mode disables most container isolation, giving the container effectively the same capabilities as the host. A compromise of the service then reaches the host.',
          recommendation:
            'Remove `privileged: true` and grant only the specific capabilities the service needs with `cap_add`. GPU access should use the device reservation syntax rather than privileged mode.',
          confidence: 'high',
          file: compose.path
        })
      );
    }

    if (/(^|\n)\s*-\s*\/:\/|(^|\n)\s*-\s*["']?\/var\/run\/docker\.sock/i.test(compose.content)) {
      result.findings.push(
        makeFinding({
          id: 'DOCKER-COMPOSE-SOCKET',
          severity: 'critical',
          category: 'docker',
          title: 'A compose service mounts the host root or the Docker socket',
          description:
            'Mounting the host root filesystem or the Docker daemon socket into a container is equivalent to granting host root, because the container can start further containers with arbitrary mounts.',
          recommendation:
            'Remove the mount. If the service genuinely needs to orchestrate containers, run it outside the application container with a scoped credential.',
          confidence: 'high',
          file: compose.path
        })
      );
    }
  }

  return result;
}

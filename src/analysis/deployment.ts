import { emptyResult, makeFinding, type AnalyzerResult } from './findings.js';
import {
  isJsTs,
  isPython,
  isTestFile,
  type ProjectProfile,
  type SourceFile
} from './project-detector.js';

/**
 * Deployment analysis.
 *
 * Covers how the application is started, configured, and rolled out: the
 * production server, resource declarations, configuration handling, graceful
 * shutdown, and the presence of deployment documentation.
 */

/** Development servers that should not serve production traffic. */
const DEV_SERVER_PATTERNS: Array<{ pattern: RegExp; label: string; replacement: string }> = [
  {
    pattern: /\bapp\.run\s*\(/,
    label: "Flask's built-in development server",
    replacement: 'gunicorn with a sync or gthread worker class, or uvicorn for an ASGI app'
  },
  {
    pattern: /\buvicorn\.run\s*\(/,
    label: 'uvicorn started from inside the application process',
    replacement:
      'uvicorn or gunicorn invoked as the container entrypoint, so the process manager owns worker lifecycle and signals'
  },
  {
    pattern: /\bflask\s+run\b/,
    label: "the `flask run` development command",
    replacement: 'a production WSGI server such as gunicorn'
  },
  {
    pattern: /\bmanage\.py\s+runserver\b/,
    label: "Django's development server",
    replacement: 'gunicorn or uvicorn'
  }
];

/** Production servers, which satisfy the same check. */
const PROD_SERVER_PATTERN =
  /\bgunicorn\b|\buvicorn\s+[\w.:]+\b|\bhypercorn\b|\bwaitress\b|\bdaphne\b|\bmod_wsgi\b|\bpm2\b|\bnode\s+(?:dist|build|src)\//;

/** Orchestrator manifest detection. */
function isKubernetesManifest(file: SourceFile): boolean {
  if (!['yaml', 'yml'].includes(file.ext)) return false;
  return /^\s*apiVersion\s*:/m.test(file.content) && /^\s*kind\s*:\s*\w+/m.test(file.content);
}

function isIacFile(file: SourceFile): boolean {
  return (
    file.ext === 'tf' ||
    file.name === 'serverless.yml' ||
    file.name === 'serverless.yaml' ||
    file.name === 'template.yaml' ||
    file.name === 'cloudformation.yaml' ||
    file.name === 'pulumi.yaml' ||
    file.name === 'fly.toml' ||
    file.name === 'render.yaml' ||
    file.name === 'app.yaml' ||
    file.name === 'procfile'
  );
}

export function analyzeDeployment(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();

  const codeFiles = profile.files.filter((f) => (isPython(f) || isJsTs(f)) && !isTestFile(f));
  const dockerfiles = profile.files.filter(
    (f) => f.name === 'dockerfile' || f.name.startsWith('dockerfile.')
  );
  const k8sManifests = profile.files.filter(isKubernetesManifest);
  const iacFiles = profile.files.filter(isIacFile);
  const combined = [...codeFiles, ...dockerfiles].map((f) => f.content).join('\n');

  // --- Production server ---
  if (profile.servesHttp) {
    const usesProdServer = PROD_SERVER_PATTERN.test(combined);
    const devServer = DEV_SERVER_PATTERNS.find((d) => d.pattern.test(combined));

    if (usesProdServer) {
      result.passed.push({
        id: 'DEPLOY-PROD-SERVER',
        category: 'deployment',
        title: 'A production application server is configured'
      });
    } else if (devServer) {
      // Locate the file for evidence.
      const offending = [...codeFiles, ...dockerfiles].find((f) => devServer.pattern.test(f.content));
      result.findings.push(
        makeFinding({
          id: 'DEPLOY-DEV-SERVER',
          severity: 'high',
          category: 'deployment',
          title: 'Application is started with a development server',
          description:
            `The entry point uses ${devServer.label}. Development servers are single-threaded or single-worker by default, do not manage worker lifecycle, and are not written to survive the traffic patterns and failure modes of a production deployment.`,
          recommendation: `Start the application with ${devServer.replacement}, sized to the available CPU, and set the worker timeout above the expected inference duration.`,
          confidence: 'high',
          file: offending?.path
        })
      );
    } else {
      result.unknown.push({
        id: 'DEPLOY-PROD-SERVER',
        category: 'deployment',
        title: 'Production application server',
        reason:
          'No application server invocation was detected in the analyzed files. COUE could not determine how the service is started in production.'
      });
    }
  }

  // --- Container entrypoint ---
  if (dockerfiles.length > 0) {
    const hasEntry = dockerfiles.some((f) => /^\s*(?:CMD|ENTRYPOINT)\b/im.test(f.content));
    if (!hasEntry) {
      result.findings.push(
        makeFinding({
          id: 'DEPLOY-NO-ENTRYPOINT',
          severity: 'high',
          category: 'deployment',
          title: 'Dockerfile declares no CMD or ENTRYPOINT',
          description:
            'The image does not declare a default command, so running it starts whatever the base image declares, which for a language base image is usually an interactive interpreter rather than the application.',
          recommendation: 'Add a CMD or ENTRYPOINT that starts the production server.',
          confidence: 'high',
          file: dockerfiles[0]?.path
        })
      );
    } else {
      result.passed.push({
        id: 'DEPLOY-ENTRYPOINT',
        category: 'deployment',
        title: 'Container declares an explicit entry point'
      });
    }
  }

  // --- Configuration from environment ---
  const readsEnv =
    codeFiles.some(
      (f) =>
        (isPython(f) && /\bos\.(?:environ|getenv)\b|\bBaseSettings\b|\bpydantic_settings\b/.test(f.content)) ||
        (isJsTs(f) && /\bprocess\.env\b/.test(f.content))
    ) || /^\s*ENV\s+/im.test(dockerfiles.map((f) => f.content).join('\n'));

  if (readsEnv) {
    result.passed.push({
      id: 'DEPLOY-ENV-CONFIG',
      category: 'deployment',
      title: 'Configuration is supplied through the environment'
    });
  } else if (codeFiles.length > 0) {
    result.findings.push(
      makeFinding({
        id: 'DEPLOY-NO-ENV-CONFIG',
        severity: 'medium',
        category: 'deployment',
        title: 'No environment-based configuration was detected',
        description:
          'Nothing in the analyzed files reads configuration from the environment, which suggests settings are fixed in the source or in a committed file. Promoting the same artifact through staging and production then requires editing and rebuilding rather than changing configuration.',
        recommendation:
          'Read environment-specific settings from environment variables with documented defaults, so one image runs unchanged in every environment.',
        confidence: 'medium'
      })
    );
  }

  // --- Graceful shutdown ---
  const handlesSignals =
    /\bsignal\.signal\s*\(|\bSIGTERM\b|\bsignal\.SIGINT\b|\bprocess\.on\s*\(\s*["']SIGTERM["']|\batexit\b|\bshutdown_event\b|@app\.on_event\s*\(\s*["']shutdown["']|\blifespan\b/.test(
      combined
    );

  if (handlesSignals) {
    result.passed.push({
      id: 'DEPLOY-GRACEFUL-SHUTDOWN',
      category: 'deployment',
      title: 'Shutdown handling is present'
    });
  } else if (profile.servesHttp) {
    result.findings.push(
      makeFinding({
        id: 'DEPLOY-NO-GRACEFUL-SHUTDOWN',
        severity: 'medium',
        category: 'deployment',
        title: 'No graceful shutdown handling was detected',
        description:
          'No SIGTERM handling or shutdown hook was found. During a rolling deployment or a scale-down the orchestrator sends SIGTERM and then kills the process after a grace period; without a handler, requests in flight are terminated mid-response. For an inference service with multi-second requests this is visible to users on every deployment.',
        recommendation:
          'Handle SIGTERM by stopping acceptance of new requests, allowing in-flight requests to finish within the grace period, and releasing model resources. Most production servers do this when they own the process, so verify the container entrypoint does not wrap the server in a shell that swallows signals.',
        confidence: 'medium'
      })
    );
  }

  // --- Resource declarations ---
  if (k8sManifests.length > 0) {
    const hasResources = k8sManifests.some((f) => /^\s*resources\s*:/m.test(f.content));
    const hasProbes = k8sManifests.some((f) =>
      /\b(?:readinessProbe|livenessProbe|startupProbe)\s*:/.test(f.content)
    );

    if (!hasResources) {
      result.findings.push(
        makeFinding({
          id: 'DEPLOY-NO-RESOURCES',
          severity: 'high',
          category: 'deployment',
          title: 'Kubernetes manifests declare no resource requests or limits',
          description:
            'No resources block was found in the supplied manifests. Without a memory limit, a model that loads larger than expected is killed by the node rather than by the scheduler, and without requests the scheduler cannot place the pod on a node that can actually hold the model.',
          recommendation:
            'Declare memory and CPU requests and limits sized from an observed load, and declare GPU resources explicitly where the workload needs one.',
          confidence: 'high',
          file: k8sManifests[0]?.path
        })
      );
    } else {
      result.passed.push({
        id: 'DEPLOY-RESOURCES',
        category: 'deployment',
        title: 'Kubernetes manifests declare resource requests or limits'
      });
    }

    if (!hasProbes) {
      result.findings.push(
        makeFinding({
          id: 'DEPLOY-NO-PROBES',
          severity: 'high',
          category: 'deployment',
          title: 'Kubernetes manifests declare no health probes',
          description:
            'No readiness, liveness, or startup probe was found. A pod is then considered ready as soon as the container starts, so during a rolling update traffic reaches a replica whose model has not finished loading.',
          recommendation:
            'Declare a readiness probe that passes only once the model is loaded, a liveness probe on a lightweight health endpoint, and a startup probe with a threshold that accommodates the model load time.',
          confidence: 'high',
          file: k8sManifests[0]?.path
        })
      );
    } else {
      result.passed.push({
        id: 'DEPLOY-PROBES',
        category: 'deployment',
        title: 'Kubernetes manifests declare health probes'
      });
    }
  } else if (iacFiles.length === 0 && dockerfiles.length === 0) {
    result.unknown.push({
      id: 'DEPLOY-TARGET',
      category: 'deployment',
      title: 'Deployment target and runtime configuration',
      reason:
        'No container, orchestrator, or infrastructure configuration was included in the analyzed files. COUE cannot determine how or where this project is deployed.'
    });
  }

  // --- CI/CD ---
  const ciFiles = profile.files.filter(
    (f) =>
      f.path.toLowerCase().includes('.github/workflows/') ||
      f.name === '.gitlab-ci.yml' ||
      f.name === 'azure-pipelines.yml' ||
      f.name === 'jenkinsfile' ||
      f.path.toLowerCase().includes('.circleci/')
  );

  if (ciFiles.length > 0) {
    result.passed.push({
      id: 'DEPLOY-CI',
      category: 'deployment',
      title: 'A continuous integration pipeline is configured'
    });

    // Credentials in CI config.
    for (const ci of ciFiles) {
      const hasHardcoded = /\b(?:password|token|api[_-]?key|secret)\s*:\s*["']?[A-Za-z0-9/+_-]{16,}["']?/i.test(
        ci.content
      );
      const usesSecretRef = /\$\{\{\s*secrets\.|\$\{\{\s*vars\.|\$[A-Z_]+|secrets:/i.test(ci.content);
      if (hasHardcoded && !usesSecretRef) {
        result.findings.push(
          makeFinding({
            id: 'DEPLOY-CI-SECRET',
            severity: 'critical',
            category: 'deployment',
            title: 'A credential-shaped value appears in continuous integration configuration',
            description:
              'A value matching a credential assignment appears in a CI configuration file. CI configuration is usually readable by everyone with repository access and is written to build logs. COUE reports the location only and does not return the value.',
            recommendation:
              'Move the value into the CI platform secret store, reference it by name, and rotate it.',
            confidence: 'medium',
            file: ci.path
          })
        );
      }
    }
  } else {
    result.unknown.push({
      id: 'DEPLOY-CI',
      category: 'deployment',
      title: 'Build and deployment automation',
      reason:
        'No continuous integration or deployment configuration was included in the analyzed files.'
    });
  }

  // --- Deployment documentation ---
  const docs = profile.files.filter(
    (f) => f.ext === 'md' && /readme|deploy|runbook|operations|ops|install/i.test(f.name)
  );
  if (docs.length > 0) {
    const deploymentDoc = docs.find((f) =>
      /\b(?:deploy|docker|kubernetes|environment variable|rollback|runbook|production)\b/i.test(
        f.content
      )
    );
    if (deploymentDoc) {
      result.passed.push({
        id: 'DEPLOY-DOCS',
        category: 'deployment',
        title: `Deployment documentation is present (${deploymentDoc.path})`
      });
    } else {
      result.findings.push(
        makeFinding({
          id: 'DEPLOY-NO-DOCS',
          severity: 'low',
          category: 'deployment',
          title: 'Documentation does not cover deployment',
          description:
            'Project documentation was found but does not describe how to deploy, configure, or roll back the service. The operational knowledge then lives with whoever last deployed it.',
          recommendation:
            'Document the required environment variables, the deployment procedure, the rollback procedure, and the expected resource footprint.',
          confidence: 'medium',
          file: docs[0]?.path
        })
      );
    }
  } else {
    result.findings.push(
      makeFinding({
        id: 'DEPLOY-NO-DOCS',
        severity: 'low',
        category: 'deployment',
        title: 'No project documentation was detected',
        description:
          'No README or operational documentation was included in the analyzed files, so nothing records how to configure, deploy, or roll back the service.',
        recommendation:
          'Add a README covering the required configuration, the deployment procedure, and the rollback procedure.',
        confidence: 'medium'
      })
    );
  }

  return result;
}

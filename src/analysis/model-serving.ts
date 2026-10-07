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
 * Model-serving analysis.
 *
 * The central check is whether the model is loaded once at startup or on every
 * request. To answer that, COUE locates route handlers and determines the
 * extent of each handler body, then looks for model-loading calls inside it.
 *
 * Python bodies are delimited by indentation; JavaScript and TypeScript bodies
 * are delimited by brace depth. Both are approximations of a parse, so findings
 * from this analyzer carry `medium` confidence unless the pattern is
 * unambiguous.
 */

/** Calls that load a model artifact. */
const MODEL_LOAD_PATTERN =
  /\b(?:torch\.load|torch\.jit\.load|load_model|load_state_dict|from_pretrained|joblib\.load|pickle\.load|dill\.load|keras\.models\.load_model|tf\.saved_model\.load|tf\.keras\.models\.load_model|onnxruntime\.InferenceSession|ort\.InferenceSession|AutoModel\w*\.from_pretrained|AutoTokenizer\.from_pretrained|pipeline\s*\(|YOLO\s*\(|SentenceTransformer\s*\(|xgb\.Booster|lgb\.Booster)\s*\(?/;

/** Calls that start a training run. */
const TRAINING_PATTERN =
  /\b(?:\.fit\s*\(|\.train\s*\(\s*\)|trainer\.train\s*\(|\.fit_transform\s*\(|\.partial_fit\s*\(|optimizer\.step\s*\(|loss\.backward\s*\()/;

export interface RouteHandler {
  /** HTTP method, uppercased, or 'ANY' when it could not be determined. */
  method: string;
  /** Route path as written, e.g. `/predict`. */
  path: string;
  /** 1-based line of the route declaration. */
  declarationLine: number;
  /** 1-based inclusive line range of the handler body. */
  bodyStart: number;
  bodyEnd: number;
  bodyText: string;
}

const PY_ROUTE_DECORATOR =
  /^\s*@(\w+)\.(get|post|put|patch|delete|head|options|route|websocket)\s*\(\s*([^,)\s]+)/i;

/** Extracts the indentation width of a line, treating a tab as one level. */
function indentWidth(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

/**
 * Finds route handlers in a Python file by locating route decorators and
 * following the indented block of the function they decorate.
 */
export function findPythonRoutes(file: SourceFile): RouteHandler[] {
  const routes: RouteHandler[] = [];
  const lines = file.lines;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = PY_ROUTE_DECORATOR.exec(line);
    if (!match) continue;

    const verb = (match[2] ?? '').toUpperCase();
    const rawPath = (match[3] ?? '').replace(/['"]/g, '');

    // Walk forward to the `def` / `async def` that this decorator applies to,
    // skipping any further stacked decorators.
    let defIndex = -1;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const candidate = lines[j];
      if (candidate === undefined) continue;
      const trimmed = candidate.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('@')) continue;
      if (/^(?:async\s+)?def\s+\w+/.test(trimmed)) defIndex = j;
      break;
    }
    if (defIndex === -1) continue;

    const defLine = lines[defIndex];
    if (defLine === undefined) continue;
    const defIndent = indentWidth(defLine);

    // The body runs until a non-blank line indented at or below the `def`.
    let bodyEnd = defIndex;
    for (let k = defIndex + 1; k < lines.length; k++) {
      const bodyLine = lines[k];
      if (bodyLine === undefined) continue;
      if (bodyLine.trim() === '') {
        bodyEnd = k;
        continue;
      }
      if (indentWidth(bodyLine) <= defIndent) break;
      bodyEnd = k;
    }

    const bodyText = lines.slice(defIndex, bodyEnd + 1).join('\n');

    routes.push({
      method: verb === 'ROUTE' ? 'ANY' : verb,
      path: rawPath,
      declarationLine: i + 1,
      bodyStart: defIndex + 1,
      bodyEnd: bodyEnd + 1,
      bodyText
    });
  }

  return routes;
}

const JS_ROUTE_CALL =
  /\b(\w+)\.(get|post|put|patch|delete|all|use)\s*\(\s*(['"`])([^'"`]*)\3/;

/**
 * Finds route handlers in a JavaScript or TypeScript file by locating
 * `router.method('/path', ...)` calls and following brace depth to the end of
 * the call expression.
 */
export function findJsRoutes(file: SourceFile): RouteHandler[] {
  const routes: RouteHandler[] = [];
  const lines = file.lines;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = JS_ROUTE_CALL.exec(line);
    if (!match) continue;

    const verb = (match[2] ?? '').toUpperCase();
    const rawPath = match[4] ?? '';
    if (verb === 'USE' && rawPath === '') continue;

    // Track parenthesis depth from the start of the call to its close.
    let depth = 0;
    let started = false;
    let bodyEnd = i;

    for (let k = i; k < Math.min(lines.length, i + 400); k++) {
      const current = lines[k];
      if (current === undefined) continue;
      for (const ch of current) {
        if (ch === '(') {
          depth++;
          started = true;
        } else if (ch === ')') {
          depth--;
        }
      }
      bodyEnd = k;
      if (started && depth <= 0) break;
    }

    routes.push({
      method: verb === 'ALL' || verb === 'USE' ? 'ANY' : verb,
      path: rawPath,
      declarationLine: i + 1,
      bodyStart: i + 1,
      bodyEnd: bodyEnd + 1,
      bodyText: lines.slice(i, bodyEnd + 1).join('\n')
    });
  }

  return routes;
}

export function findRoutes(file: SourceFile): RouteHandler[] {
  if (isPython(file)) return findPythonRoutes(file);
  if (isJsTs(file)) return findJsRoutes(file);
  return [];
}

/** True when the path looks like a liveness/health route. */
function isHealthPath(path: string): boolean {
  return /^\/?(?:health|healthz|livez|liveness|ping|_health|status)\b/i.test(path.replace(/^\//, '/'));
}

/** True when the path looks like a readiness route. */
function isReadinessPath(path: string): boolean {
  return /^\/?(?:ready|readyz|readiness|_ready)\b/i.test(path.replace(/^\//, '/'));
}

/** True when the route is an inference endpoint. */
function isInferencePath(path: string): boolean {
  return /\b(?:predict|infer|inference|classify|detect|score|generate|embed|forward|complete)\b/i.test(
    path
  );
}

/** Module-level (unindented) model loading indicates startup loading. */
function hasModuleLevelModelLoad(file: SourceFile): boolean {
  for (const line of file.lines) {
    if (line === undefined) continue;
    if (indentWidth(line) !== 0) continue;
    if (line.trim().startsWith('#') || line.trim().startsWith('//')) continue;
    if (MODEL_LOAD_PATTERN.test(line)) return true;
  }
  return false;
}

/** FastAPI lifespan / startup hooks and Flask equivalents. */
function hasStartupHook(file: SourceFile): boolean {
  return (
    /@asynccontextmanager|\blifespan\s*=|@app\.on_event\s*\(\s*["']startup["']\)|@app\.before_first_request|\bapp\.state\.\w+\s*=/.test(
      file.content
    ) || /@functools\.lru_cache|@lru_cache|@cache\b/.test(file.content)
  );
}

export function analyzeModelServing(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();

  const sourceFiles = profile.files.filter((f) => (isPython(f) || isJsTs(f)) && !isTestFile(f));
  const allRoutes: Array<{ file: SourceFile; route: RouteHandler }> = [];

  for (const file of sourceFiles) {
    for (const route of findRoutes(file)) {
      allRoutes.push({ file, route });
    }
  }

  // If nothing serves HTTP, this category does not apply.
  if (allRoutes.length === 0 && !profile.servesHttp) {
    result.unknown.push({
      id: 'SERVE-PRESENT',
      category: 'model-serving',
      title: 'Model-serving architecture',
      reason:
        'No HTTP route definitions were detected in the analyzed files. COUE cannot determine how, or whether, this project serves model inference. If the project serves inference, include the serving entry point in the audit.'
    });
    return result;
  }

  const inferenceRoutes = allRoutes.filter(({ route }) => isInferencePath(route.path));
  const healthRoutes = allRoutes.filter(({ route }) => isHealthPath(route.path));
  const readinessRoutes = allRoutes.filter(({ route }) => isReadinessPath(route.path));

  // --- Model loaded per request ---
  for (const { file, route } of allRoutes) {
    if (!MODEL_LOAD_PATTERN.test(route.bodyText)) continue;

    // A load inside the body is only a per-request load when it is not guarded
    // by a cache. A module-level load elsewhere in the file plus a guarded
    // in-body load is the lazy-singleton pattern, which is acceptable.
    const guarded =
      /\bif\s+(?:\w+\s+is\s+None|not\s+\w+)\b/.test(route.bodyText) ||
      /\bglobal\s+\w+/.test(route.bodyText) ||
      /\bapp\.state\.\w+/.test(route.bodyText) ||
      /lru_cache|@cache\b|getOrLoad|ensureModel/.test(route.bodyText);

    const severity = isInferencePath(route.path) ? 'critical' : 'high';

    result.findings.push(
      makeFinding({
        id: guarded ? 'SERVE-MODEL-LAZY-LOAD' : 'SERVE-MODEL-PER-REQUEST',
        severity: guarded ? 'medium' : severity,
        category: 'model-serving',
        title: guarded
          ? 'Model appears to be loaded lazily inside a request handler'
          : 'Model appears to be loaded on every request',
        description: guarded
          ? `The handler for ${route.method} ${route.path} loads a model inside the request path, guarded by what looks like a cache or initialization check. The first request after each process start therefore pays the full load cost, and concurrent first requests can load the model more than once unless the guard is synchronized.`
          : `The handler for ${route.method} ${route.path} calls a model-loading function inside the request body, with no visible cache or initialization guard. Every request then re-reads the model artifact and re-initializes it, which adds the full load time to each request's latency and multiplies memory use under concurrency.`,
        recommendation: guarded
          ? 'Move the load into an application startup hook (FastAPI lifespan, or an explicit initialization at import) so the process is ready before it accepts traffic, and gate readiness on the load completing.'
          : 'Load the model once at process startup, store it on the application state, and reference it from the handler. Report the process as not ready until the load completes.',
        confidence: 'medium',
        file: file.path,
        line: route.declarationLine
      })
    );
  }

  // --- Startup loading as a positive signal ---
  const startupLoaders = sourceFiles.filter(
    (f) => (hasModuleLevelModelLoad(f) || hasStartupHook(f)) && findRoutes(f).length > 0
  );
  const perRequestIds = new Set(result.findings.map((f) => f.id));
  if (startupLoaders.length > 0 && !perRequestIds.has('SERVE-MODEL-PER-REQUEST')) {
    result.passed.push({
      id: 'SERVE-MODEL-STARTUP',
      category: 'model-serving',
      title: 'Model is loaded at process startup rather than per request'
    });
  }

  // --- Training in a request path ---
  for (const { file, route } of allRoutes) {
    if (!TRAINING_PATTERN.test(route.bodyText)) continue;
    result.findings.push(
      makeFinding({
        id: 'SERVE-TRAINING-IN-REQUEST',
        severity: 'critical',
        category: 'model-serving',
        title: 'Training appears to run inside a request handler',
        description:
          `The handler for ${route.method} ${route.path} calls a training or fitting routine. Training inside a request path holds the connection for an unbounded time, competes with inference for CPU, GPU, and memory, and makes the served model depend on request ordering.`,
        recommendation:
          'Move training to an offline pipeline or a background job runner, publish the resulting artifact to a model registry, and have the serving process load a specific published version.',
        confidence: 'medium',
        file: file.path,
        line: route.declarationLine
      })
    );
  }

  // --- Health endpoint ---
  if (healthRoutes.length === 0) {
    result.findings.push(
      makeFinding({
        id: 'SERVE-NO-HEALTH',
        severity: 'high',
        category: 'model-serving',
        title: 'No health endpoint was detected',
        description:
          'No route matching a health or liveness path was found in the analyzed files. Without one, an orchestrator cannot distinguish a process that is running from a process that is serving, and a container stuck after a failed model load keeps receiving traffic.',
        recommendation:
          'Add a lightweight health endpoint that returns quickly without touching the model, and wire it to the container health check and the orchestrator liveness probe.',
        confidence: 'high'
      })
    );
  } else {
    result.passed.push({
      id: 'SERVE-HEALTH',
      category: 'model-serving',
      title: `Health endpoint detected (${healthRoutes[0]?.route.path ?? ''})`
    });
  }

  // --- Readiness endpoint ---
  if (readinessRoutes.length === 0) {
    const severity = inferenceRoutes.length > 0 ? 'medium' : 'low';
    result.findings.push(
      makeFinding({
        id: 'SERVE-NO-READINESS',
        severity,
        category: 'model-serving',
        title: 'No readiness endpoint was detected',
        description:
          'No route matching a readiness path was found. A liveness check alone cannot express "the process is up but the model is not loaded yet", so traffic can be routed to a replica during a rolling deployment before it can serve a prediction.',
        recommendation:
          'Add a readiness endpoint that reports success only once the model is loaded and the process can serve a prediction, and point the orchestrator readiness probe at it.',
        confidence: 'high'
      })
    );
  } else {
    result.passed.push({
      id: 'SERVE-READINESS',
      category: 'model-serving',
      title: `Readiness endpoint detected (${readinessRoutes[0]?.route.path ?? ''})`
    });
  }

  // --- Input validation ---
  for (const { file, route } of inferenceRoutes) {
    const usesSchema =
      /\b(?:BaseModel|pydantic|Field\s*\(|conlist|constr|TypeAdapter)\b/.test(file.content) ||
      /\b(?:zod|z\.object|joi|yup|ajv|celery|marshmallow|Schema\s*\()\b/.test(file.content);

    // A typed parameter annotated with a model class also counts.
    const typedParam = /def\s+\w+\s*\([^)]*:\s*[A-Z]\w+/.test(route.bodyText);

    if (!usesSchema && !typedParam) {
      result.findings.push(
        makeFinding({
          id: 'SERVE-NO-INPUT-VALIDATION',
          severity: 'high',
          category: 'model-serving',
          title: 'Inference endpoint has no detected input validation',
          description:
            `No request-body schema or typed request model was detected for ${route.method} ${route.path}. Unvalidated input reaching a preprocessing or tensor-construction path commonly surfaces as a 500 rather than a 400, and a malformed shape can allocate unbounded memory.`,
          recommendation:
            'Define a request schema that constrains types, field presence, array lengths, and value ranges, and reject anything that does not match with a 4xx response.',
          confidence: 'medium',
          file: file.path,
          line: route.declarationLine
        })
      );
      break; // One finding is enough to make the point.
    }
  }

  if (inferenceRoutes.length > 0 && !result.findings.some((f) => f.id === 'SERVE-NO-INPUT-VALIDATION')) {
    result.passed.push({
      id: 'SERVE-INPUT-VALIDATION',
      category: 'model-serving',
      title: 'Inference endpoints declare a request schema'
    });
  }

  // --- Error handling in inference handlers ---
  const unhandled = inferenceRoutes.filter(
    ({ route }) =>
      !/\btry\b|\bcatch\s*\(|\.catch\s*\(|HTTPException|abort\s*\(|raise\s+\w*Error/.test(route.bodyText)
  );
  if (unhandled.length > 0 && inferenceRoutes.length > 0) {
    const first = unhandled[0];
    result.findings.push(
      makeFinding({
        id: 'SERVE-NO-ERROR-HANDLING',
        severity: 'medium',
        category: 'model-serving',
        title: 'Inference handler has no detected error handling',
        description:
          `The handler for ${first?.route.method} ${first?.route.path} contains no error handling around the inference call. An exception raised during preprocessing or inference then becomes an unhandled 500, and in many frameworks the default handler returns a stack trace.`,
        recommendation:
          'Wrap the inference call, map expected failures to explicit 4xx and 5xx responses, and return a message that does not include internal detail.',
        confidence: 'medium',
        file: first?.file.path,
        line: first?.route.declarationLine
      })
    );
  }

  // --- Timeout handling ---
  const hasTimeout = sourceFiles.some((f) =>
    /\btimeout\s*[=:]|asyncio\.wait_for|signal\.alarm|AbortController|request_timeout|--timeout\b/.test(
      f.content
    )
  );
  if (inferenceRoutes.length > 0 && !hasTimeout) {
    result.findings.push(
      makeFinding({
        id: 'SERVE-NO-TIMEOUT',
        severity: 'medium',
        category: 'model-serving',
        title: 'No inference timeout handling was detected',
        description:
          'No timeout configuration was found around the inference path. A pathological input or a stalled accelerator call then holds a worker indefinitely, and under load the whole pool can be consumed by requests that will never complete.',
        recommendation:
          'Apply a bounded timeout to the inference call, return a 503 or 504 when it is exceeded, and configure a matching server-level request timeout.',
        confidence: 'medium'
      })
    );
  } else if (hasTimeout) {
    result.passed.push({
      id: 'SERVE-TIMEOUT',
      category: 'model-serving',
      title: 'Timeout configuration was detected'
    });
  }

  // --- Model version / metadata ---
  const hasModelVersion = sourceFiles.some((f) =>
    /\bmodel_version\b|\bMODEL_VERSION\b|\bmodelVersion\b|\bmodel_id\b|\bMODEL_ID\b|\brevision\s*=/.test(
      f.content
    )
  );
  if (!hasModelVersion) {
    result.findings.push(
      makeFinding({
        id: 'SERVE-NO-MODEL-VERSION',
        severity: 'medium',
        category: 'model-serving',
        title: 'No model version identifier was detected in the serving code',
        description:
          'Nothing in the analyzed serving code records which model version is loaded. When a prediction is disputed or a regression appears after a deployment, there is no way to tie a response back to the artifact that produced it.',
        recommendation:
          'Load an explicit model version or artifact identifier, expose it from the health or readiness endpoint, and include it in prediction responses and logs.',
        confidence: 'medium'
      })
    );
  } else {
    result.passed.push({
      id: 'SERVE-MODEL-VERSION',
      category: 'model-serving',
      title: 'A model version identifier is referenced in the serving code'
    });
  }

  // --- Hard-coded artifact paths ---
  for (const file of sourceFiles) {
    const match = /["'](?:\/(?:home|Users|mnt|media|tmp)\/[^"']{3,}|[A-Za-z]:\\\\[^"']{3,})["']/.exec(
      file.content
    );
    if (!match) continue;
    result.findings.push(
      makeFinding({
        id: 'SERVE-HARDCODED-PATH',
        severity: 'medium',
        category: 'model-serving',
        title: 'An absolute filesystem path is hard-coded in the source',
        description:
          'An absolute path that looks like a developer workstation location appears in the source. A container or a different host will not have that path, so the process fails at startup in every environment except the one it was written on.',
        recommendation:
          'Read artifact and data locations from configuration or an environment variable, with a documented default that is valid inside the container.',
        confidence: 'medium',
        file: file.path,
        evidence: match[0]
      })
    );
    break;
  }

  // --- GPU assumptions ---
  const assumesCuda = sourceFiles.some((f) =>
    /\.cuda\s*\(\s*\)|device\s*=\s*["']cuda["']|\.to\s*\(\s*["']cuda["']\s*\)/.test(f.content)
  );
  const checksAvailability = sourceFiles.some((f) =>
    /cuda\.is_available\s*\(\)|torch\.device\s*\(|list_physical_devices|get_device\b|DEVICE\s*=/.test(
      f.content
    )
  );

  if (assumesCuda && !checksAvailability) {
    result.findings.push(
      makeFinding({
        id: 'SERVE-GPU-ASSUMED',
        severity: 'high',
        category: 'model-serving',
        title: 'Code moves the model to a CUDA device without checking availability',
        description:
          'The serving code places tensors or the model on a CUDA device unconditionally. On a host or container without a visible GPU this raises at startup or on the first request. COUE does not assume this project requires a GPU; the issue is the missing fallback, not the use of a GPU.',
        recommendation:
          'Select the device once from an availability check or from configuration, use that device everywhere, and log the selected device at startup.',
        confidence: 'high'
      })
    );
  } else if (assumesCuda && checksAvailability) {
    result.passed.push({
      id: 'SERVE-DEVICE-SELECTION',
      category: 'model-serving',
      title: 'Compute device is selected from an availability check rather than assumed'
    });
  }

  // --- Batching / concurrency note for ML projects ---
  if (inferenceRoutes.length > 0 && hasMlFramework(profile)) {
    const hasBatching = sourceFiles.some((f) =>
      /\bbatch_size\b|\bmax_batch\b|\bdynamic_batching\b|\bbatcher\b/.test(f.content)
    );
    if (!hasBatching) {
      result.unknown.push({
        id: 'SERVE-BATCHING',
        category: 'model-serving',
        title: 'Inference batching strategy',
        reason:
          'No batching configuration was detected in the analyzed files. Whether batching is needed depends on the traffic profile and latency target, which COUE cannot determine from source alone.'
      });
    }
  }

  return result;
}

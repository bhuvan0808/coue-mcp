import { emptyResult, makeFinding, type AnalyzerResult } from './findings.js';
import {
  NODE_LOCKFILES,
  PYTHON_LOCKFILES,
  hasMlFramework,
  isJsTs,
  isPython,
  isTestFile,
  type ProjectProfile,
  type SourceFile
} from './project-detector.js';

/**
 * Reproducibility analysis.
 *
 * COUE checks whether a training run could be repeated and whether a served
 * artifact can be traced back to the code and data that produced it. It does
 * not require any particular MLOps platform: an experiment tracker, a plain
 * metadata file, and a versioned object store all satisfy the same checks.
 */

/** Configuration file names that commonly carry training hyperparameters. */
const CONFIG_NAMES = new Set([
  'config.yaml',
  'config.yml',
  'config.json',
  'config.toml',
  'params.yaml',
  'params.yml',
  'hparams.yaml',
  'hyperparameters.yaml',
  'train_config.yaml',
  'training_config.yaml',
  'model_config.yaml',
  'settings.yaml',
  'settings.toml'
]);

/** Files that indicate dataset or pipeline versioning. */
const DATA_VERSIONING_FILES = [
  { pattern: /\.dvc$/, tool: 'DVC' },
  { pattern: /^dvc\.yaml$/, tool: 'DVC' },
  { pattern: /^dvc\.lock$/, tool: 'DVC' },
  { pattern: /^\.lakefs\.yaml$/, tool: 'lakeFS' },
  { pattern: /^lakectl\.yaml$/, tool: 'lakeFS' }
];

/** Experiment-tracking imports. */
const TRACKING_PATTERNS: Array<{ pattern: RegExp; tool: string }> = [
  { pattern: /\bimport\s+mlflow\b|\bfrom\s+mlflow[\s.]/, tool: 'MLflow' },
  { pattern: /\bimport\s+wandb\b|\bfrom\s+wandb[\s.]/, tool: 'Weights & Biases' },
  { pattern: /\bfrom\s+clearml[\s.]|\bimport\s+clearml\b/, tool: 'ClearML' },
  { pattern: /\bimport\s+neptune\b|\bfrom\s+neptune[\s.]/, tool: 'Neptune' },
  { pattern: /\bimport\s+aim\b|\bfrom\s+aim[\s.]/, tool: 'Aim' },
  { pattern: /\bimport\s+comet_ml\b|\bfrom\s+comet_ml[\s.]/, tool: 'Comet' },
  { pattern: /\bSummaryWriter\s*\(|\bfrom\s+torch\.utils\.tensorboard[\s.]/, tool: 'TensorBoard' },
  { pattern: /\bimport\s+sacred\b/, tool: 'Sacred' }
];

/** Seed-setting calls across the common frameworks. */
const SEED_PATTERNS = [
  /\btorch\.manual_seed\s*\(/,
  /\btorch\.cuda\.manual_seed(?:_all)?\s*\(/,
  /\bnp\.random\.seed\s*\(/,
  /\bnumpy\.random\.seed\s*\(/,
  /\brandom\.seed\s*\(/,
  /\btf\.random\.set_seed\s*\(/,
  /\btf\.set_random_seed\s*\(/,
  /\bset_seed\s*\(/,
  /\bpl\.seed_everything\s*\(/,
  /\bseed_everything\s*\(/,
  /\brandom_state\s*=\s*\d+/,
  /\bPYTHONHASHSEED\b/
];

/** True when the file looks like a training entry point. */
function isTrainingFile(file: SourceFile): boolean {
  if (isTestFile(file)) return false;
  const name = file.name;
  if (/^(?:train|training|fit|finetune|fine_tune|pretrain)[._]/.test(name)) return true;
  if (/^(?:train|training)\.(?:py|ts|js)$/.test(name)) return true;
  return /\b(?:\.fit\s*\(|trainer\.train\s*\(|\.train\s*\(\s*\)|loss\.backward\s*\(|optimizer\.step\s*\()/.test(
    file.content
  );
}

export function analyzeReproducibility(profile: ProjectProfile): AnalyzerResult {
  const result = emptyResult();

  const codeFiles = profile.files.filter((f) => isPython(f) || isJsTs(f));
  const trainingFiles = codeFiles.filter(isTrainingFile);
  const isMlProject = hasMlFramework(profile);

  // --- Random seed ---
  if (trainingFiles.length > 0) {
    const seeded = trainingFiles.filter((f) => SEED_PATTERNS.some((p) => p.test(f.content)));

    if (seeded.length === 0) {
      result.findings.push(
        makeFinding({
          id: 'REPRO-NO-SEED',
          severity: 'medium',
          category: 'reproducibility',
          title: 'No random seed configuration was detected in training code',
          description:
            'Training code was detected but no seed-setting call was found for the random number generators in use. Two runs of the same code on the same data then produce different weights, so a result cannot be reproduced and a regression cannot be isolated from run-to-run variance.',
          recommendation:
            'Set a seed for every generator the run uses (Python random, NumPy, and the framework), read the value from configuration, and record it with the run metadata. Note that seeding alone does not make GPU training bit-exact; deterministic kernels must also be enabled where exactness is required.',
          confidence: 'medium',
          file: trainingFiles[0]?.path
        })
      );
    } else {
      result.passed.push({
        id: 'REPRO-SEED',
        category: 'reproducibility',
        title: 'Random seed configuration is present in training code'
      });
    }
  } else if (isMlProject) {
    result.unknown.push({
      id: 'REPRO-SEED',
      category: 'reproducibility',
      title: 'Random seed configuration',
      reason:
        'No training code was included in the analyzed files, so COUE could not evaluate seeding. Include the training entry point to have this checked.'
    });
  }

  // --- Configuration file ---
  const configFiles = profile.files.filter(
    (f) => CONFIG_NAMES.has(f.name) || /(^|\/)conf(?:ig)?\//.test(f.path.toLowerCase())
  );
  if (configFiles.length > 0) {
    result.passed.push({
      id: 'REPRO-CONFIG',
      category: 'reproducibility',
      title: `Configuration is externalized (${configFiles[0]?.path ?? ''})`
    });
  } else if (trainingFiles.length > 0) {
    result.findings.push(
      makeFinding({
        id: 'REPRO-NO-CONFIG',
        severity: 'medium',
        category: 'reproducibility',
        title: 'No training configuration file was detected',
        description:
          'No configuration file carrying hyperparameters was found, which suggests training settings are embedded in the code. Reproducing a past run then requires recovering the exact source revision, and comparing two runs requires reading a diff rather than two config files.',
        recommendation:
          'Move hyperparameters into a configuration file, load it at the start of the run, and store a copy of the resolved configuration with the run output.',
        confidence: 'medium'
      })
    );
  }

  // --- Dataset versioning ---
  const dataVersioning = profile.files.find((f) =>
    DATA_VERSIONING_FILES.some((d) => d.pattern.test(f.name))
  );
  const referencesVersionedData = codeFiles.some((f) =>
    /\bdvc\b|\bs3:\/\/[^\s"']+\/v\d|\bdataset_version\b|\bDATASET_VERSION\b|\bdata_version\b|\bhuggingface_hub\b|\bload_dataset\s*\([^)]*revision\s*=/.test(
      f.content
    )
  );

  if (dataVersioning) {
    result.passed.push({
      id: 'REPRO-DATA-VERSION',
      category: 'reproducibility',
      title: `Dataset versioning is configured (${dataVersioning.path})`
    });
  } else if (referencesVersionedData) {
    result.passed.push({
      id: 'REPRO-DATA-VERSION',
      category: 'reproducibility',
      title: 'Code references a versioned dataset location'
    });
  } else if (trainingFiles.length > 0) {
    result.unknown.push({
      id: 'REPRO-DATA-VERSION',
      category: 'reproducibility',
      title: 'Dataset versioning',
      reason:
        'No dataset versioning configuration was detected in the analyzed files. COUE cannot determine from source alone whether training data is versioned outside the repository. If data is versioned in an external system, this check is satisfied by that system.'
    });
  }

  // --- Model versioning / registry ---
  const registryReference = codeFiles.some((f) =>
    /\bmlflow\.(?:register_model|pyfunc|sklearn|pytorch)\b|\bmodel_registry\b|\bModelVersion\b|\bwandb\.(?:Artifact|log_artifact)\b|\bhf_hub_download\b|\bpush_to_hub\b|\bsagemaker\b|\bvertex_ai\b|\bmodel_version\b|\bMODEL_VERSION\b/.test(
      f.content
    )
  );

  if (registryReference) {
    result.passed.push({
      id: 'REPRO-MODEL-VERSION',
      category: 'reproducibility',
      title: 'Model artifacts are versioned or published to a registry'
    });
  } else if (isMlProject) {
    result.findings.push(
      makeFinding({
        id: 'REPRO-NO-MODEL-VERSION',
        severity: 'medium',
        category: 'reproducibility',
        title: 'No model versioning or registry reference was detected',
        description:
          'Nothing in the analyzed files records which artifact a deployment is serving or where it came from. A model file referenced by a fixed path can be replaced in place, after which the deployed behaviour no longer corresponds to any recorded run.',
        recommendation:
          'Publish each artifact under an immutable version identifier, whether to a model registry or a versioned object-store prefix, and have the serving code load a specific version rather than a mutable path.',
        confidence: 'medium'
      })
    );
  }

  // --- Experiment tracking ---
  const tracking = TRACKING_PATTERNS.find((t) => codeFiles.some((f) => t.pattern.test(f.content)));
  if (tracking) {
    result.passed.push({
      id: 'REPRO-TRACKING',
      category: 'reproducibility',
      title: `Experiment tracking is configured (${tracking.tool})`
    });
  } else if (trainingFiles.length > 0) {
    result.findings.push(
      makeFinding({
        id: 'REPRO-NO-TRACKING',
        severity: 'low',
        category: 'reproducibility',
        title: 'No experiment tracking was detected',
        description:
          'No experiment-tracking integration was found in the analyzed files. Without a record of parameters, metrics, and artifacts per run, comparing a candidate model against the deployed one relies on manually kept notes.',
        recommendation:
          'Record parameters, metrics, the resolved configuration, the code revision, and the output artifact for every training run. A tracking service is one option; a structured metadata file written alongside each artifact satisfies the same need.',
        confidence: 'medium'
      })
    );
  }

  // --- Dependency locking (shared signal with the dependency analyzer) ---
  const hasLock = profile.files.some(
    (f) => PYTHON_LOCKFILES.has(f.name) || NODE_LOCKFILES.has(f.name)
  );
  if (hasLock) {
    result.passed.push({
      id: 'REPRO-DEP-LOCK',
      category: 'reproducibility',
      title: 'Dependency versions are locked'
    });
  }

  // --- Evaluation metrics ---
  const hasEvaluation = codeFiles.some(
    (f) =>
      /\b(?:accuracy_score|f1_score|precision_score|recall_score|roc_auc_score|mean_squared_error|mean_absolute_error|classification_report|confusion_matrix|evaluate\s*\(|compute_metrics|\.score\s*\()/.test(
        f.content
      ) || /(^|\/)eval(?:uate|uation)?[._]/.test(f.name)
  );

  if (hasEvaluation) {
    result.passed.push({
      id: 'REPRO-EVALUATION',
      category: 'reproducibility',
      title: 'Evaluation metrics are computed in the project'
    });
  } else if (isMlProject && trainingFiles.length > 0) {
    result.findings.push(
      makeFinding({
        id: 'REPRO-NO-EVALUATION',
        severity: 'medium',
        category: 'reproducibility',
        title: 'No evaluation metric computation was detected',
        description:
          'No metric computation was found in the analyzed files. Without a recorded evaluation on a held-out set, there is no gate that distinguishes a candidate model that improved from one that regressed.',
        recommendation:
          'Evaluate every candidate on a fixed held-out set, record the metrics with the artifact, and make promotion to production conditional on them.',
        confidence: 'medium'
      })
    );
  }

  // --- Artifact provenance ---
  const hasProvenance = codeFiles.some((f) =>
    /\bgit_commit\b|\bgit_sha\b|\bcommit_hash\b|\bGIT_COMMIT\b|\bgit\s+rev-parse\b|\bmetadata\.json\b|\bMODEL_CARD\b/.test(
      f.content
    )
  );
  const hasModelCard = profile.files.some(
    (f) => /model[_-]card/i.test(f.name) || f.name === 'model_metadata.json'
  );

  if (hasProvenance || hasModelCard) {
    result.passed.push({
      id: 'REPRO-PROVENANCE',
      category: 'reproducibility',
      title: 'Artifact provenance metadata is recorded'
    });
  } else if (isMlProject) {
    result.unknown.push({
      id: 'REPRO-PROVENANCE',
      category: 'reproducibility',
      title: 'Model artifact provenance',
      reason:
        'No code revision, dataset identifier, or run metadata was found associated with model artifacts in the analyzed files. COUE cannot determine whether provenance is recorded by a pipeline outside the analyzed source.'
    });
  }

  return result;
}

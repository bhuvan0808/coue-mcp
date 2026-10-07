import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RawFile } from '../../src/analysis/audit-service.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');

/** Reads a directory on disk into the RawFile shape the tools accept. */
export function loadProjectFromDisk(relativeDir: string): RawFile[] {
  const base = join(repoRoot, relativeDir);
  const files: RawFile[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      files.push({
        path: relative(base, full).split(sep).join('/'),
        content: readFileSync(full, 'utf8')
      });
    }
  }

  walk(base);
  return files;
}

/** The demo project shipped under examples/, loaded from disk. */
export function demoProject(): RawFile[] {
  return loadProjectFromDisk('examples/demo-ml-project');
}

/**
 * A project that follows the practices COUE checks for. Used to prove the
 * analyzers do not fire on a well-built project.
 */
export const healthyProject: RawFile[] = [
  {
    path: 'requirements.txt',
    content: [
      'fastapi==0.110.0',
      'uvicorn==0.29.0',
      'torch==2.2.1',
      'pydantic==2.6.4',
      'structlog==24.1.0',
      'prometheus-client==0.20.0',
      'evidently==0.4.19'
    ].join('\n')
  },
  {
    path: 'requirements.lock',
    content: 'fastapi==0.110.0 --hash=sha256:aaaa\ntorch==2.2.1 --hash=sha256:bbbb\n'
  },
  {
    path: 'config.yaml',
    content: ['training:', '  seed: 42', '  epochs: 10', 'model:', '  version: v3.1.0'].join('\n')
  },
  {
    path: 'app.py',
    content: `import os
import time
import logging
import structlog
import torch
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from prometheus_client import Counter, Histogram

log = structlog.get_logger()

MODEL_VERSION = os.environ.get("MODEL_VERSION", "v3.1.0")
MODEL_PATH = os.environ.get("MODEL_PATH", "/models/model.pt")
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "5.0"))

inference_seconds = Histogram("inference_seconds", "Inference duration")
predictions_total = Counter("predictions_total", "Predictions served")

state = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["model"] = torch.load(MODEL_PATH, map_location=DEVICE)
    state["model"].eval()
    log.info("model_loaded", model_version=MODEL_VERSION, device=str(DEVICE))
    yield
    state.clear()


app = FastAPI(lifespan=lifespan)


class PredictRequest(BaseModel):
    pixels: list[float] = Field(..., min_length=1, max_length=150528)


@app.get("/health")
def health():
    return {"status": "ok", "model_version": MODEL_VERSION}


@app.get("/ready")
def ready():
    if "model" not in state:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {"status": "ready", "model_version": MODEL_VERSION}


@app.post("/predict")
def predict(request: PredictRequest):
    start = time.perf_counter()
    try:
        tensor = torch.tensor(request.pixels, device=DEVICE).unsqueeze(0)
        with torch.no_grad():
            output = state["model"](tensor)
        predictions_total.inc()
        return {"prediction": int(output.argmax()), "model_version": MODEL_VERSION}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        inference_seconds.observe(time.perf_counter() - start)
`
  },
  {
    path: 'train.py',
    content: `import random
import numpy as np
import torch
import mlflow
from sklearn.metrics import accuracy_score, f1_score


def set_seed(seed: int = 42):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def train(loader, val_loader, epochs: int = 10, seed: int = 42):
    set_seed(seed)
    with mlflow.start_run():
        mlflow.log_param("seed", seed)
        mlflow.log_param("epochs", epochs)
        model = build()
        for _ in range(epochs):
            for x, y in loader:
                step(model, x, y)
        preds, labels = evaluate(model, val_loader)
        mlflow.log_metric("accuracy", accuracy_score(labels, preds))
        mlflow.log_metric("f1", f1_score(labels, preds, average="macro"))
        mlflow.pytorch.log_model(model, "model", registered_model_name="demo")
    return model
`
  },
  {
    path: 'monitoring.py',
    content: `from evidently.report import Report
from evidently.metric_preset import DataDriftPreset


def check_drift(reference_df, current_df):
    report = Report(metrics=[DataDriftPreset()])
    report.run(reference_data=reference_df, current_data=current_df)
    return report.as_dict()


def log_prediction(record):
    """Persist a sampled prediction record for later accuracy measurement."""
    return record
`
  },
  {
    path: 'Dockerfile',
    content: `FROM python:3.11.9-slim AS builder
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.11.9-slim
RUN groupadd --system app && useradd --system --gid app app
WORKDIR /app
COPY --from=builder /install /usr/local
COPY --chown=app:app . .
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"
CMD ["gunicorn", "app:app", "-k", "uvicorn.workers.UvicornWorker", "-b", "0.0.0.0:8000", "--timeout", "60"]
`
  },
  {
    path: '.dockerignore',
    content: '.git\n.env\n.env.*\n.venv\nvenv\n__pycache__\ndata/\ncheckpoints/\n*.pt\n'
  },
  {
    path: '.gitignore',
    content: '.env\n.env.*\n__pycache__/\n*.pt\n.venv/\n'
  },
  {
    path: 'k8s/deployment.yaml',
    content: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
spec:
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/demo@sha256:0123456789abcdef
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "2"
              memory: 4Gi
          readinessProbe:
            httpGet:
              path: /ready
              port: 8000
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
`
  },
  {
    path: '.github/workflows/ci.yml',
    content: `name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements.txt
      - run: pytest -q
`
  },
  {
    path: 'tests/test_api.py',
    content: `import pytest
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_predict_returns_prediction():
    response = client.post("/predict", json={"pixels": [0.1, 0.2, 0.3]})
    assert response.status_code == 200
    assert "prediction" in response.json()


def test_predict_rejects_invalid_input():
    response = client.post("/predict", json={"pixels": "not-a-list"})
    assert response.status_code == 422


def test_preprocess_normalizes_consistently():
    from app import PredictRequest
    model = PredictRequest(pixels=[1.0, 2.0])
    assert len(model.pixels) == 2
`
  },
  {
    path: 'README.md',
    content: `# Demo service

## Deployment

Build the image, push it, and apply the Kubernetes manifests in k8s/.

Required environment variables: MODEL_PATH, MODEL_VERSION, REQUEST_TIMEOUT.

## Rollback

Roll back by applying the previous image digest.
`
  }
];

/**
 * A project with severe, unambiguous problems, used to prove the scoring
 * engine drives a genuinely bad project into the lowest band.
 */
export const highRiskProject: RawFile[] = [
  {
    path: 'requirements.txt',
    content: 'flask\ntorch\nrequests\n'
  },
  {
    path: 'app.py',
    content: `from flask import Flask, request
import pickle
import subprocess

app = Flask(__name__)

AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7FAKEKEY"
DATABASE_URL = "postgresql://admin:hunter2@db.internal:5432/prod"

@app.route("/predict", methods=["POST"])
def predict():
    model = pickle.load(open("model.pkl", "rb"))
    data = request.get_json()
    subprocess.run(data["cmd"], shell=True)
    return {"result": str(model.predict(data["x"]))}

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
`
  },
  {
    path: 'Dockerfile',
    content: `FROM ubuntu
RUN apt-get update && apt-get install -y python3 python3-pip gcc build-essential
COPY .env /app/.env
COPY . /app
ENV API_KEY=sk_live_abcdef0123456789abcdef
EXPOSE 22
EXPOSE 5432
CMD ["python3", "/app/app.py"]
`
  },
  {
    path: 'docker-compose.yml',
    content: `services:
  api:
    build: .
    privileged: true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`
  }
];

/** A minimal Node/Express ML service, to exercise the JS analyzers. */
export const nodeProject: RawFile[] = [
  {
    path: 'package.json',
    content: JSON.stringify(
      {
        name: 'node-infer',
        version: '1.0.0',
        dependencies: { express: '^4.19.2' },
        devDependencies: { vitest: '^1.0.0' },
        scripts: { test: 'vitest run' }
      },
      null,
      2
    )
  },
  {
    path: 'server.js',
    content: `const express = require('express');
const app = express();

app.post('/predict', async (req, res) => {
  const model = await loadModel('./model.onnx');
  res.json({ prediction: model.run(req.body) });
});

app.listen(3000);
`
  }
];

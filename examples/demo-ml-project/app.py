"""Demo inference service.

This file is intentionally imperfect. It is the fixture COUE's own test suite
uses to prove the analyzers detect real production issues. Do not copy it.

Deliberate issues:
  - the model is loaded inside the request handler, on every request
  - there is no health endpoint and no readiness endpoint
  - request input is not validated
  - there is no error handling or timeout around inference
  - a placeholder credential is assigned in source
  - the development server is used as the entry point
  - CUDA is assumed without an availability check
"""

import torch
from fastapi import FastAPI
from PIL import Image
import numpy as np

app = FastAPI()

# A clearly fake value. COUE should flag the pattern, never echo the value.
API_KEY = "EXAMPLE_API_KEY_NOT_REAL"

MODEL_PATH = "/home/mluser/checkpoints/model.pt"


def preprocess(payload):
    """Turn an incoming payload into a tensor. No validation whatsoever."""
    array = np.array(payload["pixels"], dtype=np.float32)
    return torch.from_numpy(array).unsqueeze(0)


@app.post("/predict")
def predict(payload: dict):
    # Issue: the model is loaded from disk on every single request.
    model = torch.load(MODEL_PATH)
    model.eval()
    model = model.cuda()

    tensor = preprocess(payload).cuda()
    output = model(tensor)
    return {"prediction": int(output.argmax())}


@app.post("/retrain")
def retrain(payload: dict):
    # Issue: training runs inside a request handler.
    model = torch.load(MODEL_PATH)
    optimizer = torch.optim.SGD(model.parameters(), lr=0.001)
    for _ in range(payload.get("epochs", 1)):
        loss = model(torch.randn(1, 3, 224, 224)).sum()
        loss.backward()
        optimizer.step()
    return {"status": "done"}


if __name__ == "__main__":
    # Issue: Flask/uvicorn development server used as the production entry point.
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

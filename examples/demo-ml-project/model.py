"""Model definition and training entry point for the demo project.

This file is intentionally imperfect. Deliberate issues:
  - no random seed is set, so training is not reproducible
  - no experiment tracking
  - no evaluation metrics are computed
  - no model versioning; the artifact is written to a fixed, mutable path
"""

import torch
import torch.nn as nn
import torchvision


def build_model(num_classes: int = 10) -> nn.Module:
    model = torchvision.models.resnet18(weights=None)
    model.fc = nn.Linear(model.fc.in_features, num_classes)
    return model


def train(data_loader, epochs: int = 10, lr: float = 0.001):
    """Train the model. No seed, no tracking, no evaluation."""
    model = build_model()
    optimizer = torch.optim.SGD(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()

    for _ in range(epochs):
        for images, labels in data_loader:
            optimizer.zero_grad()
            loss = criterion(model(images), labels)
            loss.backward()
            optimizer.step()

    # Issue: written to a fixed path with no version identifier.
    torch.save(model, "/home/mluser/checkpoints/model.pt")
    return model

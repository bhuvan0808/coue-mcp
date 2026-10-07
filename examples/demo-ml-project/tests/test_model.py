"""A deliberately thin test suite.

It covers model construction only: nothing exercises preprocessing, the API,
input validation, or the health endpoint. COUE should report those gaps.
"""

from model import build_model


def test_build_model_has_expected_output_size():
    model = build_model(num_classes=10)
    assert model.fc.out_features == 10

#!/usr/bin/env python3
"""
train_hazard_tree.py
====================

DRISHTI / SIH — TinyML multi-hazard Decision Tree

This version deliberately uses overlapping, physics-informed synthetic
scenarios so the classifier cannot solve the task with one obvious
"sensor > threshold" rule.

Classes:
  0 NORMAL
  1 FLASH_FLOOD
  2 WILDFIRE
  3 GAS_LEAK

Input features:
  [0] Filtered_Water_mm
  [1] Water_Surge_Rate_mm_s
  [2] Filtered_Gas_PPM
  [3] Gas_Rate_PPM_s
  [4] Temp_C
  [5] Vibration_RMS

The resulting tree is still intentionally shallow so it can be exported
with emlearn and executed on an STM32 without a heap/runtime dependency.
"""

import os
import numpy as np
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
)
import emlearn


# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

RANDOM_SEED = 42
N_PER_CLASS = 5000

MAX_TREE_DEPTH = 5
MIN_LEAF_SIZE = 20

OUTPUT_FILE = "hazard_model.h"
MODEL_NAME = "hazard_tree"

FEATURE_NAMES = [
    "Filtered_Water_mm",
    "Water_Surge_Rate",
    "Filtered_Gas_PPM",
    "Gas_Rate_PPM_s",
    "Temp_C",
    "Vibration_RMS",
]

CLASS_NAMES = [
    "NORMAL",
    "FLASH_FLOOD",
    "WILDFIRE",
    "GAS_LEAK",
]

np.random.seed(RANDOM_SEED)


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def clip_sensor_ranges(X):
    """
    Keep generated values inside physically plausible prototype ranges.
    This is synthetic training data, not a regulatory measurement limit.
    """
    X[:, 0] = np.clip(X[:, 0], 0, 1200)   # water mm
    X[:, 1] = np.clip(X[:, 1], -50, 200)  # water surge mm/s
    X[:, 2] = np.clip(X[:, 2], 0, 1000)   # gas ppm
    X[:, 3] = np.clip(X[:, 3], -30, 250)  # gas rate ppm/s
    X[:, 4] = np.clip(X[:, 4], -10, 120)  # temperature C
    X[:, 5] = np.clip(X[:, 5], 0, 30)     # vibration RMS
    return X


def make_class_samples(class_id, n):
    """
    Generate overlapping environmental scenarios.

    The important difference from the old dataset is that NORMAL itself
    contains difficult/high-but-stable conditions. This prevents the model
    from learning "high absolute value == hazard".

    Hazard classes also overlap, forcing the tree to use combinations such
    as level + rate, gas + gas-rate, and gas/temperature relationships.
    """

    if class_id == 0:
        # NORMAL:
        # Multiple normal operating conditions, including:
        # - high but stable water
        # - hot weather without a gas rise
        # - elevated gas that is not rapidly increasing
        modes = np.random.choice(4, size=n)

        X = np.zeros((n, 6), dtype=float)

        distributions = [
            ([100, 0, 25, 0, 25, 4],  [50, 8, 20, 6, 5, 2]),
            ([450, 3, 35, 1, 27, 5],  [50, 8, 20, 6, 5, 2]),
            ([140, 2, 45, 2, 48, 5],  [50, 8, 20, 6, 5, 2]),
            ([120, 1, 250, 2, 29, 5], [50, 8, 20, 6, 5, 2]),
        ]

        for mode in range(4):
            idx = np.where(modes == mode)[0]
            if len(idx):
                mean, scale = distributions[mode]
                X[idx] = np.random.normal(mean, scale, (len(idx), 6))

        return clip_sensor_ranges(X)

    if class_id == 1:
        # FLASH FLOOD:
        # High water AND rapidly changing water are the main signatures.
        # Some samples overlap normal water levels, making rate important.
        X = np.random.normal(
            loc=[420, 55, 35, 3, 27, 9],
            scale=[160, 28, 30, 7, 5, 3],
            size=(n, 6),
        )
        return clip_sensor_ranges(X)

    if class_id == 2:
        # WILDFIRE:
        # Temperature + smoke/gas + gas-rate correlation.
        # Deliberate overlap with GAS_LEAK forces the classifier to use
        # temperature and other context rather than gas concentration alone.
        X = np.random.normal(
            loc=[160, 8, 260, 45, 58, 10],
            scale=[70, 12, 100, 22, 15, 4],
            size=(n, 6),
        )
        return clip_sensor_ranges(X)

    if class_id == 3:
        # GAS LEAK:
        # High gas concentration + rapidly increasing gas, while temperature
        # generally remains much closer to ambient than wildfire.
        X = np.random.normal(
            loc=[130, 2, 430, 80, 31, 7],
            scale=[60, 10, 160, 40, 7, 3],
            size=(n, 6),
        )
        return clip_sensor_ranges(X)

    raise ValueError(f"Unknown class: {class_id}")


# ---------------------------------------------------------------------------
# DATASET
# ---------------------------------------------------------------------------

print("=" * 72)
print("DRISHTI TinyML Hazard Model Training")
print("=" * 72)
print()
print("Generating overlapping synthetic environmental scenarios...")

X_parts = []
y_parts = []

for class_id in range(4):
    X_parts.append(make_class_samples(class_id, N_PER_CLASS))
    y_parts.append(np.full(N_PER_CLASS, class_id, dtype=int))

X = np.vstack(X_parts)
y = np.concatenate(y_parts)

print(f"  Total samples : {len(X):,}")
print(f"  Per class     : {N_PER_CLASS:,}")
print(f"  Features      : {X.shape[1]}")
print()

# 80/20 stratified split
X_train, X_test, y_train, y_test = train_test_split(
    X,
    y,
    test_size=0.20,
    random_state=RANDOM_SEED,
    stratify=y,
)


# ---------------------------------------------------------------------------
# MODEL
# ---------------------------------------------------------------------------

print("Training DecisionTreeClassifier...")

clf = DecisionTreeClassifier(
    max_depth=MAX_TREE_DEPTH,
    min_samples_leaf=MIN_LEAF_SIZE,
    random_state=RANDOM_SEED,
)

clf.fit(X_train, y_train)

train_pred = clf.predict(X_train)
test_pred = clf.predict(X_test)

train_acc = accuracy_score(y_train, train_pred)
test_acc = accuracy_score(y_test, test_pred)

print()
print("=" * 72)
print("MODEL EVALUATION")
print("=" * 72)
print(f"Training accuracy : {train_acc * 100:.2f}%")
print(f"Test accuracy     : {test_acc * 100:.2f}%")
print(f"Actual depth      : {clf.get_depth()}")
print(f"Leaves            : {clf.get_n_leaves()}")

print()
print("Classification report:")
print(
    classification_report(
        y_test,
        test_pred,
        target_names=CLASS_NAMES,
        digits=4,
    )
)

print("Confusion matrix:")
print(confusion_matrix(y_test, test_pred))

print()
print("Feature importance:")
for name, importance in zip(FEATURE_NAMES, clf.feature_importances_):
    print(f"  {name:24s}: {importance:.4f}")

print()
print("Learned decision tree:")
print(
    export_text(
        clf,
        feature_names=FEATURE_NAMES,
        decimals=2,
    )
)


# ---------------------------------------------------------------------------
# BORDERLINE / INTERACTION TESTS
# ---------------------------------------------------------------------------

print()
print("=" * 72)
print("BORDERLINE / INTERACTION TESTS")
print("=" * 72)

test_vectors = [
    # Stable high water: should not automatically become flood.
    (
        [450, 2, 35, 1, 27, 5],
        "High but stable water",
    ),

    # Rapid water rise: rate should matter.
    (
        [350, 70, 35, 2, 27, 9],
        "Rapid water rise",
    ),

    # Hot weather without rapid gas increase.
    (
        [140, 2, 50, 2, 50, 5],
        "Hot but stable environment",
    ),

    # Fire-like combination.
    (
        [160, 8, 300, 55, 70, 11],
        "High temperature + rising gas",
    ),

    # Gas leak-like combination.
    (
        [120, 2, 500, 110, 30, 6],
        "High gas + rapid gas rise",
    ),

    # Elevated gas but low rate and normal temperature.
    (
        [120, 1, 250, 2, 29, 5],
        "Elevated but stable gas",
    ),

    # Strong flood signature.
    (
        [650, 90, 30, 2, 25, 12],
        "Strong flood signature",
    ),
]

for features, description in test_vectors:
    predicted = int(clf.predict([features])[0])
    probabilities = clf.predict_proba([features])[0]

    print(
        f"{description:32s} -> "
        f"{CLASS_NAMES[predicted]:12s} "
        f"(confidence={probabilities[predicted] * 100:.1f}%)"
    )


# ---------------------------------------------------------------------------
# EXPORT TO STM32 C HEADER
# ---------------------------------------------------------------------------

print()
print("=" * 72)
print("EXPORTING MODEL")
print("=" * 72)

print(f"Generating '{OUTPUT_FILE}' using emlearn...")

c_model = emlearn.convert(clf, method="inline")
c_model.save(file=OUTPUT_FILE, name=MODEL_NAME)

if os.path.exists(OUTPUT_FILE):
    size_bytes = os.path.getsize(OUTPUT_FILE)
    print(f"SUCCESS: '{OUTPUT_FILE}' generated ({size_bytes:,} bytes)")
    print()
    print(
        "Copy the generated header to:"
    )
    print(
        "  group2-firmware/Core/Inc/hazard_model.h"
    )
    print()
    print(
        "Expected C function:"
    )
    print(
        "  int hazard_tree_predict(const float *features, int n_features);"
    )
else:
    raise RuntimeError(
        f"'{OUTPUT_FILE}' was not generated. "
        "Check your emlearn installation."
    )


# ---------------------------------------------------------------------------
# SANITY CHECKS
# ---------------------------------------------------------------------------

print()
print("=" * 72)
print("SANITY CHECKS")
print("=" * 72)

sanity_vectors = [
    ([100, 0, 20, 0, 25, 5], 0, "NORMAL"),
    ([700, 100, 25, 1, 25, 10], 1, "FLASH_FLOOD"),
    ([150, 5, 300, 55, 70, 10], 2, "WILDFIRE"),
    ([120, 2, 650, 130, 28, 6], 3, "GAS_LEAK"),
]

all_passed = True

for features, expected, label in sanity_vectors:
    predicted = int(clf.predict([features])[0])

    if predicted == expected:
        print(
            f"  PASS | {label:12s} | "
            f"Expected={expected} | Got={predicted}"
        )
    else:
        all_passed = False
        print(
            f"  FAIL | {label:12s} | "
            f"Expected={expected} | Got={predicted}"
        )

if all_passed:
    print()
    print("All sanity checks passed.")
else:
    print()
    print(
        "Some sanity checks failed. Review the generated dataset "
        "before deploying the model."
    )

print()
print("NOTE:")
print("This model is trained on synthetic prototype data.")
print("Its test accuracy measures performance on that synthetic")
print("distribution and must NOT be presented as real-world")
print("hazard-detection accuracy.")

#!/usr/bin/env python3
"""
train_hazard_tree_v3_analysis.py
================================

DRISHTI TinyML prototype — V3 training/analysis only.

Purpose:
    Build a better-balanced synthetic dataset where the Decision Tree must
    use meaningful multi-sensor relationships, while remaining shallow enough
    for later STM32 deployment.

Classes:
    0 NORMAL
    1 FLASH_FLOOD
    2 WILDFIRE
    3 GAS_LEAK

Features:
    [0] Filtered_Water_mm
    [1] Water_Surge_Rate_mm_s
    [2] Filtered_Gas_PPM
    [3] Gas_Rate_PPM_s
    [4] Temp_C
    [5] Vibration_RMS

IMPORTANT:
    This file intentionally does NOT import emlearn and does NOT create or
    overwrite hazard_model.h. Validate the learned model first.
"""

import numpy as np
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix


# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

RANDOM_SEED = 42
N_PER_CLASS = 5000

MAX_TREE_DEPTH = 5
MIN_LEAF_SIZE = 40

FEATURE_NAMES = [
    "Filtered_Water_mm",
    "Water_Surge_Rate_mm_s",
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

rng = np.random.RandomState(RANDOM_SEED)


# ---------------------------------------------------------------------------
# SENSOR RANGE GUARD
# ---------------------------------------------------------------------------

def clip_sensor_ranges(X):
    X[:, 0] = np.clip(X[:, 0], 0, 1200)    # water mm
    X[:, 1] = np.clip(X[:, 1], -10, 150)   # water surge mm/s
    X[:, 2] = np.clip(X[:, 2], 0, 1000)    # gas ppm
    X[:, 3] = np.clip(X[:, 3], -20, 200)   # gas rate ppm/s
    X[:, 4] = np.clip(X[:, 4], -10, 120)   # temperature C
    X[:, 5] = np.clip(X[:, 5], 0, 30)      # vibration RMS
    return X


# ---------------------------------------------------------------------------
# DATA GENERATION
# ---------------------------------------------------------------------------

def make_normal(n):
    """
    NORMAL deliberately contains several realistic-looking operating states:

      1. ordinary ambient conditions
      2. high but stable water
      3. hot weather without a rapid gas rise
      4. elevated but stable gas

    This prevents "high sensor value == hazard".
    """
    modes = rng.choice(4, size=n)
    X = np.zeros((n, 6), dtype=float)

    distributions = [
        # water, surge, gas, gas_rate, temp, vibration
        (
            [100, 0, 25, 0, 25, 4],
            [30, 4, 15, 3, 4, 1.5],
        ),
        (
            [400, 14, 35, 2, 27, 5],
            [65, 7, 20, 4, 5, 2],
        ),
        (
            [140, 2, 60, 3, 47, 5],
            [40, 5, 25, 5, 5, 2],
        ),
        (
            [120, 3, 220, 4, 29, 5],
            [30, 5, 50, 4, 5, 2],
        ),
    ]

    for mode in range(4):
        idx = np.where(modes == mode)[0]
        if len(idx):
            mean, scale = distributions[mode]
            X[idx] = rng.normal(mean, scale, (len(idx), 6))

    return clip_sensor_ranges(X)


def make_flash_flood(n):
    """
    FLASH_FLOOD deliberately overlaps NORMAL.

    The classifier therefore needs both:
      - absolute water level
      - water rise rate

    rather than a single hard-coded water threshold.
    """
    modes = rng.choice(2, size=n)
    X = np.zeros((n, 6), dtype=float)

    distributions = [
        (
            [620, 25, 35, 2, 26, 9],
            [90, 10, 20, 4, 5, 3],
        ),
        (
            [480, 32, 35, 2, 27, 10],
            [75, 11, 20, 4, 5, 3],
        ),
    ]

    for mode in range(2):
        idx = np.where(modes == mode)[0]
        if len(idx):
            mean, scale = distributions[mode]
            X[idx] = rng.normal(mean, scale, (len(idx), 6))

    return clip_sensor_ranges(X)


def make_wildfire(n):
    """
    WILDFIRE:
      elevated temperature + smoke/gas + rising gas.

    There is deliberate overlap with GAS_LEAK so temperature/context matters.
    """
    X = rng.normal(
        [150, 8, 300, 45, 62, 9],
        [55, 10, 105, 20, 12, 3.5],
        (n, 6),
    )
    return clip_sensor_ranges(X)


def make_gas_leak(n):
    """
    GAS_LEAK:
      high gas concentration + fast gas rise,
      while temperature is generally closer to ambient.

    Deliberate overlap with WILDFIRE prevents gas concentration alone from
    determining the class.
    """
    X = rng.normal(
        [125, 3, 470, 85, 30, 7],
        [45, 7, 150, 35, 6, 2.5],
        (n, 6),
    )
    return clip_sensor_ranges(X)


# ---------------------------------------------------------------------------
# BUILD DATASET
# ---------------------------------------------------------------------------

print("=" * 72)
print("DRISHTI TinyML Hazard Model — V3")
print("=" * 72)
print()
print("Generating overlapping, multi-sensor synthetic scenarios...")

X = np.vstack([
    make_normal(N_PER_CLASS),
    make_flash_flood(N_PER_CLASS),
    make_wildfire(N_PER_CLASS),
    make_gas_leak(N_PER_CLASS),
])

y = np.concatenate([
    np.zeros(N_PER_CLASS, dtype=int),
    np.ones(N_PER_CLASS, dtype=int),
    np.full(N_PER_CLASS, 2, dtype=int),
    np.full(N_PER_CLASS, 3, dtype=int),
])

print(f"  Total samples : {len(X):,}")
print(f"  Per class     : {N_PER_CLASS:,}")
print(f"  Features      : {X.shape[1]}")
print()


# ---------------------------------------------------------------------------
# TRAIN / TEST
# ---------------------------------------------------------------------------

X_train, X_test, y_train, y_test = train_test_split(
    X,
    y,
    test_size=0.20,
    random_state=RANDOM_SEED,
    stratify=y,
)

clf = DecisionTreeClassifier(
    max_depth=MAX_TREE_DEPTH,
    min_samples_leaf=MIN_LEAF_SIZE,
    random_state=RANDOM_SEED,
)

print("Training DecisionTreeClassifier...")
clf.fit(X_train, y_train)

train_pred = clf.predict(X_train)
test_pred = clf.predict(X_test)


# ---------------------------------------------------------------------------
# EVALUATION
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# FEATURE IMPORTANCE
# ---------------------------------------------------------------------------

print()
print("Feature importance:")

for name, importance in zip(FEATURE_NAMES, clf.feature_importances_):
    print(f"  {name:24s}: {importance:.4f}")


# ---------------------------------------------------------------------------
# LEARNED TREE
# ---------------------------------------------------------------------------

print()
print("=" * 72)
print("LEARNED DECISION TREE")
print("=" * 72)

print(
    export_text(
        clf,
        feature_names=FEATURE_NAMES,
        decimals=2,
    )
)


# ---------------------------------------------------------------------------
# TARGETED TEST VECTORS
# ---------------------------------------------------------------------------

print()
print("=" * 72)
print("TARGETED MULTI-SENSOR TESTS")
print("=" * 72)

test_vectors = [
    (
        [100, 0, 25, 0, 25, 4],
        "Normal ambient",
    ),
    (
        [400, 14, 35, 2, 27, 5],
        "High but stable water",
    ),
    (
        [650, 35, 35, 2, 26, 10],
        "High water + rising rapidly",
    ),
    (
        [450, 15, 35, 2, 27, 5],
        "Moderately high water + moderate rise",
    ),
    (
        [140, 2, 60, 3, 50, 5],
        "Hot weather, stable gas",
    ),
    (
        [150, 8, 300, 55, 70, 10],
        "Wildfire signature",
    ),
    (
        [125, 3, 500, 110, 30, 7],
        "Gas leak signature",
    ),
    (
        [120, 3, 220, 4, 29, 5],
        "Elevated but stable gas",
    ),
]

for features, description in test_vectors:
    predicted = int(clf.predict([features])[0])
    probabilities = clf.predict_proba([features])[0]
    confidence = probabilities[predicted] * 100

    print(
        f"{description:40s} -> "
        f"{CLASS_NAMES[predicted]:12s} "
        f"(tree leaf confidence={confidence:.1f}%)"
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
    ([150, 8, 300, 55, 70, 10], 2, "WILDFIRE"),
    ([120, 3, 650, 130, 28, 6], 3, "GAS_LEAK"),
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

print()

if all_passed:
    print("All sanity checks passed.")
else:
    print("Some sanity checks failed.")


# ---------------------------------------------------------------------------
# DEPLOYMENT NOTE
# ---------------------------------------------------------------------------

print()
print("=" * 72)
print("DEPLOYMENT NOTE")
print("=" * 72)
print()
print("This is an ANALYSIS-ONLY script.")
print("It does not import emlearn.")
print("It does not create or overwrite hazard_model.h.")
print()
print("The dataset is synthetic prototype data.")
print("Test accuracy must NOT be presented as real-world hazard-detection")
print("accuracy.")
print()
print("If V3 is approved, the firmware-side workflow can convert this")
print("Decision Tree to STM32-compatible C separately.")

#!/usr/bin/env python3
"""
train_hazard_tree.py
====================
SIH26178 — Group 2 | Day 3: TinyML Model Training & C Header Export

Trains a lightweight DecisionTreeClassifier on synthetic multi-hazard
environmental sensor data and transpiles it into a zero-malloc, Flash-resident
static C header file 'hazard_model.h' using emlearn.

The generated header is used directly in the STM32CubeIDE firmware project:
    Copy hazard_model.h  →  group2-firmware/Core/Inc/hazard_model.h

─── TARGET CLASSES ───────────────────────────────────────────────────────────
  0: NORMAL       — Baseline ambient conditions, no hazard
  1: FLASH_FLOOD  — Rapid water level rise + high surge velocity
  2: WILDFIRE     — Elevated temperature + gas/smoke correlation
  3: GAS_LEAK     — Extreme toxic gas PPM + rapid gas surge rate

─── INPUT FEATURES (6-dimensional vector) ────────────────────────────────────
  [0] Filtered_Water_mm    — FIR-smoothed ultrasonic water level (mm)
  [1] Water_Surge_Rate     — dh/dt surge velocity (mm/s), from derivator
  [2] Filtered_Gas_PPM     — FIR-smoothed gas concentration (PPM)
  [3] Gas_Rate_PPM_s       — dG/dt gas surge rate (PPM/s), from derivator
  [4] Temp_C               — Ambient temperature in Celsius
  [5] Vibration_RMS        — 3-axis seismic acceleration RMS

─── WHY DECISION TREE? ───────────────────────────────────────────────────────
  - Deterministic: always runs in < 15 µs regardless of input
  - No floating-point division or transcendental functions
  - emlearn transpiles it into static const arrays → Flash .rodata
  - Zero malloc, zero heap, zero runtime dependencies on MCU

─── USAGE ────────────────────────────────────────────────────────────────────
  pip install -r requirements.txt
  python train_hazard_tree.py
  # Then copy generated hazard_model.h to group2-firmware/Core/Inc/
"""

import os
import numpy as np
from sklearn.tree import DecisionTreeClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score
import emlearn

# ──────────────────────────────────────────────────────────────────────────────
#  REPRODUCIBILITY
# ──────────────────────────────────────────────────────────────────────────────
RANDOM_SEED    = 42
N_PER_CLASS    = 4000    # Samples per hazard class (16,000 total)
MAX_TREE_DEPTH = 5       # Shallow tree → guaranteed µs-level MCU inference
MIN_LEAF_SIZE  = 5       # Prevents overfitting on noisy sensor edge cases
OUTPUT_FILE    = "hazard_model.h"
MODEL_NAME     = "hazard_tree"   # C function prefix: hazard_tree_predict()

np.random.seed(RANDOM_SEED)

# ──────────────────────────────────────────────────────────────────────────────
#  FEATURE & CLASS METADATA
# ──────────────────────────────────────────────────────────────────────────────
FEATURE_NAMES = [
    "Filtered_Water_mm",   # [0]
    "Water_Surge_Rate",    # [1]
    "Filtered_Gas_PPM",    # [2]
    "Gas_Rate_PPM_s",      # [3]
    "Temp_C",              # [4]
    "Vibration_RMS",       # [5]
]
CLASS_NAMES = ["NORMAL", "FLASH_FLOOD", "WILDFIRE", "GAS_LEAK"]

# ──────────────────────────────────────────────────────────────────────────────
#  SYNTHETIC DATA GENERATION (Physics-Informed Gaussian Distributions)
#
#  Each class is centred on physical disaster measurement statistics:
#   loc  = realistic mean value for that hazard scenario
#   scale = realistic standard deviation (sensor noise + environmental variance)
# ──────────────────────────────────────────────────────────────────────────────

print("Generating synthetic disaster physics dataset...")

# Class 0: NORMAL — calm ambient conditions
# Water ~100mm, no surge, low gas, warm/cool temp, minimal vibration
X_normal = np.random.normal(
    loc=[100, 0, 20, 0, 25, 5],
    scale=[20, 2, 5, 1, 3, 2],
    size=(N_PER_CLASS, 6)
)
y_normal = np.zeros(N_PER_CLASS, dtype=int)

# Class 1: FLASH FLOOD — rapidly rising water with high surge velocity
# Water ~600mm, high surge +85 mm/s, normal gas, normal temp
X_flood = np.random.normal(
    loc=[600, 85, 20, 0, 24, 8],
    scale=[80, 20, 5, 1, 2, 3],
    size=(N_PER_CLASS, 6)
)
y_flood = np.ones(N_PER_CLASS, dtype=int)

# Class 2: WILDFIRE — high temperature, elevated smoke/gas and gas surge rate
# Normal water, high temp 65°C, gas ~250 PPM rising at 45 PPM/s
X_fire = np.random.normal(
    loc=[120, 0, 250, 45, 65, 6],
    scale=[20, 2, 40, 10, 8, 2],
    size=(N_PER_CLASS, 6)
)
y_fire = np.full(N_PER_CLASS, 2, dtype=int)

# Class 3: GAS LEAK — extreme gas concentration surging rapidly
# Normal water level, explosive gas ~600 PPM rising at 120 PPM/s
X_gas = np.random.normal(
    loc=[110, 0, 600, 120, 27, 4],
    scale=[15, 1, 80, 25, 3, 1],
    size=(N_PER_CLASS, 6)
)
y_gas = np.full(N_PER_CLASS, 3, dtype=int)

# Combine all classes
X = np.vstack([X_normal, X_flood, X_fire, X_gas])
y = np.concatenate([y_normal, y_flood, y_fire, y_gas])

print(f"  Total samples : {len(X):,}  ({N_PER_CLASS:,} per class × 4 classes)")
print(f"  Feature dims  : {X.shape[1]}")

# ──────────────────────────────────────────────────────────────────────────────
#  TRAIN / TEST SPLIT  (80% train, 20% test, stratified)
# ──────────────────────────────────────────────────────────────────────────────
X_train, X_test, y_train, y_test = train_test_split(
    X, y,
    test_size=0.2,
    random_state=RANDOM_SEED,
    stratify=y    # Ensures balanced class distribution in both splits
)

# ──────────────────────────────────────────────────────────────────────────────
#  MODEL TRAINING
# ──────────────────────────────────────────────────────────────────────────────
print("\nTraining DecisionTreeClassifier...")
clf = DecisionTreeClassifier(
    max_depth=MAX_TREE_DEPTH,
    min_samples_leaf=MIN_LEAF_SIZE,
    random_state=RANDOM_SEED
)
clf.fit(X_train, y_train)

# ──────────────────────────────────────────────────────────────────────────────
#  EVALUATION
# ──────────────────────────────────────────────────────────────────────────────
train_acc = accuracy_score(y_train, clf.predict(X_train))
test_acc  = accuracy_score(y_test,  clf.predict(X_test))

print(f"\n{'='*60}")
print(f"  TRAINING ACCURACY  : {train_acc * 100:.2f}%")
print(f"  TEST ACCURACY      : {test_acc  * 100:.2f}%")
print(f"  TREE DEPTH (actual): {clf.get_depth()}")
print(f"  TREE LEAVES        : {clf.get_n_leaves()}")
print(f"{'='*60}")

print("\nClassification Report (Test Set):")
print(classification_report(y_test, clf.predict(X_test),
                            target_names=CLASS_NAMES))

# ──────────────────────────────────────────────────────────────────────────────
#  TRANSPILE TO C HEADER (emlearn)
#
#  method='inline' generates an if/else decision tree in C — no arrays,
#  no loops, just branching comparisons. This is the fastest possible
#  inference path on Cortex-M4F (pipeline-friendly conditional branches).
#
#  The output C function signature will be:
#    int hazard_tree_predict(const float *features, int n_features);
#
#  All data lives in Flash .rodata:
#    static const int32_t hazard_tree_nodes_* = { ... };
# ──────────────────────────────────────────────────────────────────────────────
print(f"\nTranspiling to C header '{OUTPUT_FILE}' using emlearn...")

c_model = emlearn.convert(clf, method='inline')
c_model.save(file=OUTPUT_FILE, name=MODEL_NAME)

# ── Verification ──────────────────────────────────────────────────────────────
if os.path.exists(OUTPUT_FILE):
    size_bytes = os.path.getsize(OUTPUT_FILE)
    print(f"\n✅ SUCCESS: '{OUTPUT_FILE}' generated ({size_bytes:,} bytes)")
    print(f"\n   Next Step:")
    print(f"   Copy '{OUTPUT_FILE}'  →  group2-firmware/Core/Inc/hazard_model.h")
    print(f"   Then rebuild STM32CubeIDE project.")
else:
    print(f"\n❌ ERROR: '{OUTPUT_FILE}' was NOT created. Check emlearn installation.")

# ── Quick Sanity Check — Test Known Vectors ───────────────────────────────────
print("\n── Sanity Check: Known Test Vectors ─────────────────────────────────────")
test_vectors = [
    ([100, 0, 20, 0, 25, 5],    0, "NORMAL     "),
    ([700, 150, 20, 0, 25, 5],  1, "FLASH_FLOOD"),
    ([120, 0, 280, 50, 68, 6],  2, "WILDFIRE   "),
    ([110, 0, 650, 130, 27, 4], 3, "GAS_LEAK   "),
]
all_passed = True
for features, expected_class, label in test_vectors:
    predicted = int(clf.predict([features])[0])
    status = "✅ PASS" if predicted == expected_class else "❌ FAIL"
    if predicted != expected_class:
        all_passed = False
    print(f"  {status} | {label} | Expected={expected_class} | Got={predicted}")

if all_passed:
    print("\n✅ All sanity checks passed — model is ready for STM32 deployment!")
else:
    print("\n⚠️  Some sanity checks failed — review training data distributions.")

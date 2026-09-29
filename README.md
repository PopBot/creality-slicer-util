# Creality K1 Slicer Util ⚡

A high-performance, developer-grade CLI and interactive 3D Plate Studio for the **Creality K1** 3D printer.

Built to eliminate the bloat, slow startup, and telemetry/spyware concerns of vendor GUI slicers while providing 100% slicing parity with Creality Print v5 using the audited, open-source **OrcaSlicer Core** engine.

---

## Features

- ⚡ **Instant Headless Slicing:** Slice directly from your terminal in under 1 second (`k1-slice model.stl`).
- 🎯 **Smart Geometry Engine:**
  - Automatic centering at $(110, 110)$ on the $220 \times 220\text{ mm}$ K1 build bed.
  - Automatic grounding to $Z = 0$.
  - Real-time boundary validation (warns if model penetrates bed, floats unsupported, or exceeds $220 \times 220 \times 250\text{ mm}$).
- 🧭 **Heuristic Auto-Orient:** Analyzes planar facets to identify optimal orientation for maximum bed adhesion and minimal support volume.
- 📐 **Interactive 3D Plate Studio (Browser):**
  - Full 360-degree freedom in all 3 axes (orbit, pan, zoom, preset views).
  - Out-of-bounds visual feedback (model turns glowing red if outside envelope).
  - **Click-to-Lay-Flat:** Click any surface on the 3D model to instantly align it flush with the build plate.
  - 3D Transform Gizmos for translation, rotation (with +90° shortcuts), and scale.
  - Multi-file staging on a single build plate.
- 🎛️ **Exact Creality K1 Settings Parity:**
  - Presets: Standard (0.20mm), Fine (0.12mm), Optimal (0.16mm), Draft (0.24mm).
  - Filaments: Creality Hyper PLA (up to 600 mm/s), Generic PLA, Hyper PETG, Hyper ABS, Generic TPU 95A.
  - Infill controls (Gyroid, Grid, Cubic, Honeycomb, Lightning).
  - Support structures (Tree / Organic vs Normal / Grid).
  - Wall loops, perimeters, and brim adhesion.
- 📡 **Direct Network Printing:**
  - Upload directly to Creality K1 over LAN via Moonraker (port `7125`) or stock Creality OS Web API (port `80`).
  - Optional `--print` flag to fire-and-forget start the job immediately.

---

## Installation

### Prerequisites
1. **Node.js** (v18+)
2. **OrcaSlicer** (core slicing engine):
   ```bash
   brew install --cask orcaslicer
   ```

### Setup
```bash
git clone <repo-url>
cd creality-slicer-util
npm install
npm run build
npm link # (Optional: allows running 'k1-slice' anywhere)
```

---

## CLI Usage

### Basic Slicing (Headless)
Slice an STL file with default Creality K1 Standard profile (0.20mm, Hyper PLA, Gyroid infill):
```bash
k1-slice ./my_bracket.stl
```
Output:
```text
======================================================
  ⚡ CREALITY K1 SLICER ENGINE (OrcaSlicer Core)
  Bed Volume: 220 × 220 × 250 mm | Preset: standard
======================================================

📦 Model Metrics: my_bracket.stl
   Dimensions : 45.0 × 30.0 × 18.0 mm
   Position   : X [0.0 to 45.0], Y [0.0 to 30.0], Z [0.0 to 18.0]
   Triangles  : 1,840
🎯 Auto-centering model at (110, 110) and grounding to Z=0...
🔪 Slicing with Creality K1 profiles...

✅ SLICING COMPLETE in 0.4s!
──────────────────────────────────────────────────────
  ⏱️  Est. Print Time : 24m 15s
  🧵 Filament Used   : 2.18 m (6.5 g)
  🥞 Layer Count     : 90 layers
  📏 Max Z Height    : 18.00 mm
  💾 Output G-Code   : ./my_bracket.gcode (1.20 MB)
──────────────────────────────────────────────────────
```

### Launch Interactive 3D Plate Studio
To preview, inspect, or adjust orientation before slicing:
```bash
k1-slice ./my_bracket.stl --preview
```
*(Also automatically triggers if boundary issues like floating meshes or bed clipping are detected)*.

### Custom Settings & Overrides
```bash
# High detail (0.12mm), 30% gyroid infill, 4 wall loops, tree supports:
k1-slice figurine.stl -p fine --infill 30 --infill-pattern gyroid --walls 4 --supports --support-type tree

# Draft speed (0.24mm) for rapid prototyping:
k1-slice enclosure.stl -p draft -m hyper-pla --infill 15

# PETG functional part with brim:
k1-slice hinge.stl -m petg --brim outer --walls 4
```

### Direct LAN Printing to Creality K1
```bash
# Slice and upload to K1's Moonraker:
k1-slice gear.stl --printer-ip 192.168.1.150

# Slice, upload, AND immediately start printing:
k1-slice gear.stl --printer-ip 192.168.1.150 --print
```

---

## Command Line Options Reference

| Flag | Description | Default |
| :--- | :--- | :--- |
| `-p, --preset <preset>` | Quality preset: `standard` (0.20mm), `fine` (0.12mm), `optimal` (0.16mm), `draft` (0.24mm) | `standard` |
| `-m, --material <mat>` | Filament: `hyper-pla`, `pla`, `petg`, `abs`, `tpu` | `hyper-pla` |
| `--infill <percent>` | Infill density percentage (e.g. `20` for 20%) | Preset default |
| `--infill-pattern <pat>`| Pattern: `gyroid`, `grid`, `cubic`, `honeycomb`, `lightning` | `gyroid` |
| `--layer-height <mm>` | Custom layer height in mm | Preset default |
| `--supports` | Enable support generation | Auto |
| `--no-supports` | Explicitly disable supports | - |
| `--support-type <type>`| Support style: `tree` (organic) or `normal` (grid) | `tree` |
| `--brim <type>` | Brim adhesion: `auto`, `outer`, `inner_and_outer`, `none` | `auto` |
| `--walls <count>` | Number of wall loops / perimeters | Preset default |
| `-o, --output <path>` | Custom output `.gcode` destination | `<model>.gcode` |
| `-i, --preview` | Force launch 3D Plate Studio in default browser | - |
| `--auto-center` | Automatically center mesh at $(110, 110)$ and drop to $Z=0$ | `true` |
| `--auto-orient` | Heuristically orient mesh to maximize bed contact area | - |
| `--printer-ip <ip>` | K1 LAN IP address (uploads via Moonraker or Creality OS) | - |
| `--print` | Automatically start print job after network upload | `false` |
| `--headless` | Force headless slicing even if placement warnings exist | `false` |

---

## 3D Plate Studio Keyboard & Mouse Shortcuts

- **Left Mouse Click + Drag:** 360° Orbit camera in all 3 axes.
- **Right Mouse Click + Drag:** Pan camera.
- **Scroll Wheel:** Zoom in / out.
- **Gizmo Keys:** `T` for Translate, `R` for Rotate, `S` for Scale.
- **Click-to-Lay-Flat:** Toggle tool and click any triangle face on the model to orient that face flat against the bed.

---

## Architecture & Verification

```text
k1-slice (CLI)
   │
   ├─► STLParser (Geometry verification & auto-centering)
   ├─► AutoOrient (Planar normal vector scoring)
   ├─► 3D Plate Studio (Express + Three.js local studio on ephemeral port)
   ├─► OrcaWrapper (Spawns OrcaSlicer CLI with Creality K1 profiles)
   ├─► GcodeParser (Extracts print times, filament mass/length, layer counts)
   └─► K1PrinterClient (Moonraker port 7125 & Creality OS port 80 HTTP client)
```

Run test suite:
```bash
npm test # runs npx tsx tests/slicer.test.ts
```
All unit and end-to-end tests verify mesh dimension checks, auto-centering, out-of-bounds triggers, and G-code generation with Creality K1 start macros.

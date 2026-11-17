# Project Plan: AI-Powered Stairs & Ladders Desktop Utility

## 1. Executive Summary & Architectural Principle

A cross-platform desktop engineering and carpentry suite for designing staircases, verifying ladder safety, generating 2D/3D parametric visualizations, and auditing building code compliance using an embedded AI Copilot.

### Hybrid Determinism Architecture

* **Deterministic Calculation Core:** All structural math, geometry, and CAD exports are computed by strict, unit-tested deterministic modules (zero AI hallucination risk).
* **AI Copilot Layer:** An LLM layer interacts with the app's unified JSON state via Structured Outputs / Function Calling—translating natural language into design parameters, parsing sketches, and auditing calculated geometry against building codes.

### Phase-Gated Execution Protocol (Mandatory)

* **Sequential Delivery:** Implementation must proceed strictly one phase at a time in sequential order (Phase 1 $\rightarrow$ Phase 2 $\rightarrow$ Phase 3 $\rightarrow$ Phase 4).
* **Explicit Approval Checkpoint:** At the completion of each phase, execution must pause, present a summary of completed deliverables and verification tests, and **explicitly ask for user confirmation before starting the next phase**.

---

## 2. Unified Data Architecture (Single Source of Truth)

Both the 2D/3D renderers and the AI Copilot read from and write to a central `ProjectState` JSON schema:

```json
{
  "projectType": "staircase",
  "units": "imperial",
  "stairParams": {
    "style": "straight",
    "totalRise": 108.0,
    "totalRun": 132.0,
    "width": 36.0,
    "treadThickness": 1.5,
    "riserThickness": 0.75,
    "nosing": 1.0,
    "headroomCeilingHeight": 96.0,
    "balusterSpacingMax": 4.0
  },
  "ladderParams": {
    "workingHeight": 144.0,
    "ladderType": "extension",
    "surfaceType": "concrete"
  },
  "calculatedMetrics": {
    "stepCount": 14,
    "unitRise": 7.71,
    "unitRun": 10.15,
    "stringerLength": 170.6,
    "pitchAngleDegrees": 37.2,
    "headroomClearance": 81.5,
    "ladderBaseSetback": 36.0,
    "codeCompliant": true
  }
}
```

---

## 3. Comprehensive Feature Specifications

### A. Core Engineering & Carpentry Calculators

1. **Staircase Stringer & Geometry Calculator**
   * **Details:** Calculates exact step counts, unit rise, unit run, stringer hypotenuse length, plumb/level cut angles, and pitch angle from floor-to-floor height and horizontal run constraints. Supports straight, L-shaped (with landing), U-shaped, and spiral configurations.
   * **Precision:** Handles both Metric (mm/cm) and Imperial (fractional inches down to 1/16") units without floating-point drift.

2. **4-to-1 Ladder Safety & Setup Calculator**
   * **Details:** Computes safe base setback distance ($1\text{ ft}$ out for every $4\text{ ft}$ of wall height), verifies the target $75.5^\circ$ setup angle, calculates required extension ladder overlap sections, and specifies top extension clearance above roof edges ($3\text{ ft}$ / $0.9\text{ m}$ rule).

3. **Baluster & Railing Spacing Calculator**
   * **Details:** Automatically divides horizontal and angled railing runs to distribute balusters evenly while strictly enforcing safety sphere rules (e.g., ensuring gaps never exceed $4\text{ inches}$ / $100\text{ mm}$).

4. **Ramp & Slope Pitch Converter**
   * **Details:** Converts between degrees, pitch ratio ($X:12$), and percentage grade for accessibility ramps and steep stairways, checking against ADA/accessibility slope limits.

### B. Interactive 2D & 3D Visualization Utilities

1. **Parametric 3D Staircase & Ladder Viewport**
   * **Details:** Real-time 3D interactive scene where users can orbit, pan, zoom, and toggle component visibility (hide treads to inspect stringer notches, toggle handrails, or inspect landing framing). Any parameter change immediately morphs the 3D geometry.

2. **First-Person Headroom Clearance Simulator**
   * **Details:** Virtual walkthrough camera mode that simulates ascending the staircase at eye level while rendering a translucent ceiling/joist plane overhead, visually highlighting tight clearance zones in red if headroom drops below code minimums (e.g., $6\text{ ft } 8\text{ in}$).

3. **Automated 2D Blueprint & Shop Drawing Generator**
   * **Details:** Generates crisp multi-view orthogonal projections (side elevation, top plan, front view, and stringer notch cross-sections) with architectural dimension lines, angle arcs, and framing callouts ready for workshop printing.

4. **Visual Cut-List & 1D/2D Nesting Optimizer**
   * **Details:** Solves the stock-cutting problem visually, mapping required stringers, treads, risers, and posts onto standard commercial lumber lengths ($8\text{ ft}, 10\text{ ft}, 12\text{ ft}, 16\text{ ft}$). Color-codes cut pieces versus offcut waste and displays waste percentages.

### C. AI Assistance & Copilot Utilities (Early-Phase Core)

1. **Natural Language Parametric Controller**
   * **Details:** Conversational sidebar allowing users to input spatial constraints in plain language (e.g., *"I have a 108-inch ceiling height and only 120 inches of hallway length—design a compliant L-shaped stair"*). Uses LLM Function Calling to populate the `ProjectState` JSON and update 2D/3D views automatically.

2. **AI Building Code & Safety Compliance Auditor**
   * **Details:** Continuously monitors `calculatedMetrics` against international and regional standards (IRC, IBC, OSHA, Eurocode). Flags violations in plain English (e.g., riser height variance, insufficient tread depth, or unsafe ladder angle) and suggests exact parameter adjustments to achieve compliance.

3. **AI Sketch-to-3D Floor Plan Parser**
   * **Details:** Lets users drag and drop a photo of a stairwell space or a hand-drawn dimensioned sketch. Multimodal vision extracts wall-to-wall measurements and ceiling heights to pre-fill the stair/ladder calculator.

4. **AI Structural & Load Advisor**
   * **Details:** Evaluates stringer span lengths, wood species selection (e.g., Southern Yellow Pine, Douglas Fir, White Oak), and live-load requirements, recommending mid-span support walls, doubled stringers, or thicker stock where deflection risks occur.

5. **AI Material Cost & Sourcing Advisor**
   * **Details:** Reads the generated Bill of Materials (board feet, hardware, concrete footings) and provides estimated project cost ranges, species alternatives, and step-by-step assembly instructions tailored to the user's exact geometry.

### D. Desktop Power-User & Workshop Tools

1. **CAD, CNC & Print Export Suite**
   * **Details:** Native file exports including **PDF** (multi-page workshop blueprint packet), **SVG** (clean vector drawings), **DXF** (for AutoCAD/Fusion 360), and **STL** (3D printable scale models or CNC router stringer templates).

2. **Bill of Materials (BOM) & Hardware Manifest**
   * **Details:** Automatically tabulates required lumber boards, structural screws, joist hangers, anchor bolts, and handrail brackets with export to CSV/Excel.

3. **OSHA / Pre-Use Ladder & Stair Inspection Logger**
   * **Details:** Built-in safety audit checklist for contractors and facility managers with pass/fail criteria, inspector notes, and timestamped PDF report generation.

4. **Multi-Project Workspace Manager**
   * **Details:** Local project library allowing contractors to organize multiple client builds, duplicate design variations (e.g., comparing straight vs. U-shaped options), and save revision snapshots.

---

## 4. Phased Implementation Roadmap (Gate-Controlled Execution)

> **Execution Rule:** Work must stop at the end of each phase. Do not proceed to the subsequent phase until the user has reviewed the deliverables and explicitly approved moving forward.

### Phase 1: Deterministic Math Core & AI Copilot Foundation
* **Scope:**
  * Build unit-tested math engines for Staircases, 4-to-1 Ladders, Baluster Spacing, and Ramp Pitch Conversions.
  * Implement the unified `ProjectState` store with real-time metric recalculation.
  * Integrate the AI Copilot Sidebar with Function Calling (`updateDesignParameters` and `auditBuildingCode`) so natural language control and live safety checks work from day one.
* **Phase 1 Gate:** Verify math accuracy with unit tests and test AI natural-language parameter updates. **Stop and ask user approval before starting Phase 2.**

### Phase 2: Interactive 2D Blueprints & AI Annotations
* **Scope:**
  * Build the dynamic 2D orthogonal schematic renderer (side profile, top plan, stringer notch layout, and ladder angle diagram) bound to `ProjectState`.
  * Add AI-generated workshop assembly notes and step-by-step cutting instructions tied to the 2D schematic.
  * Implement native PDF and SVG shop-sheet exports.
* **Phase 2 Gate:** Verify dimension accuracy on 2D drawings and test PDF/SVG output files. **Stop and ask user approval before starting Phase 3.**

### Phase 3: Parametric 3D Viewport & Vision Input
* **Scope:**
  * Build the interactive 3D parametric modeler for staircases, landings, railings, and ladders.
  * Add the First-Person Headroom Walkthrough camera mode with red-zone clearance alerts.
  * Integrate AI Sketch-to-3D image parsing to convert uploaded floor plan sketches into 3D models.
* **Phase 3 Gate:** Verify real-time 3D mesh morphing, headroom collision checks, and sketch-to-3D parsing. **Stop and ask user approval before starting Phase 4.**

### Phase 4: Optimization, CAD Exports & Pro Management
* **Scope:**
  * Implement the 1D/2D Cut-List Nesting Optimizer and full Bill of Materials (BOM) generator.
  * Add DXF and STL CAD export pipelines.
  * Add the AI Structural/Load Advisor, AI Cost Estimator, OSHA Inspection Checklist, and Multi-Project Workspace Manager.
* **Phase 4 Gate:** Final end-to-end verification of CAD exports, optimization accuracy, and offline fallback capabilities. **Present final release summary for user sign-off.**

---

## 5. AI Guardrails & Engineering Safety Rules

1. **Strict Separation of Math and LLM:** The AI never computes raw geometry, hypotenuse lengths, or structural load capacities directly. It only calls validated deterministic functions or interprets their verified outputs.
2. **Traceable Code Citations:** Every AI building code warning must reference the specific standard rule (e.g., *IRC R311.7.5.1 Max Riser Height: 7.75 in*) alongside a disclaimer to confirm with local building authorities.
3. **Offline Job-Site Capability:** Architecture supports local LLM inference fallback so contractors working without internet access retain access to natural language parameter adjustments and code checks.
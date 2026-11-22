# Social Media Launch Plan — FloorPlan Studio

> Interpretation: the posts should be **substantive, not skim-bait**. The first two lines stop the scroll; the rest rewards people who slow down. If a shorter, faster-to-read version is wanted, compress this plan.

---

## 1. Positioning

**Core message:** “I built a local-first desktop CAD/AI tool, and the interesting engineering is in the constraints — not the demo.”

Two audiences, one post:

| Audience | What they need to see |
|---|---|
| Developers | Stack choices, tradeoffs, security model, CI rigor, real numbers |
| Recruiters | Ownership, end-to-end scope, product thinking, communication |

Avoid: “excited to announce”, hype adjectives, long feature lists.  
Use: concrete numbers, one strong opinion, one honest tradeoff, one question.

---

## 2. Repo prep before posting

At the time of writing the repo is public, MIT-licensed, TypeScript-primary, with 0 stars, no releases, no description and no topics. Fix that first:

- **GitHub description:**  
  `Local-first Tauri 2 desktop studio for 2D floor plans, 3D views, on-device ONNX plan extraction, and stair shop drawings.`
- **Topics:** `tauri` `rust` `typescript` `react` `threejs` `onnx` `cad` `local-first` `engineering`
- **Social preview:** use `docs/screenshots/03-floorplan-3d-sunny.png` cropped to 1280×640.
- **Pin** the repo on the GitHub profile, with `WIKI.md` as the visual entry point.
- **LinkedIn Featured section:** repo link + WIKI link.
- Do **not** claim downloadable releases — there are none yet. Say “clone and run from source”; remember `git lfs install`.

---

## 3. Asset plan

All screenshots are 1600×1000 (16:10), so crop to 1600×900 for X and 1200×628 for LinkedIn.

| Asset | Use | Source |
|---|---|---|
| A — Hero composite | LinkedIn cover image | `docs/screenshots/02-floorplan-2d.png` + `03-floorplan-3d-sunny.png` + `06-stair-3d.png`, labelled “2D → 3D → shop-ready” |
| B — Hook image | X tweet 1 | `docs/screenshots/03-floorplan-3d-sunny.png`, cropped 1600×900 |
| C — Geometry image | X tweet 2/3 | `docs/screenshots/02-floorplan-2d.png` |
| D — Shop drawing image | X tweet 5 | `docs/screenshots/07-shop-drawings.png` |
| E — 20–30s screen recording | Optional, strongest asset | Draw wall → insert door → switch to 3D → toggle lighting → export sheet. No audio needed; captions on screen. |

Alt text to reuse:

- “2D floor-plan workspace with walls, doors and furniture on the drafting canvas.”
- “Extruded 3D view of the same plan in daylight with furniture and open windows.”
- “Parametric staircase in 3D with treads, stringers and railing.”
- “Shop drawing sheet with side elevation, plan view and stringer notch layout.”

---

## 4. Post 1 — X thread (7 tweets)

**Tweet 1 — hook + image B**

> I built a desktop app that turns a scanned floor plan into editable geometry — without uploading the image.
>
> The demo is 10 seconds. The engineering took much longer. Here's the part you don't see 🧵

**Tweet 2 — stack**

> Stack: Tauri 2 + React 19 + TypeScript + Three.js, with a deliberately small Rust backend.
>
> The vision path runs ONNX Runtime Web locally. The model (~98 MB) lives in Git LFS, so a clone needs `git lfs install`.

**Tweet 3 — the design constraint**

> The constraint I cared about: no “AI or nothing”.
>
> Gemini and local Ollama share prompts, validation, streaming and structured JSON. With no key configured, the app falls back to a deterministic geometry solver.

**Tweet 4 — security**

> Security is where desktop apps get interesting.
>
> Tauri capability scoped to the main window. HTTP limited to localhost:11434 and Gemini. Explicit denies for .ssh, .aws, .gnupg, .env. One custom IPC command. No shell execution.

**Tweet 5 — domain depth + image D**

> Then the boring domain work:
>
> rise/run, headroom, baluster spacing, cut optimizer, bill of materials, code audit, SVG/PDF shop sheets.
>
> 167 Vitest tests cover the logic. The Rust side has its own tests.

**Tweet 6 — CI proof**

> CI does more than go green:
>
> gitleaks on full history · clippy -D warnings · cargo audit · Trivy HIGH/CRITICAL · CodeQL · TS/Rust coverage + a 5% duplication gate.
>
> Badges are published to a `badges` branch from the workflow.

**Tweet 7 — CTA**

> It's MIT licensed and built to be read, not just run.
>
> Repo: https://github.com/ezzakyabdellah/floorplan-studio
> Guided tour: https://github.com/ezzakyabdellah/floorplan-studio/blob/main/WIKI.md
>
> What would you harden first — local model packaging or WebView permissions?

**Pinned reply:** add the security section link: `https://github.com/ezzakyabdellah/floorplan-studio/blob/main/README.md#security--architecture` and the note about Git LFS.

---

## 5. Post 2 — LinkedIn long-form

Use asset A. Put the repo link in the **first comment**, not the post body.

> I built a floor-plan app that can run its AI entirely on your machine.
>
> Then I spent most of the time on the parts you don't see in a demo.
>
> FloorPlan Studio is a Tauri 2 desktop app: React 19 + TypeScript + Three.js in the WebView, a deliberately small Rust backend, and an ONNX segmentation model that turns a scanned plan into editable walls, doors and windows — without uploading the image.
>
> The interesting engineering wasn't the 3D render. It was making three systems agree:
>
> • Geometry: a deterministic layout solver and live rule checks that still work when no model is configured.
>
> • AI: Gemini and local Ollama share the same prompts, validation, streaming and structured-JSON handling. The fallback is geometry, not an error toast.
>
> • Security: the Tauri capability is scoped to one window, HTTP is limited to localhost:11434 and the Gemini endpoint, sensitive paths are explicitly denied, and the API key lives in a per-user .env file — never in the installer.
>
> The unglamorous work mattered just as much:
>
> • 167 Vitest tests plus Rust tests
> • gitleaks on full history, clippy -D warnings, cargo audit, Trivy and CodeQL
> • coverage and duplication badges published from CI: TypeScript 63.9%, Rust 50%, duplication 2.9%
> • a ~98 MB ONNX model in Git LFS, with benchmark notes in the repo
>
> I owned the product surfaces, the engineering math, the security model and the CI — MIT licensed, with the tradeoffs documented rather than hidden.
>
> Repo in the first comment.
>
> If you've shipped local ML inside a desktop app, what would you harden first: model packaging or WebView permissions?
>
> #TypeScript #Rust #Tauri #OpenSource #SoftwareEngineering

**First comment:**

> Repo: https://github.com/ezzakyabdellah/floorplan-studio
> Guided tour with screenshots: https://github.com/ezzakyabdellah/floorplan-studio/blob/main/WIKI.md
> Security architecture and known tradeoffs: https://github.com/ezzakyabdellah/floorplan-studio/blob/main/README.md#security--architecture
>
> Note: clone with `git lfs install` to fetch the ONNX model.

---

## 6. Cadence and follow-ups

| When | Action |
|---|---|
| Tue 09:00 local | X thread. Pin the repo reply. Reply to every substantive comment in the first hour. |
| Wed 08:30 local | LinkedIn post. Add the first comment immediately. |
| Day 3 | Short follow-up: “3 things I'd change if I rebuilt it” — carousel of 3 screenshots. |
| Day 7 | Small update post only if there's real signal: stars, issues, a fix, a doc improvement. |

One post is a launch. Three posts over a week look like an engineer who finishes things.

---

## 7. Measurement

Track outcomes, not vanity:

- LinkedIn: impressions, **profile views**, comments from engineers/recruiters.
- X: impressions, link clicks, bookmarks.
- GitHub: **Insights → Traffic** (referring sites, views, clones), stars, forks, issues.
- Best single signal: a recruiter or engineer referencing a specific detail from the post, not “great project”.

---

## 8. Accuracy guardrails

- Say “targets macOS / Windows / Linux”, not “released on all platforms” — no releases exist yet.
- Don't say “production-ready” or “used by customers”.
- Keep the API-key-in-WebView tradeoff visible; it's already documented and honesty reads better than hiding it.
- Coverage numbers change — quote the badge values at posting time, not fixed numbers if the workflow has run again.

---

## 9. Two things to confirm

1. Are you targeting **full-stack**, **frontend**, or **Rust/systems** roles? Retune the headline and the “I owned…” sentence accordingly.
2. Do you want a **demo video** in the plan? If yes, script the exact 30-second capture sequence.

---

## 10. Post drafting notes

- LinkedIn version is ~300 words: long enough to signal depth, short enough to finish.
- X thread uses one idea per tweet, with a concrete artifact attached to the technical tweets.
- Both versions end with a specific question — that converts readers into commenters.
- Hashtags: `#TypeScript #Rust #Tauri #OpenSource #SoftwareEngineering` on LinkedIn; no hashtags on X except inside the thread body where natural.

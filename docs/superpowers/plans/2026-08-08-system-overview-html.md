# Offline System Overview HTML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a detailed, offline Bootstrap HTML document explaining the complete Pump.fun-to-PumpSwap listener from product, architecture, data, safety, operations, and testing perspectives.

**Architecture:** A single static HTML5 page references a vendored Bootstrap 5.3.8 stylesheet and embeds accessible SVG diagrams. It contains no application code, network request, runtime data access, or JavaScript dependency.

**Tech Stack:** HTML5, Bootstrap 5.3.8 CSS, inline SVG, local print/custom CSS, Node.js verification scripts.

---

### Task 1: Vendor Bootstrap locally

**Files:**
- Create: `docs/assets/vendor/bootstrap/bootstrap.min.css`
- Create: `docs/assets/vendor/bootstrap/LICENSE`

- [ ] **Step 1: Fetch the pinned official package**

Run `npm pack bootstrap@5.3.8 --pack-destination <temporary-directory>` and extract the official `dist/css/bootstrap.min.css` and `LICENSE` files.

- [ ] **Step 2: Copy only the required distribution files**

Copy the stylesheet and licence into `docs/assets/vendor/bootstrap/`. Do not add Bootstrap to application dependencies or commit the package archive.

- [ ] **Step 3: Verify provenance and network independence**

Run `rg -n "https?://|@import" docs/assets/vendor/bootstrap/bootstrap.min.css`. Expected: no runtime import or external asset URL.

### Task 2: Build the detailed HTML document

**Files:**
- Create: `docs/system-overview.html`

- [ ] **Step 1: Create the semantic shell**

Add the local Bootstrap stylesheet, accessible skip link, sticky table of contents, responsive content container, status badges, footer, and print rules.

- [ ] **Step 2: Document all system perspectives**

Cover the sixteen sections from the approved design. Derive assertions from the merged architecture, source, migrations, API contracts, and integration tests. Mark capabilities as active, partial, isolated, or future.

- [ ] **Step 3: Add seven accessible inline SVG diagrams**

Include product flow, layered architecture, ingestion sequence, finality lifecycle, persistence model, crash recovery sequence, and safety boundary. Every SVG must contain a unique `id`, `role="img"`, `<title>`, and `<desc>`.

- [ ] **Step 4: Add stable cross-references**

Link to `README.md`, `docs/architecture/pumpfun-v1.md`, `docs/api/v1.md`, the J1 design, migrations, and key source directories using repository-relative paths.

### Task 3: Verify content and rendering

**Files:**
- Create: `scripts/check-system-overview.ts`
- Modify: `package.json`

- [ ] **Step 1: Add deterministic static validation**

The script must verify doctype, language, local Bootstrap reference, absence of HTTP(S) resources and scripts, unique section/SVG IDs, valid internal anchors, seven SVG titles/descriptions, required safety statements, and presence of all sixteen documented areas. It exits non-zero with explicit messages.

- [ ] **Step 2: Add the documentation check command**

Add `docs:check` to `package.json` and run `npm run docs:check`. Expected: exit 0 with a concise validation summary.

- [ ] **Step 3: Inspect desktop and mobile rendering**

Open `docs/system-overview.html` locally in the in-app browser. Inspect at desktop and mobile widths, verify navigation, tables, overflow, SVG readability, contrast, and absence of failed network resources.

- [ ] **Step 4: Run repository checks**

Run `npm run build`, `npm run check`, `npm run lint`, `npm run docs:check`, and `git diff --check`. All commands must exit 0.

### Task 4: Commit and publish directly to main

**Files:**
- Commit all files created or modified by Tasks 1–3 and the approved design/plan documents.

- [ ] **Step 1: Review the final diff**

Run `git status --short`, `git diff --stat origin/main...HEAD`, and a safety scan for external resources, signers, private keys, or live transaction claims.

- [ ] **Step 2: Commit the implementation**

Commit with message `docs: add offline system architecture overview`.

- [ ] **Step 3: Verify the committed state**

Run `git diff --check origin/main...HEAD`, `git status --short`, and `git log -2 --oneline`. Expected: clean worktree and two documentation commits ahead of `origin/main`.

- [ ] **Step 4: Push main**

Run `git push origin main`, then verify `git rev-list --left-right --count origin/main...main` returns `0 0`.

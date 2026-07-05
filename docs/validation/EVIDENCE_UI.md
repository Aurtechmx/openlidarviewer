# Evidence UI/UX principles

Governs every UI element added by the research-hardening phases — the evidence
badges (Phase 17), the confidence relabelling and NVA/VVA/QL wording (Phase 2),
and the evidence sections in reports. Applies Gestalt organisation and design
excellence **on top of the app's existing design system**, not a new look.

## Rule 0 — Extend the existing system, don't reinvent it

OpenLiDARViewer already makes deliberate design choices: a tinted-dark theme
(not `#000`), Manrope / Inter display + JetBrains Mono for numerics, a restrained
palette driven by CSS tokens (`--accent`, `--hairline`, `--text`, `--text-dim`,
`--text-faint`, the `--space-*` scale), and an established chip pattern
(`.olv-prov-confidence`). Design excellence here = **reuse those tokens and the
chip pattern** so evidence UI feels native. No new fonts, no gradients, no
decorative colour, no alarm-red. The data is the figure; evidence is a quiet
qualifier.

## The evidence badge

One compact, uppercase chip — the same component everywhere — from the fixed
vocabulary in `evidenceLevel.ts`: **Not assessed · Analytic · Synthetic ·
Cross-implementation · External · Independently reproduced** (+ **Exploratory**
for a below-required export).

- **Similarity (learn it once).** Identical shape, size, and typography for every
  badge, matching `.olv-prov-confidence` (text-2xs, uppercase, letter-spacing,
  0.5px hairline border, `--radius-xs`). A user learns the vocabulary once and
  reads it anywhere.
- **Proximity + continuity.** The badge sits immediately beside the value/claim
  it qualifies, baseline-aligned — never floating in a corner. One badge per
  output.
- **Figure / ground.** Strength maps to contrast, quietly:
  `External` / `Independently reproduced` may use `--accent`; `Analytic` /
  `Synthetic` use `--text-dim` on a hairline; `Exploratory` / `Not assessed`
  recede to `--text-faint`. An unvalidated badge must never be louder than the
  measurement it sits next to.
- **Restraint.** No icon-as-decoration. The chip is the signal.

## The confidence split (Phase 2) — encode the distinction visually

The two confidence concepts must never look the same (Gestalt similarity: same
look ⇒ same meaning):

- **Measured-cell empirical reliability** — solid accent-hairline chip, shows the
  event + tolerance inline: `82% · |Δz| ≤ 0.10 m`. Numerics in JetBrains Mono.
- **Model-based support (interpolated)** — a visually distinct **dashed** /
  muted chip: `46% · model-based, not calibrated`. Different treatment so it is
  never mistaken for calibrated probability.

Both live in the same card (common region) but read as two different things.

## Common region, revealed on demand

Evidence detail — what was / wasn't validated, tolerance, dataset/domain, method
version, assumptions, link to evidence — belongs **inside the existing card**
(Provenance / the product's section), revealed on hover / activation, not printed
always-on. This keeps the dense left rail uncluttered (the same discipline as the
object/E57 declutter) while the depth stays one interaction away. Enclose it in
the card's region; don't scatter it.

## Export controls follow the gate, visibly

`exportDecision(...)` drives the affordance:

- **Validated** → the normal export button.
- **Below-required (exploratory-only)** → the button is clearly qualified
  ("Export exploratory…") and the artifact is watermarked with its refusal
  reason. Distinct from a validated export by wording + a muted treatment — never
  a look-alike that implies validation.
- **Export-disabled** → not offered.

Destructive/irreversible or overstatement-risk actions are visually distinct from
constructive ones (Gestalt similarity of intent).

## Reports (PDF) evidence surfaces

Follow the existing report template: left-aligned headings, horizontal rules as
dividers (no full-cell table borders), generous margins, one accent. Add:

- a small evidence tag beside each product heading (same vocabulary), and
- one **"Evidence & limitations"** table: `product · evidence level · approved
  claim · prohibited claim`, horizontal-rule rows only.

The prohibited-claim column is the honesty guardrail rendered for the reader.

## Review checklist (every phase's UI must pass)

- [ ] Reuses existing tokens + the chip pattern; no new fonts/gradients/alarm colour.
- [ ] One badge per output, adjacent + baseline-aligned to its value (proximity, continuity).
- [ ] Badge vocabulary is uniform everywhere (similarity); a user learns it once.
- [ ] Unvalidated/exploratory badges recede; validated may use accent (figure/ground) — never louder than the data.
- [ ] Measured vs model-based confidence are visually distinct (never conflated).
- [ ] Evidence detail is in-card, on-demand — not always-on clutter.
- [ ] Export affordance matches the evidence gate; exploratory is unmistakably qualified.
- [ ] Numerics in JetBrains Mono; tolerance/event stated inline with any reliability figure.

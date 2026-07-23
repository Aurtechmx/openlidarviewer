# Stability policy

What "stable" means for OpenLiDARViewer v0.6.0 and later: which surfaces are
frozen, what a freeze promises, and how anything frozen may change. A stable
version number is a contract about these surfaces, not a quality adjective.

## Frozen at stable

**Session format.** A session saved by any v0.6.x opens in every later v0.6.x
with the same geometry, measurements, annotations, and view. Additive fields
are allowed; nothing recorded is reinterpreted. The recorded origin is the
source origin, which cannot move.

**Measurement semantics.** What a distance, area, volume, profile, or
elevation MEANS — its frame, its datum rules, its refusal conditions — does
not change within v0.6.x. A measurement that was refused for an unproven
frame is not quietly allowed later.

**Export formats.** The written shape of every export (XYZ/CSV/PLY/OBJ
columns and comment conventions, GeoJSON dual-frame contract, LAS/LAZ
encoding rules, report fields) is frozen. Disclosure lines may be added;
existing fields keep their meaning.

**File-format support.** Every format the sniffer routes at v0.6.0 stays
supported through v0.6.x.

**Scientific claims.** Claims change only through versioned evidence: a new
entry in the claim register with its fixture and tolerance, reflected in
CLAIMS_AND_LIMITATIONS.md, in a commit. A release note may never move a
claim on its own.

## Not frozen

Internals (module boundaries, the decomposition work), rendering performance
characteristics, the streaming scheduler's tuning, UI layout, and anything
explicitly marked experimental in KNOWN_LIMITATIONS. Multi-layer mounting
remains disabled and is not part of the stable contract until it ships with
its own browser-verified evidence.

## How frozen things change

By a new minor or major version, with the change stated in the release notes
and, for claims, in the evidence record. A defect in a frozen surface is
fixed as a defect — the fix restores the documented meaning rather than
defining a new one, and the release notes say what was wrong.

## The enforcement

This policy is checked, not trusted: `lint:release-sync` holds version
metadata together, `lint:evidence` holds published figures to machine
records, `lint:claim-register` holds claims to the register,
`lint:claims-language` holds documents to the vocabulary policy, and the
release gate refuses a tag whose tree, evidence, and documents disagree.

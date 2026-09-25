# Stability policy

What "stable" means for OpenLiDARViewer v0.6.0 and later: which surfaces are
frozen, what a freeze promises, and how anything frozen may change. A stable
version number is a contract about these surfaces, not a quality adjective.

## Frozen at stable

Session format. A session saved by any v0.6.x opens in every later v0.6.x
with the same geometry, measurements, annotations, and view. Additive fields
are allowed; nothing recorded is reinterpreted. The recorded origin is the
source origin, which cannot move.

Measurement semantics. What a distance, area, volume, profile, or
elevation MEANS (its frame, its datum rules, its refusal conditions) does
not change within v0.6.x. A measurement that was refused for an unproven
frame is not quietly allowed later.

Export formats. The written shape of every export (XYZ/CSV/PLY/OBJ
columns and comment conventions, GeoJSON dual-frame contract, LAS/LAZ
encoding rules, report fields) is frozen. Disclosure lines may be added;
existing fields keep their meaning.

File-format support. Every format the sniffer routes at v0.6.0 stays
supported through v0.6.x.

Scientific claims. Claims change only through versioned evidence: a new
entry in the claim register with its fixture and tolerance, reflected in
CLAIMS_AND_LIMITATIONS.md, in a commit. A release note may never move a
claim on its own.

## Not frozen

Internals (module boundaries, the decomposition work), rendering performance
characteristics, the streaming scheduler's tuning, UI layout, and anything
explicitly marked experimental in KNOWN_LIMITATIONS. Multi-layer mounting
shipped enabled in v0.6.5; its placement precision refuses a mismatch past a
1 mm Float32 budget, and its tuning and interaction surface are not yet frozen.

## How frozen things change

By a new minor or major version, with the change stated in the release notes
and, for claims, in the evidence record. A defect in a frozen surface is
fixed as a defect: the fix restores the documented meaning rather than
defining a new one, and the release notes say what was wrong.

## Capability status from v0.7

From v0.7 every user-facing capability carries one of three statuses in
`docs/validation/capability-manifest.json`. The status is what a user may rely
on; it says nothing about quality beyond that.

Stable. The capability is reachable in the shipped build and falls under the
freezes above. Its behaviour, its inputs and outputs, and the claims it cites
in the claim register change only by a new minor or major version, with the
change stated in the release notes. A stable capability is removed only after
one minor version in which it is marked for removal. The exception is a
stable capability found to produce incorrect results or to be a security risk:
it is withdrawn in the next release, and the withdrawal and its reason are
recorded in the release notes and the erratum.

Preview. The capability is reachable in the shipped build and carries a label
in the interface, such as Field Simulation Lab. It may change or be withdrawn
in any minor version without a deprecation period. Its outputs keep the same
honesty rules as stable ones: a refusal stays a refusal, and a preview figure
is never presented as a measurement. Nothing in a session or export format may
depend on a preview capability staying as it is.

Hidden. The code is in the source tree and is not offered to users. It makes
no promise of any kind. A module listed in
`docs/validation/unreachable-modules.json` is always hidden, and a public
document may name a hidden capability only to say it is not available.

A capability moves from hidden to preview, or from preview to stable, in a
commit that changes the manifest together with the code that reaches it.
`lint:capability-manifest` fails when a stable or preview capability rests on
an unreachable module, when a listed module does not exist, when a cited claim
is not in the claim register, or when README.md or a document in `docs/`
describes a hidden capability as available.

## The enforcement

This policy is checked, not trusted: `lint:release-sync` holds version
metadata together, `lint:evidence` holds published figures to machine
records, `lint:claim-register` holds claims to the register,
`lint:capability-manifest` holds capability statuses to the source tree,
`lint:claims-language` holds documents to the vocabulary policy, and the
release gate refuses a tag whose tree, evidence, and documents disagree.

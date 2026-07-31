# Generalization register

**Nothing in this register is evidence.** It holds inferences, not measurements:
one record per step from what a study measured to what somebody believes because
of it. No record here moves an evidence level, and no record here is a result.

Today the register asserts no generalisation at all. It holds one refusal and
one example.

## What is here

| File | What it is |
| --- | --- |
| `generalization-record.schema.json` | What a generalisation record must state |
| `records/SLOPE-HORN-BEYOND-ANALYTIC-DEM.generalization.json` | A reach this project refuses to make, written down as a record |
| `records/EXAMPLE-*.generalization.json` | One example, counted nowhere |
| `../../scripts/verify-generalization-record.mjs` | The verifier, exit 1 on a bad record or an empty register |
| `../../tests/generalizationRecord.test.ts` | Proof each refusal fires for its own reason |

## Why a register

Every study in this repository ran on specific data under specific parameters.
The slope agreement with GDAL was measured on one analytic DEM; the ground-filter
comparison ran on five synthetic scenes; the benchmark numbers came off one
machine. A reader who has read any of them arrives at the same question: does
this hold anywhere else?

That question gets answered somewhere. Until now it was answered in prose, or in
a reader's head, and either way the answer left no trace. Nothing in the tree
marked where the measurement stopped and the extrapolation started. A record here
makes the step visible: which study it starts from, which single axis it travels
along, how far, on what basis, and where it stops.

## What a record has to state

The study or claim it reasons **from**, by an id that resolves in the register
its kind names. What that study actually measured, in the study's own terms. One
axis of extrapolation (terrain type, sensor, density, CRS, scale), with the
range the study covered and the range this record reaches to. The sentence being
asserted, written so a reader can disagree with it. The basis. And a boundary
that may not be empty.

One axis per record, on purpose. A reach that stretches terrain and sensor and
density at once hides which of the three it is weakest on, and each has to be
argued on its own anyway.

## The basis vocabulary

Five bases, in three families that prose blurs together:

| Basis | What it is |
| --- | --- |
| `measured-second-dataset` | Re-measured on an independent dataset that differs along this axis |
| `measured-parameter-sweep` | Re-measured across the axis inside one study |
| `mechanism` | Argued from the algorithm or the mathematics; nothing new was measured |
| `analogy` | Argued from resemblance to another product or another system |
| `assumed` | Nothing supports it, and the record exists to say so |

The last three are representable deliberately. An inference resting on nothing
still has to be writable, or it goes back to being made silently; what the
verifier enforces is that it is never read as the first two. Only a measured
basis can reach status `supported`, an assumption may not even reach `argued`,
and a record at `supported` has to name the second measurement: a study id that
is not the source's own, and datasets that exist in
`validation/datasets/dataset-register.yaml`.

## What the verifier refuses

A source id that resolves nowhere. A generalisation is always a generalisation
*of* something, and a reach from a study that does not exist reads exactly like a
reach from one that does.

An unsupported basis sitting at a status that asserts the reach holds. This is
the rule the container is for.

Also: a real record reasoning from an `EXAMPLE-` study, which measured nothing; a
second measurement that turns out to be the first study; an `extrapolatedTo` that
repeats `measuredRange`, so nothing is being extrapolated; a `supported` record
reaching to "any sensor" or "all terrain", because no measurement covers an
unbounded set; an empty boundary; the same reach filed twice at two statuses.

**And an empty register.** A verifier that passes over zero records certifies
nothing while looking exactly like one that certified something. If every record
here were deleted, or if one stopped parsing, this check goes red rather than
green. The emptiness has to be a decision somebody writes down, not a state the
tooling reports as success.

## What it cannot do

It cannot tell a sound inference from an unsound one. Nothing reads the argument
in `basis.statement`, and a well-formed record whose mechanism is nonsense
passes. What it guarantees is that the step is on the page and attributable,
which is the part prose was losing.

## The register refuses as well as asserts

`SLOPE-HORN-BEYOND-ANALYTIC-DEM` is a `refused` record: the reach from one
analytic fixture to terrain in general, which this project does not make and
which its claim register already prohibits in words. It is here so the refusal is
an entry a check can read, and so that a future edit which starts making the
inference has to delete a refusal rather than quietly add a sentence.

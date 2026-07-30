# Independent reproductions (E6)

**This container is empty. Nobody outside this project has reproduced anything.**

`records/` holds one record, `EXAMPLE-INDEPENDENT-RERUN.reproduction.json`,
prefixed `EXAMPLE-` and marked `example: true`. It is a filled-in template.

## What is here

| File | What it is |
| --- | --- |
| `reproduction-record.schema.json` | What a reproduction record must state |
| `records/EXAMPLE-*.reproduction.json` | One example, counted nowhere |
| `../../scripts/verify-reproduction-record.mjs` | The verifier, exit 1 on a bad record |
| `../../tests/reproductionRecord.test.ts` | Proof each refusal fires for its own reason |

## What a record has to state

Who ran it, with a persistent identifier that resolves (an ORCID, a ROR, or an
equivalent), their affiliation, a signed statement about their relationship to
this project, exactly which release and revision they ran, the commands, the
hardware and runtime, what they got, and where their raw output lives under
their own control.

## What the verifier refuses

A reproduction performed by this project is not a reproduction. The verifier
refuses a record whose reproducer is affiliated with the project, funded by it,
a contributor to it, or an organisation carrying its name — and refuses one whose
raw output is published only by us, because then the third party's evidence is
our copy of it.

It also refuses a malformed identifier (an ORCID is checked against its MOD 11-2
check digit), an unpinned artifact, a private or unreachable download or output
location, an outcome asserted with no raw output, and a status of `reproduced`
sitting next to a list of deviations.

It does not fetch anything. A well-formed ORCID is a syntactic check, not a
verified human, and the verifier says so rather than implying otherwise.

## Why it stays empty until it is not

E6 is the one level in `src/validation/evidenceLevel.ts` that this project
structurally cannot award itself. Running the suite again here, on another
machine, under another operating system, is still not a reproduction. The value
of the ladder is that its top rung is visibly unoccupied.

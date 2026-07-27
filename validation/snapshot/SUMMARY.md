# Validation snapshot

Candidate version 0.6.2. Verdict PASS.

Nothing below is written by hand.

Every figure comes from the records stored under `evidence/`, computed by `scripts/validation-snapshot-lib.mjs` and recomputed from the same bytes each time the snapshot is checked. An input that was not produced is recorded as not executed, with the command that produces it. It is never a zero and never a pass.

## Defect composition

Registry version 0.6.2. The figures on the left are counted over the records themselves, one record at a time. The figures beside them are the ones `CHANGELOG.md` states in prose for this version, read back out of that text. Neither column is copied from the other, so a record set and the sentence that describes it cannot drift apart without one of these rows disagreeing, and a row that disagrees fails the snapshot rather than being reconciled by editing the records.

| figure | derived | stated | agrees |
| --- | --- | --- | --- |
| total | 18 | 18 | yes |
| exposedBySpecializedValidation | 12 | 12 | yes |
| byCodeReview | 6 | 6 | yes |
| carriedFromTheEarlierAudit | 5 | 5 | yes |
| affectingReleasedStatementsOrOutputs | 4 | 4 | yes |

Reconciles: yes.

| severity | records |
| --- | --- |
| high | 9 |
| medium | 7 |
| low | 2 |

| discovery method | records |
| --- | --- |
| validation suite | 12 |
| code review | 6 |

| detecting mechanism | records |
| --- | --- |
| none | 6 |
| suite-5-provenance-integrity | 4 |
| suite-2-unit-integrity | 2 |
| suite-4-failure-recovery | 2 |
| suite-6-contour-correctness | 2 |
| suite-7-las-round-trip | 1 |
| suite-8-archive-portability | 1 |

## Identity

Agreement: agrees.

| field | source | value | status | note |
| --- | --- | --- | --- | --- |
| candidateVersion | `CHANGELOG.md` | 0.6.2 | agrees |  |
| packageVersion | `package.json` | 0.6.2 | agrees |  |
| lockfileVersion | `package-lock.json` | 0.6.2 | agrees |  |
| lockfileSelfVersion | `package-lock.json` | 0.6.2 | agrees |  |
| claimRegisterVersion | `docs/validation/claim-register.yaml` | 0.6.2 | agrees |  |
| citationVersion | `CITATION.cff` | 0.6.2 | agrees |  |
| readmeVersion | `README.md` | 0.6.2 | agrees |  |
| erratumVersion | `docs/release/` | 0.6.2 | agrees |  |
| limitationsVersion | `KNOWN_LIMITATIONS_v<version>.md` | 0.6.2 | agrees |  |
| buildIdentityVersion | `release/package-build-metadata-v0.6.2.json` | 0.6.2 | agrees |  |
| archiveName | `release/package-build-metadata-v0.6.2.json` | openlidarviewer-v0.6.2-source-20260727-1713.zip | agrees |  |

Release date: the citation states 2026-07-27 for version 0.6.2, the changelog entry for that version states 2026-07-27 (agrees). The candidate entry is dated 2026-07-27.

## Inputs

11 of 15 collected, 4 not executed, over 38 records.

| input | status | records | produced by |
| --- | --- | --- | --- |
| Defect records | recorded | 5 | `node scripts/build-defect-summary.mjs` |
| Replay results | not-executed | 0 | `node validation/replay/run-replay.mjs` |
| Reachability ledger | recorded | 2 | `npm run verify:reachability` |
| Mutation results | recorded | 2 | `node validation/mutations/run-campaign.mjs` |
| Cross-platform comparison | recorded | 6 | `npm run benchmark:compare-platforms` |
| GDAL cross-checks | not-executed | 9 | `npx vitest run tests/slopeCrossCheck.test.ts tests/aspectCrossCheck.test.ts tests/hillshadeCrossCheck.test.ts` |
| Seed sensitivity | recorded | 2 | `npm run benchmark:seeds` |
| Clean clone | not-executed | 0 | `npm run benchmark:clean-clone` |
| Archive portability | recorded | 1 | `npm run benchmark:archive-portability` |
| Claims | recorded | 1 | `npm run gen:claim-registry` |
| Known limitations | recorded | 2 | `written by hand for each version; no generator produces it` |
| Environment | recorded | 1 | `npm run benchmark:repro` |
| Release-gate result | not-executed | 0 | `npm run evidence` |
| Build identity and archive name | recorded | 1 | `npm run package` |
| Identity sources | recorded | 6 | `tracked in the repository; no generator produces it` |

## Not executed

Each of these is absent. Absent is not empty, and it is not passing. The command beside it is what produces the record, and until that runs there is nothing here to report.

- Replay results: `validation/replay/results.json` is absent. Run `node validation/replay/run-replay.mjs`.
- GDAL cross-checks: `benchmark-results/crosschecks/results.json` is absent. Run `npx vitest run tests/slopeCrossCheck.test.ts tests/aspectCrossCheck.test.ts tests/hillshadeCrossCheck.test.ts`.
- Clean clone: `release/clean-clone.json` is absent. Run `npm run benchmark:clean-clone`.
- Release-gate result: `release/test-evidence-v0.6.2.json` is absent. Run `npm run evidence`.

## Records

| record | bytes | sha256 |
| --- | --- | --- |
| `validation/defects/defect-registry.json` | 49357 | `410f98910f7ebafcf2e91da4a41e6335b109cb677b921a5da4ed40dae3cf49c0` |
| `validation/defects/defect-registry.schema.json` | 7067 | `86465b9d9dfd7fc69e371b793ca54f06cc7617cc821f0219c8f9ac466725ec38` |
| `validation/defects/defect-summary.csv` | 10090 | `e7f26da9b99376e61eeff12ed04b7fd69923cdd397b8f71a3c74da5b679654e7` |
| `validation/defects/defect-summary.json` | 13412 | `8ff7301a90a8ab47119127e7fb92413d5c929e876db63045376ed09d1b9a12f7` |
| `validation/defects/defect-summary.md` | 11925 | `6fbe8fe8cf65d3ac42c49b849de3d0223350cb428b9a34718298be4f36cf8a0b` |
| `validation/reachability/claims.json` | 7909 | `f017292ff231ac3f0dc32f544ef4480c0e16e3f07dbe57dfc9d137e7c5c2f700` |
| `validation/reachability/summary.json` | 3991 | `87404a21dcc214a88c5a821a967162e0004d132eaee0f7702af9a5a9e196f2c1` |
| `validation/mutations/results.json` | 26824 | `f5dab035cca274587c7512f2cf7a7e9a3ea3f636408683d2ee94aa565334fa1a` |
| `validation/mutations/summary.md` | 5083 | `5b0d88056368333ca9bc0160846ec3eb1b18088c7f35f0624ddbb5d032752b58` |
| `docs/validation/evidence/portability-v0.6.2/PROVENANCE.md` | 914 | `e18623dbb6b5e1039ad4de9be900b48d12908c6b66588367ca34800bbaa14e2c` |
| `docs/validation/evidence/portability-v0.6.2/comparison.csv` | 3211 | `64e1e00511d701e422388a886e5fb5f1eeb9c504b936274b170ea7b04a30cea1` |
| `docs/validation/evidence/portability-v0.6.2/comparison.json` | 5216 | `2b2a9e14d9f9bf80a8fb54bdf681b8f1a879162ea9c1440c0e472263578af06e` |
| `docs/validation/evidence/portability-v0.6.2/environments.json` | 5886 | `94bf13bebefb05dbde0e5b6e9539142db2ab1ebe1b787d2855005f80480a8aae` |
| `docs/validation/evidence/portability-v0.6.2/manifest.json` | 2308 | `a72ea53de4645c5c444008828e2584e53858e7117f7f39150d71fb6523bde1ed` |
| `docs/validation/evidence/portability-v0.6.2/summary.md` | 4357 | `0007fb4b8b83576f5835962934d967bd0d0e77fed5691c67446f59d6e6253c56` |
| `tests/fixtures/reference/aspect/SHA256SUMS` | 332 | `80f3f47e551a09434b2c21bfd3930df2ddc07e5b02fe3dc119499c25892dbee4` |
| `tests/fixtures/reference/aspect/command.txt` | 76 | `05f71ae8d5f0413223d5faaf7723a3684d7b7544642510c4a04e27011f81244e` |
| `tests/fixtures/reference/aspect/environment.json` | 409 | `27beb33c17a1ccc2febf0c3faa141398c76ce62fe2df60e6163c4b9e3cb29091` |
| `tests/fixtures/reference/hillshade/SHA256SUMS` | 335 | `869afb63b716a6b821728d536caf3b345485618dfd27f1f18d77670b00a2b059` |
| `tests/fixtures/reference/hillshade/command.txt` | 108 | `92792cd200ddfb33cda9b2c9b236731bee25d03e488fae19481da2c582d9ea77` |
| `tests/fixtures/reference/hillshade/environment.json` | 530 | `ddc8e31664711f4c6dbbfdf2e1aabf6ce2762de10795ee0ea3d870193d05b8a4` |
| `tests/fixtures/reference/slope/SHA256SUMS` | 322 | `d2dd1099a0b6f1462bf07c014a853799a6bf10d15be4aa5995d88f2680052d34` |
| `tests/fixtures/reference/slope/command.txt` | 127 | `788d1425d95e2ff2285d6b116afdd820e530d3b63527e5dd5d257808a51d957d` |
| `tests/fixtures/reference/slope/environment.json` | 265 | `3ab30b84c9b806b58ea47317275edd9cb173d964307d09d12aff2f15abc72c81` |
| `benchmark-results/seeds/summary.md` | 4469 | `9692f4003df4eab1533994135931c967187f87fff28c9ccf7ac2f9b8b46c3e02` |
| `benchmark-results/seeds/sweep.json` | 22150 | `7be6abdce66c29d811d231b75ff222c71c19a8a697e5e2eded7b6efe7d9bea4a` |
| `release/archive-portability.json` | 47084 | `b245861800fc3d34e32061d409761664e72dbb47fd220e60ba34e5368c82f890` |
| `docs/validation/claim-register.yaml` | 34358 | `291832a2a4e52c66bd62d12bd9d69118155d73684fb74ee4e944b33bb0c7de7f` |
| `KNOWN_LIMITATIONS_v0.6.2.md` | 22644 | `2fdb2465ef39f8f4d4f8d49964f1399098a188e61af194b7b2ad306b756fa977` |
| `docs/release/ERRATUM_v0.6.2.md` | 7733 | `71427ba2b46294a52b98a288e01bd3c01bc0eba46681a09d2919445d6769c865` |
| `benchmark-results/latest/environment.json` | 917 | `dc5fbd2f51baa68da61940fedee09f1b7aae43718093cf04953898164ee5e64d` |
| `release/package-build-metadata-v0.6.2.json` | 642 | `1e5cf5ab5676b1356793f47d4f13f59d8747860a8a1af95321c03ccb5ce464ed` |
| `CHANGELOG.md` | 241773 | `2be3e15c56f2ba0b55a69bec9a141fb2335c1c422b2d35657b522a7dcb2095f1` |
| `CITATION.cff` | 1066 | `8a9ac9a95aec3e7ec85a03a0699c9ad137f13efe9f56786306ab1a4be740fe30` |
| `MANIFEST.md` | 2400 | `7c77107708d237b65dc079455d40bbb97e42ca3c291fbdd8bb62990f76f3e7b7` |
| `README.md` | 39258 | `f3215561a2e0bbeb813ada6aa80cff28b8a70007a8cd71b47ec28ed25088315f` |
| `package-lock.json` | 308235 | `5ffe4663958b6763e3a546ded33b6ec3230144ec73f8523a6aedb720fa7d1825` |
| `package.json` | 8997 | `9e19a11a01cc8ddebb34e9ced932daeea1f70cd1b70d651171ac80205e13e548` |

## Scope

This snapshot states what was collected and what was not.

It does not state that the collected records cover the software. It says nothing about agreement with field measurement. Each record carries its own scope, written by whoever produced it, and that is where the limits of the record are stated.

Read them there.

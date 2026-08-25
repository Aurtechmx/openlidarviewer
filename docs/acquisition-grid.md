# Acquisition grid

A scanner does not measure a cloud of points. It sweeps a grid: for each row and
column it fires along a direction and records what came back, or records that
nothing did. Flattening that into a list of coordinates throws away the row, the
column, and every cell the instrument interrogated without result.

OpenLiDARViewer keeps the grid alongside the cloud, and says plainly when the
connection between the two has been broken.

## What is preserved

For PTX, organized PCD and structured E57, a loaded scan carries one frame per
scanner setup. Each frame holds:

- the grid shape, as the source declared it and as the records back it up
- a state for every cell
- the geometric range of each valid return, in the scanner's own coordinates
- the acquisition pose of that setup
- the display record each cell produced, where that can be proven

A block or scan is its own setup. Two setups that looked at different directions
keep separate grids and separate poses, because merging them would produce a
raster that means nothing.

## Cell states

| State | What the source said |
|---|---|
| Valid return | A usable return for this cell |
| No return | The scanner interrogated this direction and received nothing |
| Source invalid | A record exists and the source declares it unusable |
| Not decoded | A record exists and this session did not deliver it |
| Source record missing | The grid declares this cell and the file supplied no record |

These are five states rather than one empty value because they carry different
weight. A no return is evidence about the scene: the instrument looked and
nothing came back. A not-decoded cell says nothing about the scene at all, only
about how much of the file this session read. Reporting the second as the first
would let a sampling decision read as a property of the surface.

PTX writes `0 0 0` for a cell with no return, and that is the only format here
with an explicit no-return marker. A PCD record that is not finite is invalid,
not a no return, because nothing in PCD says the sensor looked and found
nothing.

## Range

Geometric range is the distance from the setup to the return, computed in the
scanner's own coordinates before registration and before the viewer recentres
anything. Taking it afterwards would subtract two large world coordinates and
lose most of the precision to cancellation, and it would make the value depend
on the registration being right.

Where E57 declares a spherical range, that is kept separately as the source
range. The two are different quantities and neither is called a measured range,
because the file records a number and the viewer does not know how it was
obtained.

A cell with no return has no range. It does not have a range of zero.

## Linkage

A grid cell links to a displayed point because the loader recorded which point
that cell produced. Never because a coordinate happened to be nearby.

Three states describe how much of that survives:

- **Exact.** Every valid cell names the record it produced.
- **Partial.** Some records were not decoded this session. The ones that were
  still link exactly.
- **Unavailable.** The identity is gone, and the reason says which step spent
  it: voxel centroids, a source topology that could not be read as a grid, or an
  identity that was never established.

Reduction destroys linkage and leaves the grid intact. A cloud reduced to voxel
centroids still has its grid, its cell states and its ranges, all still true of
the source, and the workbench still opens. What it cannot do is name the return
behind a centroid, because a centroid is not a return. It says so rather than
offering the nearest point.

Where a scan is opened and then exported, the step that spent the identity is
recorded in the processing manifest, so a reviewer holding only the export can
see it without the session that produced it.

## The range frame workbench

A launcher appears in the Analyse panel when the loaded scan carries a grid. The
workbench shows the grid in two modes, range and validity, alongside the counts,
the range statistics and a per-band coverage report. It loads only when opened,
so a session that never touches structured data pays almost nothing for it.

Clicking a cell highlights the display point it produced. Inspecting a display
point highlights the cell it came from. Where a cell cannot name a point, the
workbench says which of the three linkage states applies and why.

Coverage is reported per band across each axis rather than as one number,
because sampling selects records in file order while the grid is
two-dimensional, so the decoded fraction is rarely uniform across it. A band
report shows where the display under-represents the source.

## What this does not establish

The grid is a record of what the instrument addressed. It is not a measurement
of the scene.

A no return can be dark asphalt, glass, water, or a distance past the
instrument. Nothing here names a cause, and nothing built on it may name one.

Agreement between a source-declared range and a range recomputed from the same
file's coordinates is a decode check. It says the two columns were read
consistently. It says nothing about how accurately the instrument ranged.

Identity is bookkeeping. That a cell names the record it produced is a fact
about this decoder rather than about the world, and no external tool holds those
indices to check them against. It is tested against fixtures whose answer is
known by construction, and that is as far as it can go.

## Formats

| Format | Grid | Pose | Identity |
|---|---|---|---|
| PTX | Per block | Per block, world and scanner-local kept apart | Exact |
| PCD, ascii and 8-byte float binary | From `WIDTH` and `HEIGHT`, validated against the records | Viewpoint | Exact |
| PCD, `binary_compressed` and 4-byte float binary | Same | Viewpoint | Not claimed |
| E57 | From `indexBounds`, validated against decoded indices | Per scan | Exact where the records survive decoding |

PCD identity is refused for two of its encodings because the record order there
comes from a reader this project does not control or test record for record. The
grid, the states and the pose are still preserved; only the link to a display
point is withheld.

A declared grid is a claim. Where the records contradict it, no grid is
recorded and the load reports why, rather than building a correspondence the
file does not support.

## Registered claims

`ORG-TOPOLOGY-IDENTITY`, `ORG-RANGE-GEOMETRIC`, `ORG-PTX-SETUP-TOPOLOGY` and
`ORG-PCD-ORGANIZATION` in `docs/validation/claim-register.yaml` carry what each
of these is graded at, and what each may not be used to say.

Two of them are capped permanently. Identity cannot be checked by a second
implementation, because no external tool holds this decoder's record indices.
Geometric range is a three-term hypotenuse, where a second implementation is a
second copy of a closed form. Both ceilings are recorded rather than left open,
because neither is waiting on evidence that might arrive.

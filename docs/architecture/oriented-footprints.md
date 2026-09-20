# Oriented point footprints

An investigation, not a change. Nothing here is implemented.

## The question

A point is drawn as a screen-facing sprite. On a surface seen at a grazing
angle that sprite is the wrong shape: the sample represents a patch of ground
that is foreshortened almost to a line, and a round splat covers far more than
the patch does. Orienting the footprint to the surface would put each sample's
mark where the sample actually is.

## Where the two gates stand

The phase permits this only if normals already exist and benchmarks justify it.

Normals do exist, partially. The cloud type carries an optional `normals`
array, and three readers populate it: E57, PCD and `.pnts` tiles. The renderer
says the rest out loud at the point of use, where a comment on the tile path
records that a `.pnts` tile can state them and LAS never does. So the formats
that carry orientation are the minority ones, and the survey formats this tool
exists for carry none.

The benchmark gate is simply unmet. Nothing has been measured, so nothing was
built.

## Finding 1: normals reach the renderer only as colour

`colorByNormal` takes the normals array and returns a `Uint8Array` of RGB. That
is the whole geometric journey: orientation is baked into a colour on the CPU
and travels through the same colour attribute every other mode uses. Inspect
also reads the array to report a value in point info.

`buildPointMesh` takes positions, colours, classification and intensity. There
is no normal attribute and nothing in the size graph can read one.

An oriented footprint therefore needs a fifth per-point attribute. Three floats
is twelve bytes a point, on the formats where a cloud already carries the data.
The figure is worth holding next to the temporal block investigation, which
costed sixteen bytes a point and found that comparable to the entire history
budget on a large cloud. Orientation packs better than position does, since a
unit vector has two degrees of freedom rather than three and the usual encodings
reach four bytes without a visible loss, so the honest range is four to twelve
depending on how much work the encoding is worth. None of that is measured here,
and the point of quoting it is that the attribute is not free and the cheapest
version is not the obvious one.

## Finding 2: it would invert the stance the programme already took

This is the part that matters more than the cost.

`normalAgreement` already decides what a normal is allowed to do here, and the
rule is that normals only ever refuse. They can stop a gap being filled across a
roof ridge, and they can never turn a refusal into a fill. The module states the
reason: every fill still has to satisfy the depth and support rules on its own,
so adding a normals channel to a dataset can only make the renderer more careful
with it, never less.

An oriented footprint is the opposite kind of use. There the normal would decide
what a sample's mark looks like, so a wrong normal draws a wrong shape, and a
dataset that supplied a bad orientation channel would produce a worse picture
than one that supplied none. The asymmetry that makes normals safe today is
exactly what a surfel mode gives up.

That is not a reason to refuse it forever. It is a reason for it to be a mode a
viewer turns on rather than a quality the renderer applies when it notices a
normals array, and for its provenance to record that it was on.

The same module also settles the phase's other constraint in advance, and more
strictly than asked. The phase says not to make the app depend on generated
normals. The programme's existing rule is that normals are never computed at
all, because fitting one to a neighbourhood mid-frame would be inventing the
thing being used to check an invention. A surfel mode inherits that: it can
orient by a normal a file supplied and must not manufacture one for a file that
did not.

## Finding 3: what it may be called

An oriented disc is still the footprint of one sample. It interpolates nothing
between points, infers no surface between them, and adds no geometry that was
not measured. The number of samples on screen is identical; only the shape each
one paints changes.

So it is a display mode.

The word reconstruction does not belong anywhere near it, including in the
evidence register, where a claim of surface reconstruction would carry an
evidence tier this has no way to earn. A viewer who reads a surfel render as a
reconstructed surface has been misled by the picture rather than by a claim, and
the picture is the harder of the two to correct afterwards. That is an argument
for the evidence lens covering this mode as it covers the rest, since the lens
is the one place a viewer can put a reading back on measured ground.

## What would make this worth revisiting

A benchmark on a cloud that actually carries normals, showing the grazing-angle
case is better enough to justify a fifth attribute and a second display mode to
maintain. E57 and PCD scans are the only place that measurement can be taken,
and their share of what this tool opens is small enough that the answer may be
that the effort belongs elsewhere.

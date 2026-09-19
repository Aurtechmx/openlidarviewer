# Temporal block buffers

An investigation, not a change. Nothing in this document is implemented.

## The question

Drawing a subset of points per frame currently runs the vertex shader for every
point and rejects most of them. If the points of one temporal phase were
contiguous in the buffer, a frame could draw that range alone and never issue the
rejected vertices at all. The saving would scale with the phase count, so at four
phases three quarters of the vertex work would simply not be submitted, and at
eight phases seven eighths of it. That is the shape of the prize.

## Why it was not built

Two conditions gate it and neither is met.

The first is a benchmark of simple GPU phase rejection. That measurement needs a
WebGPU adapter and there is none on this runner, so the cost of the thing being
replaced has never been read. Without it there is no baseline to improve on, and
an optimisation with no baseline is a preference.

The second is stated in the phase itself: this is worth doing only if vertex
cost remains material after the fragment savings. Fragment savings are also
unmeasured, so the quantity that decides the whole question has never been read.
Building the optimisation now would be answering a measurement with a guess.

What follows is what the code settles without a device, which is enough to
change what the eventual benchmark should be compared against.

## Finding 1: a block layout is a permutation, not a reinterpretation

The phase a point belongs to is `floor(phaseCount * fadeHashUnit(index + seed))`,
and the hash is there to scatter. Phase 0 is spread evenly across the mesh, so a
frame drawing it covers the whole image thinly rather than covering part of it
solidly.

Taking a contiguous range as a phase discards the hash and makes the phase a
function of position in the buffer. The spatial meaning of a phase then becomes
whatever order the source file happens to be in, and survey LAS is usually close
to acquisition order. Phase 0 would be a swath of the scan rather than a
sprinkle across it, and an accumulation would fill the image in as moving
stripes.

That is the visible pulsing the reduced-motion phase exists to prevent, arriving
through the buffer layout instead of through the schedule.

So a block layout has to physically permute the points into hash order and keep
the scatter. Reinterpreting the order already there does not save the work, it
changes what a phase means.

## Finding 2: the render buffer is the authoritative array

`Viewer.buildPointMesh` wraps the caller's positions directly:

```ts
const positionAttr = new THREE.InstancedBufferAttribute(positions, 3);
```

There is no copy. The instance index and the source point index are the same
number by construction, and that equality is relied on well outside the
renderer: inspect picking returns an index that `patchView` uses to read
`positions[i * 3]`, and the profile builder reads colour and classification at
`sourceIndex` in the bound source.

Permuting that array in place would move every one of those reads onto the wrong
point. Keeping the source order and permuting a copy is the only version that
preserves identity, which the phase requires in both of its constraints.

The other attributes are already derived copies. Colour is converted through
`toFloatColors`, and classification and intensity are each copied into a fresh
`Float32Array` at mesh build. Permuting those costs nothing that is not already
being spent.

## Finding 3: the incremental cost, and what it should be weighed against

The permutation needs a second positions buffer and a map from render index back
to source index:

| Buffer | Bytes per point |
| --- | --- |
| Permuted positions, 3 × f32 | 12 |
| Render index to source index, u32 | 4 |
| Colour, classification, intensity | 0, already copied |

Sixteen bytes per point.

On the streamed cloud this programme actually measured, 15.7 million points over
485 nodes, that is 251,200,000 bytes, or about 240 MiB: 180 MiB of positions and
60 MiB of map.

The history buffer ceiling is 256 MiB. So a layout whose purpose is to save
vertex invocations would cost about as much memory as the entire accumulation
history is ever allowed to hold, and it would spend it on a cloud where the
history is the thing competing for the same budget.

That is not an argument that the layout is wrong. It is the comparison the
benchmark has to beat, and it was not visible before the two buffers were
identified as shared and derived.

## What would make this worth revisiting

A measurement, on a device, showing vertex cost still material after fragment
savings, for a cloud large enough that the saving is not noise. If that arrives,
the design to test is a per-node permutation with an inverse map rather than a
whole-file one. Nodes are already separate meshes, each already builds three
derived attributes at mount, and a node-sized map keeps the cost proportional to
what is resident instead of to the file on disk. A streamed scan that never
admits more than a fraction of its nodes would then pay for a fraction of the
permutation, which is a different trade from the one costed above and the only
version of it worth benchmarking first.

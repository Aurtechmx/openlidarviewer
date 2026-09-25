# Edge-aware point kernel

An investigation, not a change. Nothing here is implemented.

## The question

A point drawn as a uniform sprite is a compromise. Wide enough to close gaps on
an interior surface, it also spills across silhouettes, so a foreground edge
grows a fringe of background-coloured pixels and a thin branch against the sky
reads as a fat one. A kernel that stayed compact in interiors and tightened near
strong depth discontinuities would fix the fringe without reopening the gaps,
which is the whole appeal.

## Why it was not built

The phase gates itself on micro-gap closure being stable. Micro-gap closure has
never run: it is one of the capabilities that cannot be switched on, so it has
no behaviour on a device to be stable or unstable. The phase also calls itself
optional and says not to delay the core feature set for it.

## Finding 1: the postprocess the phase asks for already ships

The phase says not to compute expensive screen-space edges per point if a
postprocess can do it cheaper. In this tree the postprocess exists. Eye Dome
Lighting is described in its own module as the screen-space depth cue that
traces every depth discontinuity in a point cloud, and it works by sampling
neighbouring depths at a radius in device pixels and responding to the
difference.

That is the same quantity an edge-aware kernel wants. Any per-point screen-space
edge test added now would be a second computation of a signal the renderer
already produces every frame.

## Finding 2: the signal exists one stage too late

This is the constraint that shapes every option.

A kernel's size is decided in the vertex and size stage, which runs before
rasterisation. The EDL response is a function of the completed depth buffer, so
it exists only after every point has already been sized and drawn. An edge-aware
kernel cannot read it within the same pass, and no amount of tuning changes the
ordering.

Three designs follow from that, with different costs.

A depth prepass, then a second point draw. Render depth, derive the edge
response, draw the points again with the response bound. This is the version
that works exactly as described, and it draws every point twice. Vertex cost is
precisely the quantity the temporal block investigation was opened to reduce, so
this design spends the budget that one was trying to save.

Sharpening in the postprocess alone. Leave the kernel unchanged and treat
edges after the fact. Cheap, and it does not do what the phase asks: the splat
still covers the same pixels, so the foreground still writes across the
silhouette and the postprocess is shading a fringe rather than preventing one.

A precomputed per-point descriptor. The density grid behind
`localDensitySizes` already visits every point once and already produces a
per-point multiplier that the size graph reads at vertex time. A per-cell
measure of how much the points in a cell disagree in depth would ride the same
pass and be available exactly where a kernel decision is made, at no screen-space
cost at all.

The catch is worth stating plainly rather than discovering later. A precomputed
descriptor is view-independent, so it describes surface structure: the edge of a
roof, the boundary of a canopy, a wall meeting the ground. A screen-space
discontinuity is view-dependent and includes silhouettes between two surfaces
that are unrelated in the data and merely overlap from where the camera happens
to be. Those are different sets, and the precomputed one is the smaller. It
would tighten the kernel on real geometric edges and do nothing for the case
where a near object crosses a far one, which is the case most likely to be
noticed.

## What already exists and would not need rebuilding

The predicate for "these two samples are on one surface" is written and reused:
`depthCompatible` in the accumulation merge, which micro-gap closure and the
support rules already share. Nothing about the test is missing. What is missing
is a place to evaluate it before rasterisation, which is Finding 2 restated in
terms of what is on hand.

## What would make this worth revisiting

Micro-gap closure running on a device, long enough to know whether the fringe is
still the thing a viewer notices once gaps are closed. It may not be: closing
sub-pixel gaps changes how a surface reads, and the silhouette fringe may stop
being the most visible defect. That ordering matters, because the cheap design
does not do the job and the design that does costs a second point draw. Starting
with the measurement of whether anyone minds is the part that can be done
without building anything.

# The Continuity Field

A display layer that makes a point cloud read as the surface it was sampled
from, without letting any of that reach a measurement.

Everything here describes code that is present and switched off. No capability
can be enabled in a shipped build, 18 of the 19 subsystem files are unreachable
from the application entry at runtime, and the sections below say which claims
rest on measurement and which do not.

## What it does, in the terms this document uses throughout

A point cloud drawn as sprites leaves holes between samples of a surface that
is continuous. Closing those holes is **presentation reconstruction**: pixels
the renderer paints where no sample was recorded, because neighbouring samples
on one surface bracket them.

Presentation reconstruction is never new measured geometry. A reconstructed
pixel carries no coordinate, no point index and no identity, so nothing can
pick it, measure from it, export it or cite it as evidence. That is a
structural property rather than a promise, and `tests/reconstructedPixelsNotPickable.test.ts`
reads the keys of a fill decision instead of trusting the sentence.

The vocabulary is fixed and used consistently:

| Term | Meaning |
| --- | --- |
| direct | A source sample was rasterised at this pixel |
| accumulated | Built from source samples across frames of one epoch |
| reconstructed | Borrowed from neighbours; traces back to no sample of its own |

Accumulation is not reconstruction. Accumulated pixels compose measurements,
so only gap closure invents, and only gap closure triggers the refusals below.

## Architecture

The subsystem is 19 files under `src/render/continuity/`, each pure: no
three.js, no DOM, no GPU calls. The renderer owns the buffers and the passes;
these decide what a pass is allowed to do.

Capabilities are grouped into four rungs, richest first: `full`, `closure`,
`sizing`, `source`. `source` is the renderer as it ships. A device is measured
rather than recognised, so no model name or user-agent string decides anything,
and three separate caps can lower the rung a viewer runs at: what the backend
was measured to support, what the device class is allowed, and what the session
has explicitly opted into. The lowest of the three wins, a rung is granted
whole or not at all, and with nothing opted into every combination of the three
returns `source`.

Related notes, all engineering rather than release material:

- [Bundle strategy](architecture/continuity-bundle-strategy.md): why the whole subsystem is lazy
- [Temporal block buffers](architecture/temporal-block-buffers.md): an optimisation investigated and not built
- [Edge-aware kernel](architecture/edge-aware-kernel.md): why the cheap design does not work
- [Oriented footprints](architecture/oriented-footprints.md): normals, and the stance they already have here

## Benchmarks

There is no benchmark report, and the gap is the point of this section rather
than an omission from it. No runner in this project exposes a WebGPU adapter,
and there is no phone, tablet or iPhone-class WebKit device, so frame time
under the field has never been measured anywhere.

Two things were measured and are worth separating from the rest:

Coverage sizing on a real streamed source, 15.7 million points over 485 nodes.
Mean frame energy rose from 69.75 to 82.08 when density sizing was selected and
returned to exactly 69.75 on switching back. Before that cycle the selection
changed nothing at all on a streamed scan, which is the first result. The exact
return is the second, because a switch that rebuilt the pipeline rather than
writing a uniform would not land on the same number, and neither figure says
anything about the field itself, which has never drawn a frame here.

Those two numbers were read from a live browser session and no machine-readable
artifact was kept, so they cannot be reproduced from this repository. They are
reported because the measurement happened, and flagged because a reader cannot
check them. The benchmark record schema added later exists so that the next
measurement does not have this problem.

Bundle cost, measured with live builds at both ends. The subsystem adds two
kilobytes to the eager entry while unwired, and importing its four decision
modules eagerly costs nine and breaks the ceiling, which is why the seam goes
around all of it.

## Browser compatibility

One difference between the two backends was measured rather than assumed, and
it decides which rung a backend can carry.

| Surface | WebGPU | WebGL 2 |
| --- | --- | --- |
| History colour | Available | Available |
| History support | Available | Available |
| History depth (`r32float`) | Renderable unconditionally | Needs `EXT_color_buffer_float` |

The depth surface is the one a backend may refuse. `EXT_color_buffer_float` is
not core WebGL 2, and without it the framebuffer is incomplete rather than
slow, so a caller on that backend has to ask for the extension before answering
yes. A device that refuses it takes the rung that keeps no history and still
closes gaps.

Coverage sizing rendering under WebGL 2 has no device evidence. The formats are
there and the fold is backend-neutral in principle, which is the kind of claim
this subsystem declines to make on principle alone.

## Memory behaviour

Three surfaces persist between frames: accumulated colour, the depth it was
built at, and per-pixel support. Cost is the backing-store area times the bytes
a pixel needs, so it scales with the square of the pixel ratio.

Colour is eight bits a channel because the sweep is short, four phases rather
than hundreds, so rounding does not compound past what a display can show.
Depth is a full float and cannot be economised: the merge rule compares depths
as a ratio across scenes spanning metres to kilometres, and a half float would
collapse the distinctions that rule exists to draw.

A history over 256 MiB is declined rather than allocated.

The history is also sized from the parked pixel ratio rather than the one in
force. Applying a ratio reallocates the drawing buffer, the adaptive ratio
lowers it while the camera moves, and it snaps back to full exactly when the
camera parks, which is when a sweep begins. Sizing from the live ratio would
therefore free and reallocate three surfaces on the frame the history was about
to be used on, and nothing is lost by ignoring the reductions, because a moving
camera has no sweep to accumulate.

Under pressure the subsystem gives things up in the order of what each actually
frees. Lowering the history ratio frees memory quadratically and dropping
accumulation frees all of it, while gap closure and sweep length free nothing
and are relief for frame time instead. The authoritative points are never a
source of relief, and the state that pressure relief operates on holds no field
that could name one.

## The evidence lens

The lens is the region where the renderer stops reconstructing and shows what
was measured. Inside it nothing is substituted, so whatever remains is coverage
the data paid for.

Its edge is a hard decision rather than a fade. A lens that faded reconstruction
in across its rim would produce a ring of partly invented pixels, and a viewer
holding it over a suspicious patch would be reading exactly the band that cannot
answer the question. Appearance is blended across the rim; whether a pixel may
be invented is not.

The lens reports what it can honestly claim. On a streamed scan the samples
present are the ones that have loaded rather than the ones the file holds, so a
thin patch under the lens can mean sparse ground or data that has not arrived.
Those are opposite conclusions and the lens looks identical in both, so it
reports complete evidence only where the source is proven complete.

It is reachable without a mouse. A hovering pointer supplies a position every
frame and nothing else does, so touch and keyboard pin the lens where the
viewer put it rather than dismissing it when contact ends.

## Known limitations

A roof ridge closes on depth alone. Two slopes either side of a fold sit at
nearly the same distance from the camera and pass the depth test comfortably,
so closure lays a patch across the fold, and the scene corpus asserts that it
does rather than asserting it away. Normals refuse the fill where a file
supplies them. Most survey formats carry none, LAS among them, so the refusal
is unavailable on the majority of what this tool opens and the limitation
stands on those files.

Six thresholds are shapes rather than calibrations, including the depth
tolerance, the reconstruction share ceiling and the coverage-need spacing. Each
says so where it is defined. The figures that belong there come from real
scenes at several densities.

Mobile is capped at coverage sizing, which reconstructs nothing, and the cap
lifts only on measured frame evidence from a device class somebody benchmarked.

The field is off. Nothing above changes a shipped build today, and the
scientific-regression gate records that the subsystem altered no measured value
because nothing reaches it at runtime.

# Continuity Field release blockers

Fourteen conditions, each of which stops a stable release if it is reproduced.
Status at `a113034a`.

None is reproduced. Seven are held shut by a test or cannot occur, five cannot
be assessed without a device, one is an open risk with a live mechanism, and
one is an open gap in evidence rather than a defect.

The distinction that matters here is between a blocker that has been checked
and one that merely has not fired.

A subsystem that never runs reproduces nothing, so a bare "not reproduced"
would be true of all fourteen and would mean nothing. Each row below says which
kind it is: held by a named test, impossible because the code does not exist,
or waiting on hardware this project does not have. Three rows carry something
beyond a status and are written out underneath.

## Status

| Blocker | Status | Basis |
| --- | --- | --- |
| Reconstructed pixels pickable as source points | Held | `reconstructedPixelsNotPickable.test.ts`: a fill decision carries a depth and a support kind and no identity |
| Measurements change because of the field | Held | Scientific regression gate; 142 modules unreachable counting runtime edges, the subsystem among them |
| Scientific exports consume reconstructed buffers | Open risk | See below |
| History survives incompatible camera, data or display state | Held | Convergence returns to idle on any epoch change; the scene corpus drives it |
| Obvious temporal ghosting | Not assessable | Needs a device |
| Closure crosses strong depth edges | Held, with a documented weak-edge case | See below |
| Classification colours averaged into false categories | Held | Categorical merge never returns blend; it takes the nearer label and an exact tie keeps what is there |
| Frustum culling hides visible streamed nodes | Cannot occur | `nodeFrustumCulling.ts` has no importer and `continuityNodeCulling` has no consumer |
| Packed classification codes lose exact identity | Held | Packing is unimplemented; the live float attribute is exact to 2^24, pinned by `classificationCodeIdentity.test.ts` |
| WebGPU and WebGL 2 disagree without a documented fallback | Held, with an open gap | See below |
| Repeated use leaks render targets or buffers | Not assessable | Disposal contracts are pure-tested; the GPU half needs a device |
| Mobile memory pressure crashes instead of falling back | Not assessable | The relief ladder is pure-tested; the crash case needs a device |
| Quality improvement only at a major unexplained GPU cost | Not assessable | No benchmark exists |
| Telemetry materially under-reports new memory | Held | See below |

## The open risk

Every Studio exporter renders to the live on-screen canvas, which is stated in
`BaseExportMode` and is what makes a figure match what the user saw. Four of
the seven raster modes encode geometry in their pixel values, so a reconstructed
pixel arriving in a height map or a depth map is an invented elevation in a
file somebody reads back as data.

The guard for this exists and is not wired. `presentationMode.capturePolicyFor`
returns `suspend-reconstruction` for exactly those four modes, and nothing
calls it. Today the blocker cannot fire, because no capability can be enabled
and nothing reconstructs. It fires on the day the field is switched on if that
wiring has not happened first, which makes it an ordering constraint on the
release rather than a defect in the tree.

## Closure at depth edges

Strong edges hold. The corpus puts a foreground block against a far background
and the seam between them stays empty, and a hole two or more pixels wide fills
nothing at all, because a rim pixel has neighbours on one side only and is
refused for want of support before any depth question arises.

A roof ridge is the weak case and it does close. Two slopes either side of a
fold sit at nearly the same distance from the camera, so depth alone cannot
tell the fold from a gap, and the corpus asserts that it fills rather than
asserting it away. Normals refuse the fill where a file supplies them, which
most survey formats do not. This is recorded as a limitation rather than as a
blocker because the blocker names strong edges, and it is the reason
`normalAgreement` exists.

## Backend disagreement

The two backends do disagree, the disagreement was measured rather than
assumed, and the fallback is documented. The history depth surface is
renderable unconditionally on WebGPU and needs `EXT_color_buffer_float` on
WebGL 2, where its absence makes the framebuffer incomplete rather than slow. A
device that refuses the extension takes the rung that keeps no history and
still closes gaps.

The open gap is coverage sizing, which has been measured rendering on WebGPU
and never on WebGL 2. The formats are present and the fold is backend-neutral
in principle, which is the kind of claim this subsystem declines to make on
principle alone.

## Telemetry

The debug overlay reports the history's cost from the real backing-store
dimensions in device pixels, which is the figure that decides the feature on a
high-ratio panel, and it marks the estimate when it is over the ceiling.

One inaccuracy is worth naming and is not this programme's. The shared byte
formatter divides by 1024 and labels the result MB, so a figure reads about 4.9
per cent below the decimal quantity its unit claims. It affects every byte
figure in the application, it understates rather than hides, and correcting it
is a repo-wide change to shipped text rather than something to fold into a
renderer phase.

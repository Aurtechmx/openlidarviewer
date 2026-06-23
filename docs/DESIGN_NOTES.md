# Design notes

Why OpenLiDARViewer behaves the way it does. Each decision below ties to a user need and the trade-off it accepts.

## Local-first, no upload

**Decision:** files are read and rendered in the browser; nothing is sent to a server.

**Why:** scan data is often sensitive (private sites, client work) and large. Uploading is slow and a privacy risk. Reading locally removes both.

**Trade-off:** the point cloud can't travel inside a shared session file. A session carries the analysis, not the scan, so a recipient opens it alongside the same scan. We make that explicit instead of hiding it.

## Honest about uncertainty

**Decision:** measurements, terrain surfaces, and derived classes all carry a visible trust signal, and the app declines to present a confident number the data can't support.

**Why:** a viewer that prints a clean number over thin or missing data invites a wrong decision. Survey work needs to know not just the value but how much to trust it.

**Trade-off:** more on screen than a bare number, and some results are flagged as caution or refused outright. We'd rather show a hedged truth than a confident guess. This is why a measurement with an endpoint in empty space reads red, and why filled-in ground is marked apart from measured ground.

## Instant analysis on drop

**Decision:** the moment a scan opens, the most relevant analysis is offered as one button; with a second scan, a before/after comparison is offered.

**Why:** the value is in the analysis, not the view. Surfacing it immediately removes the hunt for the right tool.

**Trade-off:** the heavy work runs on a click, not automatically, so opening a scan stays fast and predictable on large files.

## One way to open a session

**Decision:** a saved `.olvsession` opens the same way whether it's dragged onto the window, picked through Open, or loaded from the Measurements panel.

**Why:** three entry points that behaved differently were a source of confusion. A file that looks openable should open.

**Trade-off:** the app inspects every opened file to route it (scan vs session) before doing anything else. The cost is negligible and the behaviour is predictable.

## Cited and reproducible

**Decision:** quality thresholds and capture-provenance bounds reference published literature, and an analysis can be saved and reopened to the same state.

**Why:** an inspection result that can't be reproduced or traced to a source is hard to defend. Field and survey work often has to be.

**Trade-off:** some assessments read as conservative. That's deliberate — the grade errs toward what the data can prove.

# Design notes

Why OpenLiDARViewer behaves the way it does. Each decision below ties to a user need and the trade-off it accepts.

## Local-first, no upload

Files are read and rendered in the browser, and nothing is sent to a server. Scan data is often sensitive (private sites, client work) and large, so an upload would be slow and would put that data at risk; reading locally removes both problems. The cost is that the point cloud can't travel inside a shared session file. A session carries the analysis without the scan, so a recipient has to open it alongside the same scan.

## Honest about uncertainty

Measurements, terrain surfaces and derived classes each carry a visible trust signal, and the app declines to present a confident number the data can't support. A viewer that prints a clean number over thin or missing data invites a wrong decision, and survey work needs to know how far to trust a value as well as the value itself.

This puts more on screen than a bare number, and some results are flagged as caution or refused outright. A measurement with an endpoint in empty space reads red for that reason, and filled-in ground is marked apart from measured ground.

## Instant analysis on drop

The moment a scan opens, the most relevant analysis is offered as one button, and with a second scan a before/after comparison is offered. People open a scan to analyse it, and putting the analysis one click away removes the hunt for the right tool. The heavy work still waits for that click instead of starting automatically, so opening a large file stays fast and predictable.

## One way to open a session

A saved `.olvsession` opens the same way whether it's dragged onto the window, picked through Open, or loaded from the Measurements panel. Earlier, those three entry points behaved differently and confused people; a file that looks openable should open. To route a file, the app inspects every opened file (scan or session) before doing anything else. The check costs almost nothing.

## Cited and reproducible

Quality thresholds and capture-provenance bounds reference published literature, and an analysis can be saved and reopened to the same state. An inspection result that can't be reproduced or traced to a source is hard to defend, and field and survey work often has to be defended.

Some assessments therefore read as conservative, because the grade errs toward what the data can prove.

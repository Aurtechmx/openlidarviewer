# Research collaboration

OpenLiDARViewer ships with an evidence record attached to it: released numbers
are meant to be reproducible, and the validation legs are public. That record
gets stronger when people outside the project test it.

This page is for anyone who wants to do that, and for anyone whose own work
could fold into it.

## Ways to contribute scientifically

- Reproduce a result. Run the offline suite from a clean clone
  ([REVIEWER_QUICKSTART.md](../../REVIEWER_QUICKSTART.md)) and say where your
  numbers differ from the reported ones. A mismatch is worth more than a match.
- Bring a dataset. Surveyed checkpoints, field-measured terrain, or a public
  cloud with a declared coordinate system let the tool be tested against ground
  truth instead of against itself. Only send data you are free to redistribute.
- Cross-check a method. Compare a DTM/DSM, contours, slope, or a measurement
  against ArcGIS, CloudCompare, PDAL, or GDAL, and report both the agreement and
  the disagreement.
- Review the methodology. Read the validation reports and the method notes and
  say what is under-specified, unconvincing, or wrong.

Studies that test the viewer outside the data and assumptions the core project
already used are the most useful of all. A result that holds only on our own
fixtures tells us less than one that holds, or fails, on yours. If that means
the reported figure moves, so be it; a corrected number is the point.

## What we can offer in return

Independent validation that gets folded in is credited to whoever did it, and
cited in the evidence record. If you are writing the work up, a co-authored
validation note is on the table rather than having the same result sit in two
disconnected places. None of this is an obligation. It is how we would rather
work, and it costs you nothing to ask.

## How to start

Open an issue or a discussion on
[GitHub](https://github.com/Aurtechmx/openlidarviewer), describing what you want
to test and what data you have. Email <info@aurtech.mx> first for anything you
would rather not post publicly.

## Citing the work

Use the **Cite this repository** button on the repository page, which reads
[CITATION.cff](../../CITATION.cff) and gives you the current reference, including
BibTeX. Cite the software version and its DOI when you use the tool. Once the
OpenLiDARViewer paper is published it will carry its own reference for the
methodology, and `CITATION.cff` will point to it; until then the software
citation covers both.

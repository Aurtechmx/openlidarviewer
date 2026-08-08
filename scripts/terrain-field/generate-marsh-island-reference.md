# Marsh Island checkpoint fixture — reproduction

Source (public domain, USGS DOI 10.5066/P19TLXVG):
- 2025009FA_MI_Mar_YSMP_LPC_classified.laz  (classified point cloud, NAVD88 orthometric)
- 2025009FA_MI_Mar_GPS_Emlid_RS3_checkpoints.csv  (104 independent RTK check shots)

Fixture:
- crops/marsh-island__ground.f32 — class-2 ground within 0.75 m of each checkpoint,
  Float32 (x,y,z) relative to origin (340303, 4612812), extracted in one PDAL pass:
  readers.las -> filters.range(Classification[2:2]) -> filters.crop(104 x ±0.75 m squares)
  -> writers.text(csv).
- references/marsh-island__checkpoints.json — 104 checkpoints: id, relative E/N, surveyed NAVD88 Z.

The test grids the ground with OLV rasterizeDtm (mean) at 0.5 m and compares each
checkpoint to its DTM cell (NAVD88 <-> NAVD88, no reconciliation).

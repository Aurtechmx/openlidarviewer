# Profile ground-first rule: paired injection-recovery test (protocol)

Status: written on 2026-11-04, before the fixtures below were generated and
before OpenLiDARViewer's sampler was run on them, and committed in the same
change as its result. Under `README.md` in this directory that is
adopted-with-result, not a preregistration: no commit shows this protocol
without its figures. The scenes, settings, measures and decision rule are
fixed here. A result that goes against the rule in use is recorded as such.

This is a synthetic check of one choice in the profile sampler. It moves no
evidence level. MEAS-PROFILE stays where it is, and its OGR/R study still covers
the percentile over every accepted return.

## Question

The profile sampler reduces each station's corridor to one height. Two rules are
compared on a scan with ground labels:

- `all-returns` (`olv.profile.corridor-percentile@2`): the 25th percentile of
  every accepted return in the station's bin.
- `ground-first` (`olv.profile.corridor-percentile@3`): the 25th percentile of the
  bin's ground returns (class 2) where it has any, and of its other accepted
  returns where it has none.

Which rule should draw the first chart? `ground-first` keeps unclassified canopy
out of the line. It also depends on where the labels fall, and a ground filter
can reject the crests of fine relief on flat ground and keep them on a slope.

## Design

The design is a paired injection-recovery test, after Urias, "Terrain-Dependent
Loss of Fine Relief in LiDAR Ground Filtering" (code and scene definition:
<https://doi.org/10.5281/zenodo.23933963>). Each scene exists with and without a
known feature, from the same points, noise and objects. The profile is drawn on
both and subtracted, so whatever remains is the feature as the profile recovered
it.

Scenes come from that archive's `sample_scene`: a 128 m square, 8 pts/m², 0.02 m
noise, five buildings and 40 trees.

- Backgrounds: `flat`, `rampx10`, `rampx30` (10 and 30 % slope along the feature)
  and `hill`.
- Feature: 0.6 m amplitude, 6 m wavelength, along x, added to every return.
- Realisations: seeds 101 and 202, phases 0 and π, so four per background.
- Section line: (40, 54) to (88, 54). It crosses three tree crowns and no
  building. The line was chosen from the object layout alone.
- Sampler settings: the app's defaults for a line this long. That is the 5 %
  automatic corridor (2.4 m half-width), 64 stations and the 25th percentile.

Three label sets are applied to the same points. The non-ground codes decide
which returns the sampler accepts:

- `filter`: labels from the archive's SMRF implementation at its default settings
  (cell 1 m, slope 0.15, window 18 m, threshold 0.5 m, scalar 1.25), run on the
  whole scene, with and without the feature separately. Ground is 2, the rest 1.
- `ground-known`: the true ground returns are 2, canopy and roofs are 1. This is a
  scan whose vegetation was never classified.
- `classified`: true ground 2, canopy 5, roofs 6. Both rules must give the same
  series here, because the sampler drops 5 and 6 first. This is the control.

## Measures

Stations are compared with the true surface at their own chainage. With Δ the
series with the feature minus the series without it, and u the feature at the
stations:

- Recovery error `E` = RMS(Δ − u) / RMS(u).
- Amplitude retained `G`: the modulus of the ratio of the sine and cosine
  coefficients of Δ and u, fitted with an intercept and a linear trend.
- Height error `H` = RMS(series with the feature − (background + u)) / RMS(u).
  `E` cannot see a line that sits too high by the same amount in both scenes.
  `H` can, and it is what canopy pull changes.

Each is averaged over the four realisations of a background, by rule and label
set. Stations with no return are left out and counted.

## Decision rule

The smallest difference that matters is 0.10 in `E` and 0.10 in `H`, the first
being the threshold the study used.

For each rule and each of the `filter` and `ground-known` label sets, take the
largest background mean of `E` and of `H`. `ground-first` draws the first chart
only if, on both label sets, neither of its figures exceeds the `all-returns`
figure by more than 0.10. Otherwise `all-returns` draws the first chart.

The prediction, stated before the run: `ground-first` wins on `H` on `ground-known`
and loses on `E` on `filter` on flat ground. If so, the rule above returns the
chart to `all-returns`, and the figures are
recorded with the result.

## Limits

These are synthetic scenes with one feature shape and one filter. They say nothing
about how a survey provider's classification treats fine relief. The canopy is a
geometric stand-in. Two seeds and two phases describe Monte Carlo variation only.

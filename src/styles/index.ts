// The application stylesheet, split from one 9,004-line src/style.css into
// ordered section files for navigation. This is a PURE, order-preserving
// partition: the imports below run top-to-bottom in the same order the sections
// appeared in the original file, and Vite concatenates imported CSS in import
// order, so the cascade is byte-for-byte unchanged. tests/styleCssPartition.test.ts
// proves that concatenating these files reproduces the original exactly, so no
// rule may be reordered, merged, or dropped by editing this list out of order.
//
// Keep this list in cascade order. A later file's rules beat an earlier file's
// at equal specificity, exactly as later rules did in the single sheet.

import './01-tokens.css'; // Design tokens: brand palette, spacing scale, radii, motion, type scale (:root).
import './02-overlays-chrome.css'; // Top-edge chrome and overlays: workflow-recorder badge, command palette, header theme toggle, full-screen toggle.
import './03-theme-rails.css'; // Light and high-contrast theme rails. They override the base tokens, so they stay in place right after 01.
import './10-stage.css'; // Stage container and canvas overlay.
import './20-topbar.css'; // Top bar: brand mark and lock glyph.
import './30-empty-state.css'; // Empty state: hero, splash, workflow rail, sample and tour, catalog panel, open-from-URL.
import './40-inspector.css'; // Inspector panel: streaming layout, collapsible sections, per-layer CRS badges, Visuals Studio, filters, rendering controls.
import './45-dock-and-panels.css'; // Tool dock and backend indicator, developer performance overlay, streaming COPC panel, progress toast.
import './50-navigation-bar.css'; // Navigation bar: mode-switcher triangle, speed slider, controls HUD, orthographic toggle.
import './55-micro-interactions.css'; // Micro-interactions: keyboard focus, entrance motion, health pulse, version mark.
import './56-inspector-panels.css'; // Inspector sub-panels: export buttons, saved views, provenance and CRS, profile card, session stats, project-ready summary.
import './60-measure-inspect.css'; // Measure tool overlay and Inspect tool marker with its floating info card.
import './65-mobile-touch.css'; // Mobile and touch: safe-area insets, the file-picker button, phone layout.
import './70-measurement-panels.css'; // Measurement toolkit and toolbar: annotation markers, inline editor, hint bar, kind picker, icon controls, tooltip, panel stack.
import './72-panel-rails.css'; // Left and right panel rails: one-tap collapse, scroll hygiene, scrollbar styling.
import './73-desktop-workspace.css'; // Desktop left-rail workspace: Data/Work/Analyse/Output mode tabs over one-at-a-time mode hosts.
import './74-inspector-profile.css'; // Inspector active rail and profile deliverable: resize grip, profile chart, photometric witness, sampler, station table.
import './76-classification.css'; // Classification legend and manual classification-edit panel.
import './78-shortcuts-recorder-tour.css'; // Keyboard shortcut sheet, workflow-recorder settings popup, onboarding tour overlay.
import './79-annotations-panel.css'; // Annotations panel.
import './80-modal-system.css'; // Help overlay, reusable accessible modal, result-focus surface, styled confirm dialog, live-probe readout.
import './83-mobile-audit.css'; // Mobile collapsible side panels, desktop-audit additions, and the mobile design-audit plus error-handling batch.
import './86-dataset-intel-analyse.css'; // Dataset Intelligence card, Get-Started stepper, Analyse panel.
import './89-data-fitness.css'; // Data Fitness scorecard.
import './90-converter-export.css'; // Batch format converter, in-project Export/Convert panel, clip-box panel.
import './92-terrain-verdict.css'; // Terrain assessment verdict, supporting metrics, recommended workflow, terrain products, surface-model tiles.
import './94-scan-type.css'; // Object-scan panel and segmented scan-type override.
import './95-buttons.css'; // Unified button system.
import './96-phone-sheet-story.css'; // Phone bottom-sheet, landscape-phone canvas, Dataset Story card and Export Health.
import './97-contour-studio.css'; // Contour Studio: launcher, workspace, evidence ladder, export section.
import './98-layer-health.css'; // Colorbar legend overlay and Layer Health card: spatial facts and compatibility.
import './98b-process-studio.css'; // Process Studio panel: adaptive stages, product eligibility and QA checks.
import './99-mobile-gui-refresh.css'; // Mobile GUI refresh (v0.6.x) and the landscape-phone left rail.
import './99z-forced-colors.css'; // Windows High Contrast / forced-colors — the final override block.

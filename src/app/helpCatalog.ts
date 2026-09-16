/**
 * helpCatalog.ts
 *
 * What Help explains, as pure data: the curated topics (getting started,
 * navigation, tools, analysis, export with trust, the scientific states) and,
 * for each, the registry actions it references by id. A title, a hint or a key
 * is never written here; they come from the action descriptors and the key
 * binding table at render time, so Help cannot drift from the palette and
 * the sheet. Search ranks topics and actions by the same plain rule.
 * No DOM and no callbacks live here.
 */
import type { ActionDescriptor } from '../ui/actionRegistry';
import type { ShortcutDescriptor } from '../ui/keyBindings';

export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Authored prose, one paragraph per entry. */
  readonly paragraphs: readonly string[];
  /** Term and meaning pairs rendered as rows; the scientific states use these. */
  readonly terms?: readonly (readonly [string, string])[];
  /** Registry actions the topic lists, rendered from their own descriptor. */
  readonly actionIds?: readonly string[];
  readonly keywords?: readonly string[];
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'Open a scan, look around, and find the tools.',
    paragraphs: [
      'Drop a point-cloud file (LAS or LAZ, E57, PLY, COPC) on the page, or use Open scan from device. Every scan stays on your device: nothing is uploaded.',
      'The tool dock along the bottom holds the tools. The left tabs (Data, Tools, Analyse, Export) switch the panel column. The command palette lists every action by name.',
    ],
    actionIds: ['camera.frame-all', 'tour.replay', 'help.shortcuts'],
    keywords: ['open', 'drop', 'file', 'start', 'begin', 'privacy', 'local'],
  },
  {
    id: 'navigation',
    title: 'Navigation',
    summary: 'Orbit, walk, fly or pan; frame and focus.',
    paragraphs: [
      'Drag to rotate and scroll to zoom. Keys 1 to 4 pick the mode: orbit, walk, fly, pan. WASD and the arrows move in walk and fly. Space and C raise and lower; Shift sprints.',
      'R frames the whole scan and F focuses its centre; a double-click focuses a point. Hold Space while a tool is active to rotate or pan, then release to resume. Right-click opens a quick menu to focus, frame or snap to a view.',
    ],
    actionIds: ['camera.top', 'camera.oblique', 'camera.planar', 'camera.plan-view', 'camera.orthographic', 'view.save-state', 'view.restore-state', 'view.compass'],
    keywords: ['orbit', 'walk', 'fly', 'pan', 'camera', 'frame', 'focus', 'zoom', 'view', 'compass', 'keyboard'],
  },
  {
    id: 'tools',
    title: 'Tools',
    summary: 'Measure, inspect, annotate, or lasso a volume.',
    paragraphs: [
      'The Tools tab lists these tools with their keys, and says how many measurements and annotations the session holds.',
      'Probe reads a live point under the cursor with no click. With Annotate on, click a point, fill the card and Save; the Annotations panel jumps to, edits or deletes any finding.',
    ],
    actionIds: ['tool.measure', 'tool.inspect', 'tool.annotate', 'tool.clip', 'tool.lasso-volume', 'tool.lasso-selection-basis'],
    keywords: ['measure', 'distance', 'area', 'volume', 'inspect', 'probe', 'annotate', 'note', 'lasso'],
  },
  {
    id: 'analyse',
    title: 'Analyse',
    summary: 'Terrain analysis, contours, classification, the Dataset Story.',
    paragraphs: [
      'Terrain analysis classifies ground and builds the DTM. It validates the surface against held-out returns and states what the result can support. Contour Studio runs on that core. A derived classification is a heuristic the app computed, never a producer classification.',
    ],
    actionIds: ['analyse.run', 'analyse.contours', 'tool.classify', 'tool.fillUnclassified', 'story.dataset'],
    keywords: ['terrain', 'dtm', 'contour', 'ground', 'classification', 'derived', 'analysis', 'story'],
  },
  {
    id: 'export-trust',
    title: 'Export and scientific trust',
    summary: 'What leaves the app, and what it may claim.',
    paragraphs: [
      'Snapshot writes the view to a PNG with placed measurements and annotations burned in. A session file carries the whole inspection. Every export carries its provenance, and the export health check states the scope, the classification, the frame (CRS and datum), the density and the readiness before anything leaves.',
      'Some measurements and exports stay unavailable until the coordinate system and its units are known. A figure in an unknown unit is never labelled metres.',
    ],
    actionIds: ['tool.snapshot', 'tool.share', 'export.health', 'report.verify'],
    keywords: ['export', 'snapshot', 'session', 'provenance', 'crs', 'units', 'datum', 'report', 'verify', 'share'],
  },
  {
    id: 'scientific-states',
    title: 'Scientific states',
    summary: 'The words the app uses for how far a result can be trusted.',
    paragraphs: [
      'The app fails closed: when it cannot support a claim it says so instead of printing a number. These states appear on every panel, export and report with the same meaning.',
    ],
    terms: [
      ['Preview', 'Incomplete evidence, such as a streaming source that is not fully resident, a display sample of the points, or gaps in the footprint. The figure is shown with its reason and is not a measurement.'],
      ['Measured', 'The computation had sufficient permitted evidence for its declared scope.'],
      ['Review', 'A result exists, but one or more conditions ask for attention before it is relied on.'],
      ['Blocked', 'The app refuses the requested scientific claim; the reason names what is missing.'],
      ['Derived classification', 'Computed by the app with a heuristic, not supplied by the producer of the file. Validate before relying on it.'],
      ['Full source vs resident subset', 'The points currently visible or resident are not automatically the complete dataset; a resident-only analysis reads whatever is resident when it runs.'],
      ['CRS and units', 'Some measurements and exports stay unavailable until the coordinate system and its units are established; a figure is never dressed in a unit the file did not declare.'],
    ],
    keywords: ['preview', 'measured', 'review', 'blocked', 'derived', 'resident', 'full source', 'crs', 'units', 'trust', 'evidence', 'fail closed'],
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    summary: 'Every key the app answers to, from the binding table.',
    paragraphs: [
      'Shortcuts are suppressed while you type in a field. The shortcut sheet lists every action and its key; the rows below come from the same table the keys are dispatched from.',
    ],
    keywords: ['keyboard', 'shortcut', 'keys', 'hotkey', 'binding'],
  },
];

/** One action as Help lists it, from its own descriptor. */
export interface HelpActionRow {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly keys: string | undefined;
  readonly help: ActionDescriptor['help'];
}

/** The rows for a topic's actions, in the topic's order; unknown ids are skipped. */
export function helpActionRows(topic: HelpTopic, actions: readonly ActionDescriptor[]): HelpActionRow[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const rows: HelpActionRow[] = [];
  for (const id of topic.actionIds ?? []) {
    const a = byId.get(id);
    if (a) rows.push({ id: a.id, title: a.title, hint: a.hint ?? '', keys: a.keys, help: a.help });
  }
  return rows;
}

/** One keyboard row: the key and what it does, from the action or the binding's own line. */
export interface HelpKeyRow {
  readonly keys: string;
  readonly text: string;
}

/**
 * The keyboard rows: each dispatched or reserved binding once, described by
 * the action it fires when it fires one, else by its own help line.
 */
export function helpKeyRows(shortcuts: readonly ShortcutDescriptor[], actions: readonly ActionDescriptor[]): HelpKeyRow[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const rows: HelpKeyRow[] = [];
  for (const s of shortcuts) {
    if (!s.displayKeys) continue;
    const titles = s.actionIds.map((id) => byId.get(id)?.title).filter((t): t is string => !!t);
    const text = titles.length > 0 ? titles.join(' / ') : s.help;
    if (!text) continue;
    rows.push({ keys: s.displayKeys, text });
  }
  return rows;
}

/** The topics whose ids are referenced nowhere in the registry: the consistency test's subject. */
export function orphanActionReferences(actions: readonly ActionDescriptor[]): string[] {
  const ids = new Set(actions.map((a) => a.id));
  const orphans: string[] = [];
  for (const t of HELP_TOPICS) for (const id of t.actionIds ?? []) if (!ids.has(id)) orphans.push(`${t.id}: ${id}`);
  return orphans;
}

export interface HelpHit {
  readonly topic: HelpTopic;
  readonly score: number;
}

/**
 * Rank topics for a query: a title or keyword hit outranks a summary hit,
 * which outranks a hit in the prose, in a term or in a referenced action. Empty query: all
 * topics in catalogue order.
 */
export function searchHelp(query: string, actions: readonly ActionDescriptor[], topics: readonly HelpTopic[] = HELP_TOPICS): HelpHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return topics.map((topic) => ({ topic, score: 0 }));
  const byId = new Map(actions.map((a) => [a.id, a]));
  const has = (text: string | undefined): boolean => !!text && text.toLowerCase().includes(q);
  const hits: HelpHit[] = [];
  for (const topic of topics) {
    let score = 0;
    if (has(topic.title)) score += 8;
    if ((topic.keywords ?? []).some((k) => k.toLowerCase().includes(q))) score += 6;
    if (has(topic.summary)) score += 4;
    if (topic.paragraphs.some(has)) score += 2;
    if ((topic.terms ?? []).some(([term, text]) => has(term) || has(text))) score += 2;
    for (const id of topic.actionIds ?? []) {
      const a = byId.get(id);
      if (a && (has(a.title) || has(a.hint) || (a.keywords ?? []).some((k) => k.toLowerCase().includes(q)) || has(a.keys))) { score += 3; break; }
    }
    if (score > 0) hits.push({ topic, score });
  }
  return hits.sort((x, y) => y.score - x.score);
}

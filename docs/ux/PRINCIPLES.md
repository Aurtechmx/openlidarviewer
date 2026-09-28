# Interface principles

These are the rules OpenLiDARViewer's interface follows. They apply to every
surface, on desktop and phone. Rule IDs (`UX-D1` and so on) are how specs,
tests and pull requests refer to them. The community wayfinding requirements in
[COMMUNITY_SPEC.md](COMMUNITY_SPEC.md) implement a subset of these rules.

## Design intent

> At every moment the screen says where you are, how to get back, and what is
> true about the data. Every action has one name.

A point cloud viewer is used for long, spatial work. The user looks at the
scene most of the time and at controls some of the time. Controls exist to
serve the scene, and the interface is judged by how rarely the user has to
stop and work out where they are or whether a number can be trusted.

## Surface roles

Each surface answers one question. A control goes on the surface whose
question it answers.

| Surface | Question it answers | Holds |
| --- | --- | --- |
| Left rail | What do I want to do? | Task selection: modes and their pages |
| Context tool panel | How do I do the current task? | Settings, steps and result summary for the active task |
| Viewport | Where is it? | The scan, direct manipulation, spatial overlays |
| Right side | How is it drawn? | View settings today; a selection inspector in a later edition |
| Status strip | What must stay knowable? | Units, reference, data basis, processing state |
| Workspace page | This is now the task | Deep work: tables, charts, multi-step analysis |
| Modal | Answer this first | Short blocking decisions only |
| Tooltip | What is this, briefly? | Nonessential clarification only |

### Where does this go

1. It changes what the user is doing: left rail.
2. It configures the task that is active now: context tool panel.
3. It is a position, shape or thing in space: viewport.
4. It changes how the scan looks, not what it is: right side.
5. It is a fact the user must be able to check at any time: status strip.
6. It needs more room than a panel, or the user will spend minutes in it: workspace page.
7. The user must decide before anything else can happen, and the decision is short: modal.
8. The user can succeed without ever reading it: tooltip.

A surface people keep open while looking at the point cloud is not a modal.

## The five laws

1. **The sidebar selects the task; it does not become the task.** When work
   outgrows the rail, it moves to a workspace page.
2. **Show controls when they are relevant.** Controls for a task appear when
   the task is active and leave when it ends.
3. **Results belong to the workspace, not the tool.** Closing a tool never
   loses what it produced.
4. **Never make the user remember what the interface can keep visible.**
   Location, units, reference and active state stay on screen.
5. **Hide complexity, never validity.** Advanced settings may be one step
   away. A fact that changes whether a number can be trusted may not.

## House rules

### Density and disclosure

- **UX-D1 One dominant purpose per panel.** A panel that answers two
  questions is split or one question moves elsewhere.
- **UX-D2 One primary action per task state.** At most one primary button is
  visible in any state of a task.
- **UX-D3 Common visible, advanced one step, expert elsewhere.** Required and
  common controls are visible. Advanced controls sit behind one disclosure.
  Expert and method controls live on a workspace page or a methods view.
- **UX-D4 No nested accordions.**
- **UX-D5 Two disclosure levels at most** in any normal workflow.
- **UX-D6 Long homogeneous results become tables.** A list of more than a
  handful of rows of the same kind is a sortable table, not a stack of cards.
- **UX-D7 Comparison is simultaneous.** Things being compared are visible at
  the same time, not in alternating tabs.

### State and feedback

- **UX-D8 Selection, active tool and next click are unmistakable.** At any
  moment the user can tell what is selected, which tool is active, and what the
  next click in the viewport will do.
- **UX-D9 Tooltips never carry validity.** A caveat, warning or unit that
  affects interpretation is visible without hover.
- **UX-D10 Warning severity sets the surface.**

  | Level | Meaning | Example | Surface |
  | --- | --- | --- | --- |
  | 0 | Neutral status | `Streaming 4/12 nodes` | Status strip |
  | 1 | Local information | `Preview uses resident points only` | Inline beside the result or control |
  | 2 | Caution affecting interpretation | `Vertical reference is unconfirmed` | Persistent inline state, plus the strip |
  | 3 | Blocking scientific condition | No defensible result with the current data | Inline blocker; primary action disabled with its reason and a recovery step |
  | 4 | Irreversible or destructive | Discard saved work with no undo | Confirmation modal |

- **UX-D11 Microcopy follows task state.** Before the first click, one line
  on what the tool does. During capture, the next step only. After completion,
  the result and what to do with it.
- **UX-D12 Empty states name the next action.** An empty surface says what
  fills it and offers the one action that does. "No data" alone is not an
  empty state.
- **UX-D13 Preview and committed look different.** A provisional result is
  visually distinct from a committed one, and the difference does not rely on
  colour alone.

### Numbers

- **UX-D14 Display precision is not computed precision.** Formatters round for
  reading; computed and exported values keep their precision.
- **UX-D15 Units sit beside values**, joined by a non-breaking space, never
  only in a column header far away or a tooltip.
- **UX-D16 Comparable numbers use tabular figures** and align.

### Words and icons

- **UX-D17 Every action has one name.** Every surface that offers an action
  uses the same label, taken from the action registry.
- **UX-D18 Icons supplement labels.** An icon alone is acceptable only for a
  universally known action, and it still has an accessible name.
- **UX-D19 Text escalation ladder.** When copy grows, it moves up a step:
  label, then one line of helper text, then a details disclosure, then a help
  or methods view. Panels do not accumulate paragraphs.

### Structure

- **UX-D20 Separate mode from parameter.** Choosing what a tool does (mode)
  and tuning how it does it (parameter) are separate controls.
- **UX-D21 Separate source, view and analysis state.** What the data is
  (source), how it is drawn (view), and what was computed from it (analysis)
  live in different places and never alter each other silently.
- **UX-D22 Closing a panel never destroys state.** Panel open or closed is a
  layout choice; work survives it.
- **UX-D23 Motion only explains change.** Animation shows where something came
  from or went, or what a change caused. It is removed under
  `prefers-reduced-motion`.

### Novelty

- **UX-D24 Novelty budget.** A workflow introduces at most one unfamiliar
  concept. The entry and exit of a workflow are familiar (open, select, export,
  undo); the new idea sits in the core.
- **UX-D25 Innovate in domain verbs, not standard controls.** Buttons, menus,
  text fields, scroll and focus behave as the platform does. New interaction
  belongs in point-cloud work: measuring, sectioning, comparing, checking.
- **UX-D26 No uncertainty display without a defensible quantity.** A shading,
  band or badge that suggests uncertainty is shown only when a stated method
  backs the number behind it.

## Accessibility

- Pointer targets are at least 24 by 24 CSS px, per WCAG 2.2 success criterion
  2.5.8 (level AA). On touch viewports the house target is 44 by 44 CSS px.
  That larger size matches criterion 2.5.5, which is level AAA; the project
  does not claim AAA conformance.
- Every drag has a non-drag alternative (WCAG 2.2 criterion 2.5.7).
- Keyboard focus is always visible and never hidden behind a sticky surface.
- No critical content or action is reachable only on hover.
- State is exposed to assistive technology: pressed, expanded, selected,
  current location and busy states use the matching ARIA attributes, and
  route changes are announced once, politely.
- Colour is never the only carrier of state; glyphs and text back it up, and
  glyph-only renders are pairwise distinct.

## Review checklist

Before a change to a surface merges, check:

- [ ] Each new control sits on the surface whose question it answers.
- [ ] The panel still has one dominant purpose and at most one primary action per state.
- [ ] Nothing that affects validity moved behind hover or an extra disclosure.
- [ ] Every new label matches the action registry.
- [ ] Units sit beside values; numbers use tabular figures.
- [ ] Empty and error states name the next action.
- [ ] There is a visible, labelled way back, and Escape does the same.
- [ ] Targets, focus, non-drag alternatives and reduced motion are covered.
- [ ] The change spends no more than the workflow's novelty budget.

### The 3-second orientation test

Show a screenshot of the changed surface to someone who has not seen it for
three seconds. They should be able to say where they are in the application
and what data is open. If they cannot, the change needs a clearer location or
status.

### The return-after-interruption test

Leave the application mid-task, switch to something else, and come back. Without
clicking, it should be clear which task was active, what state it is in, and
what the next step is.

## Direction for later editions

**Not in 0.7.** The items below are directions, not commitments. None is
scheduled. Any claim that one of them is academically or legally novel needs a
prior-art review first.

- **Results as selectable objects.** A measurement, profile or contour set is
  an object in the scene with a name, a source, and a stale state when its
  inputs change.
- **Selection-driven inspector.** The right side shows the selected object's
  properties and validity; view settings move to their own surface.
- **Local truth lens.** A movable region in the viewport that shows density,
  classification or validity for the points under it, without changing the
  global view.
- **Linked selection.** Selecting in 3D, a profile, a histogram or a table
  highlights the same points in the others.
- **Sensitivity preview as interaction.** Dragging a parameter shows how the
  result would change before it is committed.
- **Spatial provenance.** Where a result came from is shown in space: the
  points, extent and filters it used.
- **Compare everywhere.** Comparison as a verb available on any pair of
  compatible results.
- **Spatial history and ghost states.** Earlier states of a result stay
  visible as faint outlines, so change is seen rather than remembered.
- **Command palette aliases.** The palette accepts the words people use for an
  action, not only its registry name.

## Sources

These principles draw on public guidance, adapted to point-cloud work:

- Nielsen's ten usability heuristics, especially visibility of system status,
  recognition rather than recall, and consistency.
- Shneiderman's visual information seeking mantra (overview first, zoom and
  filter, details on demand) and his work on direct manipulation.
- WCAG 2.2, for target size, focus, dragging and state exposure.
- The major platforms' human interface guidelines, on alerts, modality and
  motion.
- Public design systems, on disclosure, empty states, tables and copy length.
- The User Experience Questionnaire (UEQ), for measuring perceived clarity and
  efficiency before and after a change.

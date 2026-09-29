/**
 * viewRail.ts
 *
 * The right rail as View (spec CE-1, section 8): a one-line subtitle under its
 * title, shared with the phone's View tab, and a link row that points two-epoch
 * change detection at Analyse. The rail itself (`Inspector`) keeps its ids,
 * classes, storage keys and module name; this only adds the two lines, so the
 * rail's own module does not grow.
 */
import { el } from '../../ui/dom';
import { VIEW_SUBTITLE } from '../../ui/MobileSheet';

export function decorateViewRail(root: HTMLElement, openAnalyse: () => void): void {
  if (root.querySelector('.olv-view-subtitle')) return;
  root.querySelector('.olv-panel-head')?.after(el('p', { className: 'olv-view-subtitle', text: VIEW_SUBTITLE }));
  const link = el('button', {
    className: 'olv-view-link',
    type: 'button',
    text: 'Two-epoch change detection → Analyse',
    tip: 'Change detection is an analysis. Its controls stay beside the layers in Data.',
  });
  link.addEventListener('click', openAnalyse);
  root.querySelector('.olv-view-save')?.closest('details')?.after(link);
}

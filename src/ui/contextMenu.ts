/**
 * contextMenu.ts — a tiny, lazy-loaded right-click menu for the 3-D canvas.
 *
 * Lazy on purpose: the menu is only built the first time the user right-clicks,
 * so none of this ships in the startup shell. Styling is inline (themed through
 * the app's CSS custom properties) so the module is fully self-contained and
 * adds nothing to the eager stylesheet. Inline `style` attributes are permitted
 * by the app CSP (style-src allows unsafe-inline); no inline <script> is used.
 */

import { el } from './dom';

export interface ContextMenuItem {
  readonly label: string;
  readonly run: () => void;
  /** Greyed-out, non-actionable (e.g. an action that can't apply right now). */
  readonly disabled?: boolean;
}

let openMenu: HTMLElement | null = null;
let dismiss: (() => void) | null = null;

/** Close any open context menu and detach its global listeners. */
export function closeContextMenu(): void {
  dismiss?.();
}

/**
 * Show a context menu at viewport coordinates (clientX/clientY). Re-opening
 * replaces any menu already on screen. The menu dismisses on outside
 * pointerdown, Escape, scroll, blur, or after an item runs.
 */
export function showContextMenu(clientX: number, clientY: number, items: ContextMenuItem[]): void {
  closeContextMenu();
  if (items.length === 0) return;

  const menu = el('div', { className: 'olv-ctxmenu' });
  menu.setAttribute('role', 'menu');
  menu.style.cssText = [
    'position:fixed',
    'z-index:9000',
    'min-width:168px',
    'padding:6px',
    'border-radius:10px',
    'background:var(--panel,#1b1b1f)',
    'border:1px solid var(--hairline,rgba(255,255,255,0.12))',
    'box-shadow:0 12px 32px rgba(0,0,0,0.4)',
    'font:13px/1.4 var(--ui-font,system-ui,sans-serif)',
    'color:var(--text,#e7e7ea)',
    // Off-screen until measured, so the clamp below has real dimensions.
    'left:-9999px',
    'top:-9999px',
  ].join(';');

  for (const item of items) {
    const row = el('button', {
      className: 'olv-ctxmenu-item',
      text: item.label,
    }) as HTMLButtonElement;
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.disabled = !!item.disabled;
    row.style.cssText = [
      'display:block',
      'width:100%',
      'text-align:left',
      'padding:7px 10px',
      'border:0',
      'border-radius:6px',
      'background:transparent',
      'color:inherit',
      'font:inherit',
      item.disabled ? 'opacity:0.45' : 'cursor:pointer',
    ].join(';');
    if (!item.disabled) {
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--accent-soft)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = 'transparent';
      });
      row.addEventListener('click', () => {
        closeContextMenu();
        item.run();
      });
    }
    menu.append(row);
  }

  document.body.append(menu);
  openMenu = menu;

  // Clamp inside the viewport now that the menu has a measured size.
  const { width, height } = menu.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - width - 8);
  const y = Math.min(clientY, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  const onPointerDown = (e: PointerEvent): void => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeContextMenu();
    }
  };
  const onScrollOrBlur = (): void => closeContextMenu();

  dismiss = (): void => {
    menu.remove();
    if (openMenu === menu) openMenu = null;
    dismiss = null;
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onScrollOrBlur);
    window.removeEventListener('wheel', onScrollOrBlur, true);
  };

  // `true` capture so the first outside click both dismisses and is not
  // swallowed by other handlers; deferred a tick so the opening click that
  // triggered this menu doesn't immediately close it.
  setTimeout(() => {
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onScrollOrBlur);
    window.addEventListener('wheel', onScrollOrBlur, true);
  }, 0);
}

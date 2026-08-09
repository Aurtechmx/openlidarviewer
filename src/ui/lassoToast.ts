/**
 * lassoToast.ts — the app's transient toast channel, lifted out of the
 * composition root.
 *
 * A single self-contained toast that owns its own DOM node and dismiss timer:
 * the only feedback channel for several flows (tool hints, rejected opens, save
 * prompts). {@link createLassoToast} returns one `show(message, action?)` the
 * shell binds as `showLassoToast` and hands to the panels / action registry, so
 * every call site is unchanged. No subsystem dependencies — it needs only the
 * DOM.
 */

/** An optional action button rendered beside the message. */
export interface LassoToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface LassoToast {
  /** Show a message, replacing any current toast; an action extends the dwell. */
  show(message: string, action?: LassoToastAction): void;
}

/** Create the toast controller. It lazily mounts its node on first show. */
export function createLassoToast(): LassoToast {
  let el: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    show(message, action) {
      if (timer !== null) clearTimeout(timer);
      if (el === null) {
        el = document.createElement('div');
        el.className = 'olv-lasso-toast';
        // Announce toast text to assistive tech — these toasts are the only
        // feedback channel for several flows (tool hints, rejected opens).
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.append(el);
      }
      // Rebuild contents from scratch each call so an info toast cleanly
      // replaces a previous action toast (no stale Save button stuck around).
      el.replaceChildren();
      const messageEl = document.createElement('span');
      messageEl.className = 'olv-lasso-toast-msg';
      messageEl.textContent = message;
      el.append(messageEl);
      if (action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'olv-lasso-toast-action';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          btn.blur();
          action.onClick();
        });
        el.append(btn);
      }
      el.classList.add('olv-visible');
      const node = el;
      timer = setTimeout(() => { node.classList.remove('olv-visible'); }, action ? 8000 : 6000);
    },
  };
}

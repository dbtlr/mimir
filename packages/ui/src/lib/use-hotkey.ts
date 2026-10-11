import { useEffect, useEffectEvent } from 'react';

/** Focus that owns text entry — a bare hotkey must not steal a keystroke from it. */
function isEditableTarget(el: Element | null): boolean {
  if (el === null) {
    return false;
  }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Focus on a popup role that owns single-letter typeahead (base-ui menu/select/combobox). */
function isPopupTarget(el: Element | null): boolean {
  if (el === null) {
    return false;
  }
  const role = el.getAttribute('role');
  return role === 'menuitem' || role === 'option' || role === 'combobox';
}

/** Any open dialog, menu, or listbox — base-ui mounts each with its ARIA role while open. */
function hasOpenPopup(): boolean {
  return document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

/**
 * A single global, unmodified-key hotkey (MMR-247) — the `s` capture trigger.
 * Guarded so a bare letter never hijacks typing or stacks over a modal or popup:
 * ignores the key when focus is in an input / textarea / select / contenteditable,
 * when focus is on a menu/select/combobox item, when any modifier is held, and
 * when another dialog, menu, or listbox is already open. The handler is an
 * effect event, so a fresh closure each render never re-binds the listener.
 */
export function useHotkey(
  key: string,
  handler: () => void,
  opts: { enabled?: boolean } = {},
): void {
  const enabled = opts.enabled ?? true;
  const onHotkey = useEffectEvent(handler);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== key) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      if (isEditableTarget(document.activeElement)) {
        return;
      }
      if (isPopupTarget(document.activeElement)) {
        return;
      }
      if (hasOpenPopup()) {
        return;
      }
      e.preventDefault();
      onHotkey();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [key, enabled]);
}

/** A Mac or iOS browser, where the command chord is ⌘ rather than Ctrl. */
export const IS_APPLE =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * A global command chord (MMR-455) — the ⌘K palette opener: ⌘ on a Mac, Ctrl
 * elsewhere, so a Mac keeps Ctrl-K's delete-to-end-of-line in text fields.
 * Unlike a bare hotkey it fires from inside a text field, since the modifier
 * means no keystroke is being typed; it still yields to an already-open
 * dialog, menu, or listbox. `code` names the physical key (`KeyK`), so the
 * chord works on any keyboard layout.
 */
export function useCommandHotkey(
  code: string,
  handler: () => void,
  opts: { enabled?: boolean } = {},
): void {
  const enabled = opts.enabled ?? true;
  const onHotkey = useEffectEvent(handler);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    function onKeyDown(e: KeyboardEvent): void {
      const command = IS_APPLE ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (e.code !== code || !command || e.altKey || e.shiftKey) {
        return;
      }
      if (hasOpenPopup()) {
        return;
      }
      e.preventDefault();
      onHotkey();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [code, enabled]);
}

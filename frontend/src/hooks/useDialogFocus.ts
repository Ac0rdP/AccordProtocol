import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Keyboard behaviour for an open modal dialog:
 * - moves focus into the dialog when it opens,
 * - traps Tab / Shift+Tab inside it,
 * - closes on Escape,
 * - returns focus to whatever was focused before it opened.
 *
 * Key events are stopped at the dialog so app-wide single-key shortcuts
 * (N, R, Cmd+K) never fire underneath an open dialog.
 */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialogRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? node)?.focus();

    return () => {
      if (previouslyFocused && document.body.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
    event.stopPropagation();

    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }

    if (event.key !== "Tab") return;

    const node = dialogRef.current;
    if (!node) return;
    const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }

    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === firstItem || active === node)) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && active === lastItem) {
      event.preventDefault();
      firstItem.focus();
    }
  }, []);

  return { dialogRef, onKeyDown };
}

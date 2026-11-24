import { useEffect } from 'react';

const directions: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};
const selectors = 'button, input, select, textarea, summary, a[href]';

function visibleControls(root: ParentNode, selector = selectors) {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (control) => !control.matches(':disabled,[aria-disabled="true"]') && control.getClientRects().length > 0,
  );
}

export function useCajaKeyboard() {
  useEffect(() => {
    const root = document.getElementById('caja-app');
    if (!root) return;

    function handle(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !root) return;
      const target = event.target instanceof HTMLElement ? event.target : document.body;
      if (target !== document.body && !root.contains(target)) return;

      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
        if (target.closest('button')) event.preventDefault();
        return;
      }
      const shortcut = event.key === 'F2' ? '[data-key-search]' :
        event.key === 'F4' ? '[data-key-checkout]' : event.key === 'Escape' ? '[data-key-cancel]' : '';
      if (shortcut) {
        const [control] = visibleControls(root, shortcut);
        if (control) {
          event.preventDefault();
          if (event.key === 'F2') {
            control.focus();
            if (control instanceof HTMLInputElement) control.select();
          } else control.click();
        }
        return;
      }

      const direction = directions[event.key];
      if (!direction || target.closest('input,select,textarea,[contenteditable]')) return;
      const current = target.closest<HTMLElement>(selectors);
      if (!current) {
        const [first] = visibleControls(root, '[data-main-nav] button[aria-pressed="true"]');
        if (first) { event.preventDefault(); first.focus(); }
        return;
      }
      if (current.closest('[data-main-nav]') && direction[0] !== 0) {
        const navigation = visibleControls(root, '[data-main-nav] button');
        const next = navigation[navigation.indexOf(current) + direction[0]];
        if (next) { event.preventDefault(); next.focus(); }
        return;
      }
      const source = current.getBoundingClientRect();
      const x = source.left + source.width / 2;
      const y = source.top + source.height / 2;
      const [dx, dy] = direction;
      const scope = current.closest('[data-key-scope]') ?? root;
      const candidates = visibleControls(scope).filter((control) => control !== current &&
        (!current.closest('[data-main-nav]') || !control.closest('[data-main-nav]')));
      let best: { control: HTMLElement; score: number } | undefined;
      for (const control of candidates) {
        const rect = control.getBoundingClientRect();
        const ox = rect.left + rect.width / 2 - x;
        const oy = rect.top + rect.height / 2 - y;
        const forward = ox * dx + oy * dy;
        if (forward <= 4) continue;
        const overlap = dx
          ? Math.min(rect.bottom, source.bottom) - Math.max(rect.top, source.top)
          : Math.min(rect.right, source.right) - Math.max(rect.left, source.left);
        const perpendicular = Math.abs(ox * dy + oy * dx);
        const score = forward + perpendicular * (overlap > 0 ? 0.65 : 3);
        if (!best || score < best.score) best = { control, score };
      }
      if (best) {
        event.preventDefault();
        best.control.focus();
      }
    }
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, []);
}

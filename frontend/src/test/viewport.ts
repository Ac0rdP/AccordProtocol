/**
 * Viewport widths the feature-expansion acceptance criteria call out:
 * small phone, tablet, and desktop.
 */
export const ACCEPTANCE_VIEWPORTS = [375, 768, 1440] as const;

/**
 * Resizes the jsdom window. jsdom does no layout, so this exercises
 * width-dependent logic and documents intent; real layout at these widths is
 * covered by Storybook / Playwright.
 */
export function setViewport(width: number, height = 900): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

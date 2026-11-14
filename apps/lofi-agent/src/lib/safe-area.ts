/**
 * The screen's safe area, for positioning popovers. React Aria keeps a
 * popover inside its `boundaryElement`, by default the whole viewport,
 * which covers the status bar and home indicator now that the page fills
 * the screen (viewport-fit=cover): a tall popover opened under the status
 * bar. The boundary is an invisible fixed box inset by the safe area,
 * rendered in the root document (src/routes/__root.tsx) so it's in the
 * prerendered page too. On screens without a safe area it's the viewport.
 */
export const SAFE_AREA_ID = "safe-area"

/** The safe area's box, for a popover's `boundaryElement`; none on the server. */
export const safeAreaBoundary = (): Element | undefined =>
  (typeof document === "undefined"
    ? null
    : document.getElementById(SAFE_AREA_ID)) ?? undefined

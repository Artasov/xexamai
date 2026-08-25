export type SelectionPoint = {
  x: number;
  y: number;
};

export type PixelSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type NormalizedSelection = PixelSelection;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function createPixelSelection(
  start: SelectionPoint,
  end: SelectionPoint,
  viewportWidth: number,
  viewportHeight: number,
): PixelSelection {
  const startX = clamp(start.x, 0, viewportWidth);
  const startY = clamp(start.y, 0, viewportHeight);
  const endX = clamp(end.x, 0, viewportWidth);
  const endY = clamp(end.y, 0, viewportHeight);
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function normalizeSelection(
  selection: PixelSelection,
  viewportWidth: number,
  viewportHeight: number,
  minimumSize = 6,
): NormalizedSelection | null {
  if (
    ![selection.x, selection.y, selection.width, selection.height].every(Number.isFinite) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    !Number.isFinite(minimumSize) ||
    minimumSize < 0
  ) {
    return null;
  }

  const left = clamp(selection.x, 0, viewportWidth);
  const top = clamp(selection.y, 0, viewportHeight);
  const right = clamp(selection.x + selection.width, 0, viewportWidth);
  const bottom = clamp(selection.y + selection.height, 0, viewportHeight);
  const width = right - left;
  const height = bottom - top;
  if (width < minimumSize || height < minimumSize) return null;

  return {
    x: left / viewportWidth,
    y: top / viewportHeight,
    width: width / viewportWidth,
    height: height / viewportHeight,
  };
}

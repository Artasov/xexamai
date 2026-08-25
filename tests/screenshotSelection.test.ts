import { describe, expect, it } from "vitest";
import {
  createPixelSelection,
  normalizeSelection,
} from "../src/renderer/screenshot/selection";

describe("screenshot area selection", () => {
  it("supports dragging in any direction", () => {
    expect(createPixelSelection({ x: 800, y: 600 }, { x: 200, y: 100 }, 1000, 700))
      .toEqual({ x: 200, y: 100, width: 600, height: 500 });
  });

  it("clamps pointer coordinates to the monitor viewport", () => {
    expect(createPixelSelection({ x: -20, y: 50 }, { x: 1200, y: 900 }, 1000, 700))
      .toEqual({ x: 0, y: 50, width: 1000, height: 650 });
  });

  it("normalizes CSS pixels independently of monitor DPI", () => {
    expect(normalizeSelection({ x: 100, y: 50, width: 400, height: 300 }, 1000, 600))
      .toEqual({ x: 0.1, y: 1 / 12, width: 0.4, height: 0.5 });
  });

  it("ignores accidental clicks and tiny drags", () => {
    expect(normalizeSelection({ x: 100, y: 100, width: 4, height: 80 }, 1000, 600))
      .toBeNull();
  });

  it("rejects non-finite geometry instead of passing null-like values to native IPC", () => {
    expect(normalizeSelection({ x: Number.NaN, y: 0, width: 100, height: 100 }, 1000, 600))
      .toBeNull();
    expect(normalizeSelection({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }, 1000, 600))
      .toBeNull();
  });

  it("clips externally supplied geometry to the viewport", () => {
    expect(normalizeSelection({ x: 900, y: 500, width: 300, height: 300 }, 1000, 600))
      .toEqual({ x: 0.9, y: 5 / 6, width: 0.1, height: 1 / 6 });
  });
});

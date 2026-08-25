import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invokeNative } from "../bridge/nativeInvoke";
import {
  createPixelSelection,
  normalizeSelection,
  type PixelSelection,
  type SelectionPoint,
} from "./selection";

const DIM_COLOR = "rgba(4, 5, 12, 0.66)";
const BORDER_COLOR = "rgba(217, 204, 255, 0.98)";
const ACCENT_COLOR = "rgba(167, 122, 255, 1)";

type ScreenshotBootstrapWindow = Window & {
  __XEXAMAI_SCREEN_CAPTURE_SESSION_ID__?: number;
};

function readBootstrapSessionId(): number | null {
  const value = (window as ScreenshotBootstrapWindow)
    .__XEXAMAI_SCREEN_CAPTURE_SESSION_ID__;
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= 0x3fffffff
    ? value
    : null;
}

export function ScreenshotOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const anchorRef = useRef<SelectionPoint | null>(null);
  const selectionRef = useRef<PixelSelection | null>(null);
  const sessionIdRef = useRef<number | null>(readBootstrapSessionId());
  const submittingRef = useRef(false);
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const physicalWidth = Math.max(1, Math.round(width * dpr));
    const physicalHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== physicalWidth || canvas.height !== physicalHeight) {
      canvas.width = physicalWidth;
      canvas.height = physicalHeight;
    }

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = DIM_COLOR;
    context.fillRect(0, 0, width, height);

    const selection = selectionRef.current;
    if (!selection || selection.width < 1 || selection.height < 1) return;

    context.clearRect(
      selection.x,
      selection.y,
      selection.width,
      selection.height,
    );
    context.strokeStyle = BORDER_COLOR;
    context.lineWidth = 1.5;
    context.strokeRect(
      selection.x + 0.75,
      selection.y + 0.75,
      Math.max(0, selection.width - 1.5),
      Math.max(0, selection.height - 1.5),
    );

    const corner = Math.min(18, selection.width / 3, selection.height / 3);
    context.strokeStyle = ACCENT_COLOR;
    context.lineWidth = 3;
    context.lineCap = "round";
    for (const [x, y, horizontal, vertical] of [
      [selection.x, selection.y, 1, 1],
      [selection.x + selection.width, selection.y, -1, 1],
      [selection.x, selection.y + selection.height, 1, -1],
      [selection.x + selection.width, selection.y + selection.height, -1, -1],
    ] as const) {
      context.beginPath();
      context.moveTo(x + horizontal * corner, y);
      context.lineTo(x, y);
      context.lineTo(x, y + vertical * corner);
      context.stroke();
    }

    const label = `${Math.round(selection.width * dpr)} × ${Math.round(selection.height * dpr)}`;
    context.font = "600 12px Inter, Segoe UI, sans-serif";
    const labelWidth = Math.ceil(context.measureText(label).width) + 16;
    const labelHeight = 25;
    const labelX = Math.min(
      Math.max(8, selection.x + selection.width / 2 - labelWidth / 2),
      Math.max(8, width - labelWidth - 8),
    );
    const preferredTop = selection.y - labelHeight - 8;
    const labelY = preferredTop >= 8
      ? preferredTop
      : Math.min(height - labelHeight - 8, selection.y + selection.height + 8);
    context.fillStyle = "rgba(13, 13, 22, 0.92)";
    if (typeof context.roundRect === "function") {
      context.beginPath();
      context.roundRect(labelX, labelY, labelWidth, labelHeight, 8);
      context.fill();
    } else {
      context.fillRect(labelX, labelY, labelWidth, labelHeight);
    }
    context.fillStyle = "rgba(247, 244, 255, 0.96)";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2 + 0.5);
  }, []);

  const finish = useCallback(async (region: ReturnType<typeof normalizeSelection>) => {
    const sessionId = sessionIdRef.current;
    if (!readyRef.current || sessionId === null || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setErrorMessage("");
    try {
      await invokeNative("screen_capture_finish", { sessionId, region });
    } catch (error) {
      submittingRef.current = false;
      setSubmitting(false);
      setErrorMessage(
        error instanceof Error ? error.message : "Could not capture the selected area",
      );
    }
  }, []);

  const cancel = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!readyRef.current || sessionId === null || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await invokeNative("screen_capture_cancel", { sessionId });
    } catch (error) {
      submittingRef.current = false;
      setSubmitting(false);
      setErrorMessage(
        error instanceof Error ? error.message : "Could not close screen capture",
      );
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const handleResize = () => draw();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeyDown);
    draw();
    const sessionId = sessionIdRef.current;
    if (sessionId === null) {
      setErrorMessage("Could not identify the screen capture session");
      return () => {
        disposed = true;
        readyRef.current = false;
        window.removeEventListener("resize", handleResize);
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
    void invokeNative("screen_capture_overlay_ready", { sessionId })
      .then(() => {
        if (disposed) return;
        readyRef.current = true;
        setReady(true);
      })
      .catch((error) => {
        if (disposed) return;
        setErrorMessage(
          error instanceof Error ? error.message : "Could not initialize screen capture",
        );
      });
    return () => {
      disposed = true;
      readyRef.current = false;
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancel, draw]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => ({
    x: event.clientX,
    y: event.clientY,
  });

  const updateSelection = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): PixelSelection | null => {
    const anchor = anchorRef.current;
    if (!anchor) return null;
    const selection = createPixelSelection(
      anchor,
      pointFromEvent(event),
      window.innerWidth,
      window.innerHeight,
    );
    selectionRef.current = selection;
    draw();
    return selection;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !readyRef.current || submittingRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    anchorRef.current = pointFromEvent(event);
    selectionRef.current = createPixelSelection(
      anchorRef.current,
      anchorRef.current,
      window.innerWidth,
      window.innerHeight,
    );
    draw();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!anchorRef.current || submittingRef.current) return;
    updateSelection(event);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !anchorRef.current || submittingRef.current) return;
    event.preventDefault();
    const selection = updateSelection(event);
    anchorRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!selection) return;
    const normalized = normalizeSelection(
      selection,
      window.innerWidth,
      window.innerHeight,
    );
    if (!normalized) {
      selectionRef.current = null;
      draw();
      return;
    }
    void finish(normalized);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    anchorRef.current = null;
    selectionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draw();
  };

  return (
    <main className="screenshot-overlay" aria-label="Select an area to capture">
      <canvas
        ref={canvasRef}
        className="screenshot-overlay__canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(event) => {
          event.preventDefault();
          void cancel();
        }}
      />

      <section className="screenshot-overlay__toolbar" aria-label="Screenshot controls">
        <div className="screenshot-overlay__hint">
          <span className="screenshot-overlay__crosshair" aria-hidden="true" />
          <span>{submitting ? "Capturing…" : ready ? "Drag to select an area" : "Preparing…"}</span>
          <kbd>Esc</kbd>
        </div>
        <span className="screenshot-overlay__divider" aria-hidden="true" />
        <button
          className="screenshot-overlay__button"
          type="button"
          disabled={submitting || !ready}
          title="Capture the entire screen"
          onClick={() => void finish(null)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
          </svg>
          Full screen
        </button>
        <button
          className="screenshot-overlay__close"
          type="button"
          disabled={submitting || !ready}
          aria-label="Cancel screenshot"
          title="Cancel (Esc)"
          onClick={() => void cancel()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
      </section>

      {errorMessage ? (
        <div className="screenshot-overlay__error" role="alert">
          {errorMessage}
        </div>
      ) : null}
    </main>
  );
}

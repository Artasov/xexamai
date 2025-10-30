import { useCallback, useEffect, useMemo, useRef } from 'react';
import './WindowResizer.scss';

type Edge =
    | 'top'
    | 'bottom'
    | 'left'
    | 'right'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right';

type Bounds = { x: number; y: number; width: number; height: number };

const MIN_WIDTH = 400;
const MIN_HEIGHT = 500;

const EDGE_CONFIG: Array<{
    edge: Edge;
    className: string;
    cursor: string;
}> = [
    { edge: 'top', className: 'resize-handle resize-handle--top', cursor: 'ns-resize' },
    { edge: 'bottom', className: 'resize-handle resize-handle--bottom', cursor: 'ns-resize' },
    { edge: 'left', className: 'resize-handle resize-handle--left', cursor: 'ew-resize' },
    { edge: 'right', className: 'resize-handle resize-handle--right', cursor: 'ew-resize' },
    { edge: 'top-left', className: 'resize-handle resize-handle--top-left', cursor: 'nwse-resize' },
    { edge: 'top-right', className: 'resize-handle resize-handle--top-right', cursor: 'nesw-resize' },
    { edge: 'bottom-left', className: 'resize-handle resize-handle--bottom-left', cursor: 'nesw-resize' },
    { edge: 'bottom-right', className: 'resize-handle resize-handle--bottom-right', cursor: 'nwse-resize' },
];

type ResizeState = {
    edge: Edge;
    startX: number;
    startY: number;
    startBounds: Bounds | null;
};

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

export const WindowResizer = () => {
    const stateRef = useRef<ResizeState | null>(null);
    const pendingBoundsRef = useRef<Bounds | null>(null);
    const frameRequestedRef = useRef(false);

    const requestBoundsUpdate = useCallback((bounds: Bounds) => {
        pendingBoundsRef.current = bounds;
        if (frameRequestedRef.current) return;
        frameRequestedRef.current = true;
        requestAnimationFrame(async () => {
            frameRequestedRef.current = false;
            const target = pendingBoundsRef.current;
            if (target) {
                pendingBoundsRef.current = null;
                await window.api.window.setBounds(target);
            }
        });
    }, []);

    const computeBounds = useCallback((edge: Edge, startBounds: Bounds, dx: number, dy: number): Bounds => {
        let { x, y, width, height } = startBounds;

        const adjustWidthFromLeft = edge.includes('left');
        const adjustWidthFromRight = edge.includes('right');
        const adjustHeightFromTop = edge.includes('top');
        const adjustHeightFromBottom = edge.includes('bottom');

        if (adjustWidthFromRight) {
            width = Math.max(MIN_WIDTH, startBounds.width + dx);
        }

        if (adjustWidthFromLeft) {
            const nextWidth = Math.max(MIN_WIDTH, startBounds.width - dx);
            const delta = startBounds.width - nextWidth;
            width = nextWidth;
            x = startBounds.x + delta;
        }

        if (adjustHeightFromBottom) {
            height = Math.max(MIN_HEIGHT, startBounds.height + dy);
        }

        if (adjustHeightFromTop) {
            const nextHeight = Math.max(MIN_HEIGHT, startBounds.height - dy);
            const delta = startBounds.height - nextHeight;
            height = nextHeight;
            y = startBounds.y + delta;
        }

        return {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
        };
    }, []);

    const stopResizing = useCallback(() => {
        stateRef.current = null;
        pendingBoundsRef.current = null;
        frameRequestedRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }, []);

    useEffect(() => {
        if (!isWindows) return () => {};

        const handleMouseMove = (event: MouseEvent) => {
            const state = stateRef.current;
            if (!state || !state.startBounds) return;

            const dx = event.screenX - state.startX;
            const dy = event.screenY - state.startY;
            if (dx === 0 && dy === 0) return;

            const next = computeBounds(state.edge, state.startBounds, dx, dy);
            requestBoundsUpdate(next);
        };

        const handleMouseUp = () => {
            stopResizing();
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [computeBounds, requestBoundsUpdate, stopResizing]);

    const handleMouseDown = useCallback((edge: Edge) => async (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (!isWindows) return;

        document.body.style.cursor = (EDGE_CONFIG.find((item) => item.edge === edge)?.cursor) ?? '';
        document.body.style.userSelect = 'none';

        stateRef.current = {
            edge,
            startX: event.screenX,
            startY: event.screenY,
            startBounds: null,
        };

        try {
            const bounds = await window.api.window.getBounds();
            const state = stateRef.current;
            if (state && !state.startBounds) {
                state.startBounds = bounds ?? null;
            }
        } catch {
            stopResizing();
        }
    }, [stopResizing]);

    const handles = useMemo(() => EDGE_CONFIG.map((config) => (
        <div
            key={config.edge}
            className={config.className}
            role="presentation"
            onMouseDown={handleMouseDown(config.edge)}
            style={{ cursor: config.cursor }}
        />
    )), [handleMouseDown]);

    if (!isWindows) {
        return null;
    }

    return (
        <div className="window-resize-handles" aria-hidden>
            {handles}
        </div>
    );
};

export default WindowResizer;

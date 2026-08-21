import {type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef} from 'react';
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
}> = [
    {edge: 'top', className: 'resize-handle resize-handle--top'},
    {edge: 'bottom', className: 'resize-handle resize-handle--bottom'},
    {edge: 'left', className: 'resize-handle resize-handle--left'},
    {edge: 'right', className: 'resize-handle resize-handle--right'},
    {edge: 'top-left', className: 'resize-handle resize-handle--top-left'},
    {edge: 'top-right', className: 'resize-handle resize-handle--top-right'},
    {edge: 'bottom-left', className: 'resize-handle resize-handle--bottom-left'},
    {edge: 'bottom-right', className: 'resize-handle resize-handle--bottom-right'},
];

type ResizeState = {
    edge: Edge;
    startX: number;
    startY: number;
    startBounds: Bounds | null;
    pointerId: number;
    captureTarget: HTMLDivElement;
};

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

export const WindowResizer = () => {
    const stateRef = useRef<ResizeState | null>(null);
    const pendingBoundsRef = useRef<Bounds | null>(null);
    const applyingBoundsRef = useRef(false);

    const requestBoundsUpdate = useCallback((bounds: Bounds) => {
        pendingBoundsRef.current = bounds;
        if (applyingBoundsRef.current) return;

        applyingBoundsRef.current = true;
        void (async () => {
            try {
                // Keep only the newest mouse position while a native resize is in
                // flight, but never let older async calls overtake newer ones.
                while (pendingBoundsRef.current) {
                    const target = pendingBoundsRef.current;
                    pendingBoundsRef.current = null;
                    await window.api.window.setBounds(target);
                }
            } finally {
                applyingBoundsRef.current = false;
            }
        })();
    }, []);

    const computeBounds = useCallback((edge: Edge, startBounds: Bounds, dx: number, dy: number): Bounds => {
        let {x, y, width, height} = startBounds;

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
        const state = stateRef.current;
        if (state?.captureTarget.hasPointerCapture(state.pointerId)) {
            state.captureTarget.releasePointerCapture(state.pointerId);
        }
        stateRef.current = null;
        document.body.style.userSelect = '';
    }, []);

    useEffect(() => {
        if (!isWindows) return () => {
        };

        const handlePointerMove = (event: globalThis.PointerEvent) => {
            const state = stateRef.current;
            if (!state || state.pointerId !== event.pointerId || !state.startBounds) return;

            const dx = event.screenX - state.startX;
            const dy = event.screenY - state.startY;
            if (dx === 0 && dy === 0) return;

            const next = computeBounds(state.edge, state.startBounds, dx, dy);
            requestBoundsUpdate(next);
        };

        const handlePointerEnd = (event: globalThis.PointerEvent) => {
            if (stateRef.current?.pointerId !== event.pointerId) return;
            stopResizing();
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerEnd);
        window.addEventListener('pointercancel', handlePointerEnd);

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerEnd);
            window.removeEventListener('pointercancel', handlePointerEnd);
        };
    }, [computeBounds, requestBoundsUpdate, stopResizing]);

    const handlePointerDown = useCallback((edge: Edge) => async (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (!isWindows) return;

        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.userSelect = 'none';

        stateRef.current = {
            edge,
            startX: event.screenX,
            startY: event.screenY,
            startBounds: null,
            pointerId: event.pointerId,
            captureTarget: event.currentTarget,
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

    if (!isWindows) {
        return null;
    }

    return (
        <div className="window-resize-handles" aria-hidden>
            {EDGE_CONFIG.map((config) => (
                <div
                    key={config.edge}
                    className={config.className}
                    role="presentation"
                    onPointerDown={handlePointerDown(config.edge)}
                />
            ))}
        </div>
    );
};

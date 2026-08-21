import {useEffect, useState} from 'react';

const FONT_SIZE_KEY = 'xexamai-answer-font-size';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 14;

export function clampAnswerFontSize(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE;
    return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)));
}

function readFontSize(): number {
    try {
        const saved = Number.parseInt(window.localStorage.getItem(FONT_SIZE_KEY) || '', 10);
        return clampAnswerFontSize(saved);
    } catch {
        return DEFAULT_FONT_SIZE;
    }
}

function applyFontSize(value: number): void {
    document.documentElement.style.setProperty('--answer-font-size', `${value}px`);
    try {
        window.localStorage.setItem(FONT_SIZE_KEY, String(value));
    } catch {
    }
}

/** Owns the authenticated Ctrl+wheel answer-size interaction. */
export function useAnswerFontSize(): number | null {
    const [notice, setNotice] = useState<number | null>(null);

    useEffect(() => {
        const previous = document.documentElement.style.getPropertyValue('--answer-font-size');
        let current = readFontSize();
        let hideTimer: ReturnType<typeof setTimeout> | null = null;
        applyFontSize(current);

        const handleWheel = (event: WheelEvent) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            current = clampAnswerFontSize(current + (event.deltaY > 0 ? -1 : 1));
            applyFontSize(current);
            setNotice(current);
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => setNotice(null), 2_300);
        };

        document.addEventListener('wheel', handleWheel, {passive: false});
        return () => {
            document.removeEventListener('wheel', handleWheel);
            if (hideTimer) clearTimeout(hideTimer);
            if (previous) document.documentElement.style.setProperty('--answer-font-size', previous);
            else document.documentElement.style.removeProperty('--answer-font-size');
        };
    }, []);

    return notice;
}

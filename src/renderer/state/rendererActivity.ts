import {createExternalStore} from './externalStore';
import {state} from './appState';
import {invokeNative} from '../bridge/nativeInvoke';

export type RendererActivitySnapshot = {
    count: number;
    labels: string[];
};

const activities = new Map<symbol, string>();
const activityStore = createExternalStore<RendererActivitySnapshot>({count: 0, labels: []});
const rendererSessionId = crypto.randomUUID();
const RENDERER_GENERATION_KEY = 'xexamai:renderer-activity-generation';
const rendererSessionGeneration = (() => {
    const timestampMicros = Math.max(1, Math.floor((performance.timeOrigin || Date.now()) * 1_000));
    try {
        const previous = Number.parseInt(sessionStorage.getItem(RENDERER_GENERATION_KEY) ?? '0', 10);
        const next = Math.max(timestampMicros, Number.isSafeInteger(previous) ? previous + 1 : 1);
        sessionStorage.setItem(RENDERER_GENERATION_KEY, String(next));
        return next;
    } catch {
        return timestampMicros;
    }
})();
let registration: Promise<void> | null = null;

export const subscribeRendererActivity = activityStore.subscribe;
export const getRendererActivitySnapshot = activityStore.getSnapshot;

function publish(): void {
    activityStore.set({count: activities.size, labels: [...new Set(activities.values())]});
}

/** Register this document and release native leases abandoned by an older reload. */
export function initializeRendererActivitySession(): Promise<void> {
    if (!registration) {
        registration = invokeNative('activity_register_session', {
            sessionId: rendererSessionId,
            generation: rendererSessionGeneration,
        }).catch((error) => {
            registration = null;
            throw error;
        });
    }
    return registration;
}

export function beginRendererActivity(label: string): () => void {
    const token = Symbol(label);
    activities.set(token, label);
    publish();
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        activities.delete(token);
        publish();
    };
}

/**
 * Registers renderer-owned work in both the observable UI state and the
 * native ActivityGate. The native lease makes update installation atomic
 * against work that does not otherwise pass through a Rust command.
 */
export async function beginNativeRendererActivity(label: string): Promise<() => Promise<void>> {
    await initializeRendererActivitySession();
    const releaseLocal = beginRendererActivity(label);
    let leaseId: string;
    try {
        leaseId = await invokeNative('activity_begin', {sessionId: rendererSessionId, label});
    } catch (error) {
        releaseLocal();
        throw error;
    }

    let active = true;
    return async () => {
        if (!active) return;
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                await invokeNative('activity_end', {sessionId: rendererSessionId, leaseId});
                active = false;
                releaseLocal();
                return;
            } catch (error) {
                lastError = error;
                if (attempt < 3) {
                    await new Promise((resolve) => window.setTimeout(resolve, 50 * (2 ** attempt)));
                }
            }
        }
        // Keep both local and native state busy. The caller can retry this
        // release closure, and a document reload safely resets abandoned leases.
        throw lastError;
    };
}

export function getRendererBusyReason(): string | null {
    if (state.isRecording) return 'Stop audio capture before installing the update.';
    if (state.isProcessing) return 'Stop the current AI operation before installing the update.';
    const activity = activityStore.getSnapshot().labels[0];
    return activity ? `Wait for “${activity}” to finish before installing the update.` : null;
}

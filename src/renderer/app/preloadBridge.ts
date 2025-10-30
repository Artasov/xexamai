import type {AssistantAPI} from '../types';

type BridgeHost = { api?: AssistantAPI };

export async function awaitPreloadBridge(): Promise<AssistantAPI | null> {
    let bridge = (window as unknown as BridgeHost).api;
    if (bridge) {
        console.info('[renderer] Preload bridge detected immediately', Object.keys(bridge));
        return bridge;
    }

    const isElectron =
        typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron/') ||
        typeof window !== 'undefined' && (window as any)?.process?.type === 'renderer';

    if (isElectron) {
        console.warn('[renderer] Preload bridge not immediately available, polling...');
        for (let i = 0; i < 30; i += 1) {
            await delay(100);
            bridge = (window as unknown as BridgeHost).api;
            if (bridge) {
                console.info('[renderer] Preload bridge detected after polling', Object.keys(bridge));
                break;
            }
        }
    } else {
        console.info('[renderer] Running outside Electron; preload bridge intentionally unavailable.');
    }

    if (!bridge && isElectron) {
        console.error('[renderer] Preload bridge could not be reached after polling.');
    }

    return bridge ?? null;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

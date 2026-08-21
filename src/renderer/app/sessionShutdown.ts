export type RendererShutdownReason =
    | 'sign-out'
    | 'session-expired'
    | 'domain-changed'
    | 'app-exit'
    | 'update-install';

type ShutdownHandler = (reason: RendererShutdownReason) => void | Promise<void>;

const handlers = new Set<ShutdownHandler>();
let activeShutdown: Promise<void> | null = null;

export function registerRendererShutdownHandler(handler: ShutdownHandler): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
}

export async function shutdownRendererSession(reason: RendererShutdownReason): Promise<void> {
    if (activeShutdown) return activeShutdown;
    activeShutdown = (async () => {
        const snapshot = [...handlers];
        const results = await Promise.allSettled(snapshot.map((handler) => Promise.resolve(handler(reason))));
        const failures = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason);
        if (failures.length) {
            const error = new Error('Renderer shutdown did not complete cleanly') as Error & {causes: unknown[]};
            error.causes = failures;
            throw error;
        }
    })();
    try {
        await activeShutdown;
    } finally {
        activeShutdown = null;
    }
}

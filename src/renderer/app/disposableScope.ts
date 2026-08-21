export type Disposable = () => void | Promise<void>;

/**
 * Owns every side effect created by one authenticated renderer mount.
 *
 * Async Tauri subscriptions can resolve after React has already unmounted the
 * authenticated tree. Adding a disposer to a closed scope therefore disposes
 * it immediately instead of leaking it into a later login session.
 */
export class DisposableScope {
    private disposables: Disposable[] = [];
    private disposePromise: Promise<void> | null = null;
    private closed = false;

    get isClosed(): boolean {
        return this.closed;
    }

    add(disposable: Disposable | null | undefined): Disposable {
        if (!disposable) return () => undefined;

        let active = true;
        const once = async () => {
            if (!active) return;
            active = false;
            await disposable();
        };

        if (this.closed) {
            void Promise.resolve(once()).catch(() => undefined);
        } else {
            this.disposables.push(once);
        }

        return once;
    }

    async dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;

        this.closed = true;
        const pending = this.disposables.splice(0).reverse();
        this.disposePromise = (async () => {
            for (const dispose of pending) {
                try {
                    await dispose();
                } catch {
                    // Teardown must continue: one broken integration must not
                    // keep audio, hotkeys, or a Tauri listener alive.
                }
            }
        })();
        return this.disposePromise;
    }
}

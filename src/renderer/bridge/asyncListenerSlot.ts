export type AsyncListenerDisposer = () => void | Promise<void>;

type RegisterListener<T> = (
    emit: (value: T) => void,
) => Promise<AsyncListenerDisposer>;

/**
 * Owns one asynchronously-created listener.
 *
 * Tauri's `listen()` becomes active before its Promise hands the disposer back
 * to JavaScript. A generation guard prevents callbacks after clear/replace,
 * while a late disposer is invoked immediately so logout cannot leak it into
 * the next authenticated renderer session.
 */
export class AsyncListenerSlot<T> {
    private generation = 0;
    private current: AsyncListenerDisposer | null = null;

    replace(register: RegisterListener<T>, listener: (value: T) => void): void {
        const generation = ++this.generation;
        const previous = this.current;
        this.current = null;

        void this.install(generation, previous, register, listener);
    }

    clear(): void {
        this.generation += 1;
        const current = this.current;
        this.current = null;
        if (current) void this.disposeSafely(current);
    }

    private async install(
        generation: number,
        previous: AsyncListenerDisposer | null,
        register: RegisterListener<T>,
        listener: (value: T) => void,
    ): Promise<void> {
        if (previous) await this.disposeSafely(previous);
        if (generation !== this.generation) return;

        let disposer: AsyncListenerDisposer;
        try {
            disposer = await register((value) => {
                if (generation === this.generation) listener(value);
            });
        } catch (error) {
            // The public bridge subscription API is intentionally fire-and-
            // forget. Surface setup failures without creating an unhandled
            // rejection in the renderer.
            if (generation === this.generation) {
                console.warn('[events] listener registration failed', error);
            }
            return;
        }

        if (generation !== this.generation) {
            await this.disposeSafely(disposer);
            return;
        }
        this.current = disposer;
    }

    private async disposeSafely(disposer: AsyncListenerDisposer): Promise<void> {
        try {
            await disposer();
        } catch {
        }
    }
}

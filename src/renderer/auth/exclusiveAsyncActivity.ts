export type AsyncActivityRelease = () => Promise<void>;

/**
 * Owns one asynchronous activity lease without leaving an await-sized race in
 * which two callers can both acquire and one release handle is overwritten.
 */
export class ExclusiveAsyncActivity {
    private acquisition: Promise<AsyncActivityRelease> | null = null;

    constructor(private readonly alreadyActiveMessage: string) {
    }

    get active(): boolean {
        return this.acquisition !== null;
    }

    async begin(factory: () => Promise<AsyncActivityRelease>): Promise<void> {
        if (this.acquisition) throw new Error(this.alreadyActiveMessage);
        const acquisition = factory();
        this.acquisition = acquisition;
        try {
            await acquisition;
        } catch (error) {
            if (this.acquisition === acquisition) this.acquisition = null;
            throw error;
        }
    }

    async end(): Promise<void> {
        const acquisition = this.acquisition;
        if (!acquisition) return;
        const release = await acquisition;
        await release();
        if (this.acquisition === acquisition) this.acquisition = null;
    }
}

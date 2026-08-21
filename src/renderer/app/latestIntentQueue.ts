/** Serializes async transitions and lets each step detect a newer requested state. */
export class LatestIntentQueue {
    private revision = 0;
    private tail: Promise<void> = Promise.resolve();

    run(task: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
        const revision = ++this.revision;
        const execute = () => task(() => revision === this.revision);
        const result = this.tail.then(execute, execute);
        this.tail = result.catch(() => undefined);
        return result;
    }
}

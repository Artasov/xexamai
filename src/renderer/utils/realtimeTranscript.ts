/** Reconciles cumulative Live partials while preserving text typed by the user. */
export function reconcileRealtimeTranscript(current: string, previous: string, next: string): string {
    const normalized = next.trim();
    if (!normalized) return current;
    const old = previous.trim();
    let shared = 0;
    while (shared < old.length && shared < normalized.length && old[shared] === normalized[shared]) shared += 1;
    const looksLikeRevision = !!old && (
        normalized.startsWith(old)
        || old.startsWith(normalized)
        || (shared >= 3 && shared >= Math.min(old.length, normalized.length) / 2)
    );
    if (looksLikeRevision && current.endsWith(old)) {
        return `${current.slice(0, -old.length)}${normalized}`;
    }
    if (old && old.endsWith(normalized)) return current;
    const separator = current && !/\s$/.test(current) ? ' ' : '';
    return `${current}${separator}${normalized}`;
}

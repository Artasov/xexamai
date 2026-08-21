const HISTORY_BACKEND_HOSTS = new Set(['xlartas.com', 'xlartas.ru']);

export function buildHistoryScope(backendOrigin: string, accountId: number | null): string {
    const parsed = new URL(backendOrigin);
    if (
        parsed.protocol !== 'https:' ||
        !HISTORY_BACKEND_HOSTS.has(parsed.hostname) ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
    ) {
        throw new Error('Unsupported history backend origin');
    }
    const account =
        accountId == null
            ? 'anonymous'
            : Number.isSafeInteger(accountId) && accountId > 0
              ? `user-${accountId}`
              : null;
    if (!account) throw new Error('Invalid history account');
    return `${parsed.origin}:${account}`;
}

export function scopedHistoryStorageKey(baseKey: string, scope: string): string {
    if (!baseKey || !scope || baseKey.length > 128 || scope.length > 256) {
        throw new Error('Invalid history storage scope');
    }
    return `${baseKey}:${scope}`;
}

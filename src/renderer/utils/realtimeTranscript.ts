/** Reconciles cumulative Live partials while preserving text typed by the user. */
export function reconcileRealtimeTranscript(current: string, previous: string, next: string): string {
    const normalized = next.replace(/\s+/g, ' ');
    const nextCore = normalized.trim();
    if (!nextCore) return current;
    const old = previous.replace(/\s+/g, ' ').trim();
    let shared = 0;
    while (shared < old.length && shared < nextCore.length && old[shared] === nextCore[shared]) shared += 1;
    const looksLikeRevision = !!old && (
        nextCore.startsWith(old)
        || old.startsWith(nextCore)
        || (shared >= 3 && shared >= Math.min(old.length, nextCore.length) / 2)
    );
    if (looksLikeRevision && current.endsWith(old)) {
        return `${current.slice(0, -old.length)}${nextCore}`;
    }
    if (looksLikeRevision) {
        const separator = /\s$/.test(current) ? '' : ' ';
        return `${current}${separator}${nextCore}`;
    }
    if (old && old.endsWith(nextCore)) return current;
    if (!current) return nextCore;
    // Incremental Live frames may split a word ("Ho" + "w") and carry
    // whitespace explicitly between words (" are"). Preserve that boundary
    // instead of inventing a space for every vendor frame.
    if (/^\s/.test(normalized)) {
        return `${current.replace(/\s+$/, '')} ${nextCore}`;
    }
    return `${current}${nextCore}`;
}

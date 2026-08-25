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
    if (looksLikeRevision && old) {
        const leadingTrimmed = current.trimStart();
        if (startsWithWholePrefix(leadingTrimmed, old)) {
            const leadingWhitespace = current.slice(0, current.length - leadingTrimmed.length);
            return `${leadingWhitespace}${nextCore}${leadingTrimmed.slice(old.length)}`;
        }
    }
    if (looksLikeRevision) {
        const separator = /\s$/.test(current) ? '' : ' ';
        return `${current}${separator}${nextCore}`;
    }
    if (old && old.endsWith(nextCore)) return current;
    if (!current) return nextCore;
    // An empty provider `previous` marks the first fragment of a fresh turn.
    // Keep it separate from an instruction the user typed before recording.
    if (!old) {
        const separator = /\s$/.test(current) || /^\s/.test(normalized) ? '' : ' ';
        return `${current}${separator}${nextCore}`;
    }
    // Incremental Live frames may split a word ("Ho" + "w") and carry
    // whitespace explicitly between words (" are"). Preserve that boundary
    // instead of inventing a space for every vendor frame.
    if (/^\s/.test(normalized)) {
        return `${current.replace(/\s+$/, '')} ${nextCore}`;
    }
    return `${current}${nextCore}`;
}

/**
 * Returns only the text a user added while viewing the provider's source
 * transcript. When the source was edited in-place (instead of extended), the
 * complete edited value is retained because silently dropping it is worse
 * than sending the original and the user's correction together.
 */
export function extractRealtimeSourceEdit(providerSource: string, editedSource: string): string {
    const provider = providerSource.replace(/\s+/g, ' ').trim();
    const edited = editedSource.replace(/\s+/g, ' ').trim();
    if (!edited || edited === provider) return '';
    if (!provider) return edited;
    if (startsWithWholePrefix(edited, provider)) return edited.slice(provider.length).trim();
    if (endsWithWholeSuffix(edited, provider)) return edited.slice(0, -provider.length).trim();
    const inserted = extractInsertion(provider, edited);
    if (inserted) return inserted;
    return edited;
}

/** Applies a provider revision without overwriting or duplicating an editable UI overlay. */
export function reconcileRealtimeTextWithEdit(
    current: string,
    providerPrevious: string,
    providerNext: string,
    edit: string,
): string {
    const previous = providerPrevious.replace(/\s+/g, ' ').trim();
    const next = providerNext.replace(/\s+/g, ' ').trim();
    const currentCore = current.replace(/\s+/g, ' ').trim();
    const editCore = edit.replace(/\s+/g, ' ').trim();
    if (!editCore) return next;
    if (!next) return current;
    if (!previous && currentCore === editCore) return joinText(editCore, next);

    // A simple prefix/suffix clarification can be re-applied around a corrected
    // provider revision without moving it into the middle of live speech.
    if (currentCore === joinText(previous, editCore)) return joinText(next, editCore);
    if (currentCore === joinText(editCore, previous)) return joinText(editCore, next);

    // For an in-place correction, preserve the user's text and append only a
    // genuinely new provider suffix. Never append the full revised transcript.
    if (previous && next.startsWith(previous)) {
        const suffix = next.slice(previous.length);
        if (!suffix.trim()) return current;
        const separator = /\s$/.test(current) || /^\s/.test(suffix) ? '' : ' ';
        return `${current}${separator}${suffix}`;
    }
    return current;
}

/** Keeps translated speech primary while carrying an explicit source-side edit. */
export function composeRealtimeTranslationPrompt(translated: string, sourceEdit: string): string {
    const primary = translated.trim();
    const clarification = sourceEdit.trim();
    if (!clarification) return primary;
    if (!primary) return clarification;
    return `${primary}\n\nUser-provided clarification:\n${clarification}`;
}

export function appendSubmittedPrompt(current: string, submitted: string | undefined): string {
    const base = submitted?.trim() || '';
    if (!base) return current;
    if (!current.trim()) return `${base} `;
    if (startsWithWholePrefix(current.trimStart(), base)) return current;
    return `${base} ${current.trimStart()}`;
}

export function removeSubmittedPromptPrefix(current: string, submitted: string | undefined): string {
    const prefix = submitted?.trim() || '';
    if (!prefix) return current;
    const leadingTrimmed = current.trimStart();
    if (leadingTrimmed === prefix) return '';
    if (startsWithWholePrefix(leadingTrimmed, prefix)) {
        return leadingTrimmed.slice(prefix.length).trimStart();
    }
    return current;
}

/**
 * Removes only the provider/user snapshot that was actually submitted while
 * retaining provider deltas and user edits that appeared during async
 * dispatch. Ambiguous in-place edits are kept intact rather than risk losing
 * text the user typed.
 */
export function reconcileRealtimeAcknowledgement(
    current: string,
    acknowledged: string | undefined,
    providerRemaining: string,
): string {
    const remaining = providerRemaining;
    if (!current.trim()) return remaining;
    const withoutAcknowledged = removeSubmittedPromptPrefix(current, acknowledged);
    if (withoutAcknowledged !== current) {
        return withoutAcknowledged || remaining;
    }
    const acknowledgedCore = acknowledged?.trim() || '';
    if (acknowledgedCore && current.trim() === acknowledgedCore) return remaining;
    return current;
}

export function reconcileRealtimeTranslationAcknowledgement(
    current: {source: string; translated: string},
    update: {
        submittedText?: string;
        submittedTranslationView?: 'source' | 'translated';
        acknowledgedSource: string;
        acknowledgedTranslated: string;
        source: string;
        translated: string;
    },
): {source: string; translated: string} {
    const next = {
        source: reconcileRealtimeAcknowledgement(
            current.source,
            update.acknowledgedSource,
            update.source,
        ),
        translated: reconcileRealtimeAcknowledgement(
            current.translated,
            update.acknowledgedTranslated,
            update.translated,
        ),
    };
    const submittedView = update.submittedTranslationView;
    if (!update.submittedText || !submittedView) return next;

    const submittedReconciled = reconcileRealtimeAcknowledgement(
        current[submittedView],
        update.submittedText,
        next[submittedView],
    );
    if (
        submittedReconciled !== current[submittedView]
        || next[submittedView] === current[submittedView]
    ) {
        next[submittedView] = submittedReconciled;
    }
    return next;
}

function startsWithWholePrefix(value: string, prefix: string): boolean {
    if (!value.startsWith(prefix)) return false;
    const next = value.charAt(prefix.length);
    return !next || /\s/.test(next);
}

function endsWithWholeSuffix(value: string, suffix: string): boolean {
    if (!value.endsWith(suffix)) return false;
    const previous = value.charAt(value.length - suffix.length - 1);
    return !previous || /\s/.test(previous);
}

function extractInsertion(original: string, edited: string): string {
    if (edited.length <= original.length) return '';
    let prefixLength = 0;
    while (
        prefixLength < original.length
        && original.charAt(prefixLength) === edited.charAt(prefixLength)
    ) {
        prefixLength += 1;
    }
    let suffixLength = 0;
    while (
        suffixLength < original.length - prefixLength
        && original.charAt(original.length - suffixLength - 1)
            === edited.charAt(edited.length - suffixLength - 1)
    ) {
        suffixLength += 1;
    }
    if (prefixLength + suffixLength !== original.length) return '';
    const inserted = edited.slice(prefixLength, edited.length - suffixLength);
    const beforeInsertion = edited.charAt(prefixLength - 1);
    const afterInsertion = edited.charAt(edited.length - suffixLength);
    const separatedBefore = !beforeInsertion || /\s/.test(beforeInsertion) || /^\s/.test(inserted);
    const separatedAfter = !afterInsertion || /\s/.test(afterInsertion) || /\s$/.test(inserted);
    if (!separatedBefore || !separatedAfter) return '';
    return inserted.trim();
}

function joinText(first: string, second: string): string {
    if (!first) return second;
    if (!second) return first;
    return `${first} ${second}`;
}

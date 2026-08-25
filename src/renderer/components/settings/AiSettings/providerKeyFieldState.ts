export const SAVED_API_KEY_MASK = '••••••••';

type ProviderKeyFieldStateOptions = {
    draft: string;
    saved: boolean;
    editing: boolean;
};

export type ProviderKeyFieldState = {
    displayValue: string;
    placeholder: 'API key' | 'New key';
    hasDraft: boolean;
    showingSavedMask: boolean;
};

/**
 * Keeps the write-only secret marker separate from the actual draft. The mask
 * must never be passed to the credential-store API as a replacement key.
 */
export function getProviderKeyFieldState({
    draft,
    saved,
    editing,
}: ProviderKeyFieldStateOptions): ProviderKeyFieldState {
    const hasDraft = Boolean(draft.trim());
    const showingSavedMask = saved && !editing && !hasDraft;

    return {
        displayValue: showingSavedMask ? SAVED_API_KEY_MASK : draft,
        placeholder: saved ? 'New key' : 'API key',
        hasDraft,
        showingSavedMask,
    };
}

/**
 * Converts a browser input event into the write-only replacement draft. Some
 * password managers can emit a change before focus has switched the field out
 * of its presentation-only mask, so handle both a replacement value and a
 * value appended to the mask without ever treating the mask as a credential.
 */
export function normalizeProviderKeyDraftInput(
    input: string,
    showingSavedMask: boolean,
): string {
    if (!showingSavedMask) return input;
    if (input === SAVED_API_KEY_MASK) return '';
    return input.startsWith(SAVED_API_KEY_MASK)
        ? input.slice(SAVED_API_KEY_MASK.length)
        : input;
}

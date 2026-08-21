export type CaptureSwitchTransactionResult =
    | {state: 'applied'}
    | {state: 'old-active'; error: unknown}
    | {state: 'rolled-back'; error: unknown}
    | {state: 'new-active'; error: unknown; rollbackError: unknown};

type CaptureSwitchTransaction = {
    switchRequired: boolean;
    switchToNew: () => Promise<void>;
    persistNew: () => Promise<void>;
    switchBack: () => Promise<void>;
};

/**
 * Keeps the runtime source truthful when persistence fails after Rust has
 * already atomically replaced the active capture generation.
 */
export async function runCaptureSwitchTransaction(
    transaction: CaptureSwitchTransaction,
): Promise<CaptureSwitchTransactionResult> {
    let captureSwitched = false;
    try {
        if (transaction.switchRequired) {
            await transaction.switchToNew();
            captureSwitched = true;
        }
        await transaction.persistNew();
        return {state: 'applied'};
    } catch (error) {
        if (!captureSwitched) return {state: 'old-active', error};
        try {
            await transaction.switchBack();
            return {state: 'rolled-back', error};
        } catch (rollbackError) {
            return {state: 'new-active', error, rollbackError};
        }
    }
}

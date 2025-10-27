import type {HolderStatus, HolderVerificationResult} from '../types';

export async function fetchHolderStatus(refresh: boolean = false): Promise<HolderStatus> {
    if (refresh) {
        return window.api.holder.getStatus({refreshBalance: true});
    }
    return window.api.holder.getStatus();
}

export async function requestHolderChallenge(): Promise<HolderStatus> {
    return window.api.holder.createChallenge();
}

export async function verifyHolderSignature(signature: string): Promise<HolderVerificationResult> {
    return window.api.holder.verifySignature(signature);
}

export async function resetHolderState(): Promise<void> {
    await window.api.holder.reset();
}

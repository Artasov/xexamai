import type {HolderChallengeInfo, HolderStatus} from '../types.js';
import {fetchHolderStatus, requestHolderChallenge, verifyHolderSignature} from '../services/holderClient.js';
import {getHolderState, setHolderLoading, setHolderStatus, subscribeHolderState} from '../state/holderState.js';

type ModalElements = {
    overlay: HTMLDivElement;
    content: HTMLDivElement;
    deeplinkInput: HTMLInputElement;
    copyBtn: HTMLButtonElement;
    openBtn: HTMLButtonElement;
    qrContainer: HTMLDivElement;
    qrImage: HTMLImageElement;
    signature: HTMLInputElement;
    verifyBtn: HTMLButtonElement;
    closeBtn: HTMLButtonElement;
    message: HTMLDivElement;
    loadingBar: HTMLDivElement;
};

type HolderAccessInitOptions = {
    headerTitleEl?: HTMLElement | null;
};

let headerTitleEl: HTMLElement | null = null;
let crownEl: HTMLSpanElement | null = null;
let statusBadgeEl: HTMLElement | null = null;
let statusDetailsEl: HTMLElement | null = null;
let actionButtonEl: HTMLButtonElement | null = null;
let modalElements: ModalElements | null = null;
let lastChallengeRef: string | null = null;
let stylesInjected = false;
let currentQrObjectUrl: string | null = null;

function ensureHolderStyles() {
    if (stylesInjected) return;
    const style = document.createElement('style');
    style.id = 'holder-access-styles';
    style.textContent = `
:root {
    --holder-overlay-duration: 220ms;
    --holder-overlay-ease: cubic-bezier(0.32, 0.08, 0.24, 1);
}

@keyframes holder-loading {
    from { background-position: 0% 0%; }
    to { background-position: -200% 0%; }
}

.holder-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(6, 6, 12, 0);
    backdrop-filter: blur(0px);
    -webkit-backdrop-filter: blur(0px);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
        opacity var(--holder-overlay-duration) var(--holder-overlay-ease),
        background var(--holder-overlay-duration) var(--holder-overlay-ease),
        backdrop-filter var(--holder-overlay-duration) var(--holder-overlay-ease);
    z-index: 9999;
}

.holder-overlay--visible {
    background: rgba(6, 6, 12, 0.78);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

.holder-modal {
    transform: translateY(16px) scale(0.97);
    opacity: 0;
    filter: blur(2px);
    transition:
        transform var(--holder-overlay-duration) var(--holder-overlay-ease),
        opacity var(--holder-overlay-duration) var(--holder-overlay-ease),
        filter var(--holder-overlay-duration) var(--holder-overlay-ease);
}

.holder-overlay--visible .holder-modal {
    transform: translateY(0) scale(1);
    opacity: 1;
    filter: blur(0px);
}
`;
    document.head.appendChild(style);
    stylesInjected = true;
}

function ensureCrownElement() {
    if (crownEl) return;
    if (!headerTitleEl || !headerTitleEl.parentElement) return;
    crownEl = document.createElement('span');
    crownEl.textContent = '👑';
    crownEl.title = 'Holder access active';
    crownEl.style.display = 'none';
    crownEl.style.fontSize = '1.2rem';
    crownEl.style.marginLeft = '6px';
    headerTitleEl.insertAdjacentElement('afterend', crownEl);
}

function ensureModalElements(): ModalElements {
    if (modalElements) return modalElements;

    ensureHolderStyles();

    const overlay = document.createElement('div');
    overlay.className = 'holder-overlay';

    const content = document.createElement('div');
    content.className = 'card fc gap-3 holder-modal';
    content.style.width = 'min(480px, 92vw)';
    content.style.maxHeight = '90vh';
    content.style.overflow = 'auto';
    content.style.padding = '20px';
    content.style.boxShadow = '0 28px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(139,92,246,0.35)';
    content.style.border = '1px solid rgba(139,92,246,0.25)';

    const header = document.createElement('div');
    header.className = 'frbc';

    const title = document.createElement('h2');
    title.textContent = 'Verify holder access';
    title.className = 'text-lg font-semibold';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.className = 'btn btn-sm';
    closeBtn.style.width = '32px';
    closeBtn.style.minWidth = '32px';

    header.appendChild(title);
    header.appendChild(closeBtn);

    const description = document.createElement('p');
    description.className = 'text-sm text-gray-400';
    description.textContent = 'Sign a zero-SOL transaction using the link below, then paste the resulting signature to confirm you hold the required token.';

    const deeplinkGroup = document.createElement('div');
    deeplinkGroup.className = 'fc gap-2';

    const deeplinkLabel = document.createElement('span');
    deeplinkLabel.className = 'text-xs text-gray-400 uppercase tracking-wide';
    deeplinkLabel.textContent = 'Deep link';

    const deeplinkRow = document.createElement('div');
    deeplinkRow.className = 'fr gap-2 flex-wrap';

    const deeplinkInput = document.createElement('input');
    deeplinkInput.className = 'input-field flex-1';
    deeplinkInput.style.minWidth = '200px';
    deeplinkInput.readOnly = true;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-sm';
    copyBtn.textContent = 'Copy';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-sm btn-primary';
    openBtn.textContent = 'Open';

    deeplinkRow.appendChild(deeplinkInput);
    deeplinkRow.appendChild(copyBtn);
    deeplinkRow.appendChild(openBtn);

    deeplinkGroup.appendChild(deeplinkLabel);
    deeplinkGroup.appendChild(deeplinkRow);

    const qrLabel = document.createElement('span');
    qrLabel.className = 'text-xs text-gray-400 uppercase tracking-wide';
    qrLabel.textContent = 'QR code';

    const qrContainer = document.createElement('div');
    qrContainer.className = 'self-center';
    qrContainer.style.marginTop = '12px';
    qrContainer.style.background = '#ffffff';
    qrContainer.style.padding = '18px';
    qrContainer.style.borderRadius = '16px';
    qrContainer.style.boxShadow = '0 14px 42px rgba(0,0,0,0.24)';
    qrContainer.style.maxWidth = 'fit-content';
    qrContainer.style.display = 'flex';
    qrContainer.style.alignItems = 'center';
    qrContainer.style.justifyContent = 'center';
    qrContainer.style.border = '1px solid rgba(0,0,0,0.1)';

    const qrImage = document.createElement('img');
    qrImage.alt = 'Holder verification QR';
    qrImage.style.display = 'block';
    qrImage.style.width = '256px';
    qrImage.style.height = '256px';
    qrImage.style.objectFit = 'contain';
    qrImage.style.imageRendering = 'pixelated';
    qrImage.style.filter = 'drop-shadow(0 4px 14px rgba(0,0,0,0.15))';

    qrContainer.appendChild(qrImage);

    const signatureLabel = document.createElement('label');
    signatureLabel.className = 'text-xs text-gray-400 uppercase tracking-wide';
    signatureLabel.textContent = 'Transaction signature';

    const signatureInput = document.createElement('input');
    signatureInput.className = 'input-field';
    signatureInput.placeholder = 'Paste the signature here';

    const loadingBar = document.createElement('div');
    loadingBar.style.display = 'none';
    loadingBar.style.width = '100%';
    loadingBar.style.height = '4px';
    loadingBar.style.borderRadius = '9999px';
    loadingBar.style.background = 'linear-gradient(90deg, rgba(139,92,246,0.15) 0%, rgba(139,92,246,0.8) 50%, rgba(139,92,246,0.15) 100%)';
    loadingBar.style.backgroundSize = '200% 100%';
    loadingBar.style.animation = 'holder-loading 1.6s linear infinite';

    const verifyBtn = document.createElement('button');
    verifyBtn.className = 'btn btn-primary';
    verifyBtn.textContent = 'Check';

    const message = document.createElement('div');
    message.className = 'text-sm text-gray-400';
    message.style.minHeight = '1.2rem';

    content.appendChild(header);
    content.appendChild(description);
    content.appendChild(deeplinkGroup);
    content.appendChild(qrLabel);
    content.appendChild(qrContainer);
    content.appendChild(signatureLabel);
    content.appendChild(signatureInput);
    content.appendChild(verifyBtn);
    content.appendChild(loadingBar);
    content.appendChild(message);

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeModal();
        }
    });

    closeBtn.addEventListener('click', () => closeModal());
    copyBtn.addEventListener('click', () => {
        if (!deeplinkInput.value) return;
        navigator.clipboard?.writeText(deeplinkInput.value).then(() => {
            setModalMessage('Link copied to clipboard');
        }).catch(() => {
            try {
                deeplinkInput.select();
                document.execCommand('copy');
                setModalMessage('Link copied to clipboard');
            } catch {
                setModalMessage('Unable to copy link automatically');
            }
        });
    });

    openBtn.addEventListener('click', () => {
        if (!deeplinkInput.value) return;
        try {
            window.open(deeplinkInput.value, '_blank');
        } catch (error) {
            console.error('Failed to open deep link', error);
        }
    });

    verifyBtn.addEventListener('click', async () => {
        await performVerification();
    });

    signatureInput.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            await performVerification();
        }
    });

    modalElements = {
        overlay,
        content,
        deeplinkInput,
        copyBtn,
        openBtn,
        qrContainer,
        qrImage,
        signature: signatureInput,
        verifyBtn,
        closeBtn,
        message,
        loadingBar,
    };

    return modalElements;
}

function setModalMessage(text: string, tone: 'info' | 'error' | 'success' = 'info') {
    if (!modalElements) return;
    modalElements.message.textContent = text;
    const color = tone === 'success' ? '#34d399' : tone === 'error' ? '#f87171' : '#d1d5db';
    modalElements.message.style.color = color;
}

function setModalBusy(isBusy: boolean) {
    if (!modalElements) return;
    modalElements.verifyBtn.disabled = isBusy;
    modalElements.signature.disabled = isBusy;
    modalElements.loadingBar.style.display = isBusy ? 'block' : 'none';
}

async function performVerification() {
    const modal = ensureModalElements();
    const signature = modal.signature.value.trim();
    if (!signature) {
        setModalMessage('Signature is required', 'error');
        return;
    }

    setModalBusy(true);
    setModalMessage('Checking signature...');

    try {
        const result = await verifyHolderSignature(signature);
        if (!result.ok) {
            setModalMessage(result.error || 'Verification failed', 'error');
            return;
        }

        setModalMessage(result.message || 'Holder verified successfully', 'success');
        modal.signature.value = '';
        await refreshHolderStatus(true);
        setTimeout(() => {
            closeModal();
        }, 1000);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setModalMessage(message || 'Verification failed', 'error');
    } finally {
        setModalBusy(false);
    }
}

function updateQrImage(svg?: string) {
    if (!modalElements) return;
    if (currentQrObjectUrl) {
        try { URL.revokeObjectURL(currentQrObjectUrl); } catch {}
        currentQrObjectUrl = null;
    }
    if (svg && svg.trim()) {
        try {
            const blob = new Blob([svg], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            currentQrObjectUrl = url;
            modalElements.qrImage.src = url;
        } catch (error) {
            console.error('Failed to create QR image URL', error);
            modalElements.qrImage.removeAttribute('src');
        }
    } else {
        modalElements.qrImage.removeAttribute('src');
    }
}

function updateModalChallenge(challenge?: HolderChallengeInfo) {
    if (!modalElements) return;
    if (!challenge) {
        lastChallengeRef = null;
        modalElements.deeplinkInput.value = '';
        updateQrImage();
        return;
    }
    if (challenge.reference === lastChallengeRef) return;
    lastChallengeRef = challenge.reference;
    modalElements.deeplinkInput.value = challenge.deeplink;
    updateQrImage(challenge.qrSvg);
    if (challenge.qrSvg) {
        setModalMessage('Scan the QR or open the link to sign the transaction');
    } else {
        setModalMessage('Open the link to sign the verification transaction');
    }
}

function formatDateLabel(iso?: string): string {
    if (!iso) return '';
    try {
        const date = new Date(iso);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    } catch {
        return iso;
    }
}

function truncatePubkey(pubkey?: string): string {
    if (!pubkey) return '';
    if (pubkey.length <= 12) return pubkey;
    return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

function updateSettingsStatus(status: HolderStatus | null, isLoading: boolean) {
    if (!statusBadgeEl) return;
    if (!status) {
        statusBadgeEl.textContent = 'Status: unknown';
        statusBadgeEl.classList.remove('text-green-300', 'text-yellow-300', 'text-red-300');
        statusBadgeEl.classList.add('text-gray-300');
        if (statusDetailsEl) statusDetailsEl.textContent = '';
        if (actionButtonEl) actionButtonEl.textContent = "I'm holder";
        return;
    }

    if (status.isAuthorized) {
        statusBadgeEl.textContent = 'Verified';
        statusBadgeEl.classList.remove('text-yellow-300', 'text-red-300', 'text-gray-300');
        statusBadgeEl.classList.add('text-green-300');
        if (statusDetailsEl) {
            const wallet = truncatePubkey(status.wallet);
            const when = formatDateLabel(status.lastVerified);
            const amount = status.tokenBalance ? ` • balance: ${status.tokenBalance}` : '';
            statusDetailsEl.textContent = `Wallet ${wallet} verified ${when}${amount}`;
        }
        if (actionButtonEl) actionButtonEl.textContent = 'Renew verification';
        return;
    }

    if (status.needsSignature) {
        statusBadgeEl.textContent = isLoading ? 'Checking…' : 'Action required';
        statusBadgeEl.classList.remove('text-green-300', 'text-red-300');
        statusBadgeEl.classList.add('text-yellow-300');
        if (statusDetailsEl) {
            statusDetailsEl.textContent = status.error || 'Sign the verification transaction to continue.';
        }
        if (actionButtonEl) actionButtonEl.textContent = "I'm holder";
        return;
    }

    statusBadgeEl.textContent = status.error ? 'Error' : 'Not verified';
    statusBadgeEl.classList.remove('text-green-300', 'text-yellow-300');
    statusBadgeEl.classList.add(status.error ? 'text-red-300' : 'text-gray-300');
    if (statusDetailsEl) {
        statusDetailsEl.textContent = status.error || '';
    }
    if (actionButtonEl) actionButtonEl.textContent = "I'm holder";
}

function updateHeaderCrown(status: HolderStatus | null) {
    if (!crownEl) return;
    if (status?.isAuthorized) {
        crownEl.style.display = 'inline-flex';
        const wallet = truncatePubkey(status.wallet);
        const exp = status.lastVerified ? new Date(new Date(status.lastVerified).getTime() + 3 * 24 * 60 * 60 * 1000) : null;
        const expiryText = exp ? exp.toLocaleDateString() : '';
        crownEl.title = `Holder wallet ${wallet}. Revalidation required after ${expiryText}`;
    } else {
        crownEl.style.display = 'none';
    }
}

function handleStateChange({status, loading}: { status: HolderStatus | null; loading: boolean }) {
    updateHeaderCrown(status);
    updateSettingsStatus(status, loading);
    if (status?.challenge) {
        updateModalChallenge(status.challenge);
    } else {
        updateModalChallenge(undefined);
    }
}

export async function refreshHolderStatus(refresh: boolean = false) {
    setHolderLoading(true);
    try {
        const status = await fetchHolderStatus(refresh);
        setHolderStatus(status);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fallback: HolderStatus = {
            isAuthorized: false,
            needsSignature: true,
            error: message || 'Failed to load holder status',
        };
        setHolderStatus(fallback);
    } finally {
        setHolderLoading(false);
    }
}

export function initializeHolderAccess(options: HolderAccessInitOptions = {}) {
    if (options.headerTitleEl) {
        headerTitleEl = options.headerTitleEl;
        ensureCrownElement();
    }
    if (!crownEl) {
        ensureCrownElement();
    }
    subscribeHolderState(handleStateChange);
    // Prime initial status
    void refreshHolderStatus(true);
}

export function registerHolderSettingsSection(container: HTMLElement) {
    statusBadgeEl = container.querySelector('#holderStatusBadge') as HTMLElement | null;
    statusDetailsEl = container.querySelector('#holderStatusDetails') as HTMLElement | null;
    actionButtonEl = container.querySelector('#holderAuthBtn') as HTMLButtonElement | null;
    if (actionButtonEl) {
        actionButtonEl.onclick = () => {
            void openHolderModal();
        };
    }
    const snapshot = getHolderState();
    updateSettingsStatus(snapshot.status, snapshot.loading);
}

export async function openHolderModal() {
    const modal = ensureModalElements();
    modal.overlay.classList.add('holder-overlay--visible');
    modal.signature.value = '';
    updateQrImage();
    setModalMessage('Generating deep link…');
    setModalBusy(true);
    lastChallengeRef = null;
    try {
        const status = await requestHolderChallenge();
        setHolderStatus(status);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setModalMessage(message || 'Failed to create verification challenge', 'error');
    } finally {
        setModalBusy(false);
    }
}

export function closeModal() {
    if (!modalElements) return;
    modalElements.overlay.classList.remove('holder-overlay--visible');
    updateQrImage();
}

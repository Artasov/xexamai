import {getHolderState} from '../state/holderState';

export type HolderAccess = 'holder' | 'non-holder' | 'pending';

export function showHolderOnlyModal(): void {
    const existing = document.getElementById('holder-only-modal') as HTMLDivElement | null;
    if (existing) {
        existing.classList.add('holder-overlay--visible');
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'holder-only-modal';
    overlay.className = 'holder-overlay holder-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'holder-modal card fc gap-3';

    const title = document.createElement('h3');
    title.textContent = 'Screen processing is holder-only';
    title.className = 'text-lg font-semibold';

    const message = document.createElement('p');
    message.className = 'text-sm text-gray-300';
    message.innerHTML = `This feature is available only to token holders <strong style="word-break: break-word;">D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG</strong>.<br/>All links and instructions are available on our website: <a href="https://xldev.ru/en/xexamai" target="_blank" rel="noreferrer">https://xldev.ru/en/xexamai</a>.`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Got it';
    closeBtn.addEventListener('click', () => {
        overlay.classList.remove('holder-overlay--visible');
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            overlay.classList.remove('holder-overlay--visible');
        }
    });

    modal.appendChild(title);
    modal.appendChild(message);
    modal.appendChild(closeBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
        overlay.classList.add('holder-overlay--visible');
    });
}

export function checkHolderAccess(): HolderAccess {
    const snapshot = getHolderState();
    if (snapshot.loading && !snapshot.status) {
        return 'pending';
    }
    const status = snapshot.status;
    if (!status) {
        return 'non-holder';
    }
    if (status.checkingBalance) {
        return 'pending';
    }
    const hasToken = status.hasToken ?? false;
    const authorized = status.isAuthorized ?? false;
    return hasToken || authorized ? 'holder' : 'non-holder';
}

type CommunityLink = {
    label: string;
    url: string;
    icon: string | string[];
};

type WelcomeModalElements = {
    overlay: HTMLDivElement;
    modal: HTMLDivElement;
    closeBtn: HTMLButtonElement;
    dismissCheckbox: HTMLInputElement;
    footer: HTMLLabelElement;
    continueBtn: HTMLButtonElement;
};

const COMMUNITY_LINKS: CommunityLink[] = [
    {
        label: 'Website',
        url: 'https://artasov.github.io/xexamai/',
        icon: ['../../brand/logo_white.png', 'brand/logo_white.png'],
    },
    {
        label: 'X Community',
        url: 'https://x.com/i/communities/1978030402209034469',
        icon: 'img/icons/community/x.svg',
    },
    {
        label: 'Telegram',
        url: 'https://t.me/xexamai',
        icon: 'img/icons/community/telegram.svg',
    },
    {
        label: 'GitHub',
        url: 'https://github.com/Artasov/xexamai',
        icon: 'img/icons/community/github.svg',
    },
    {
        label: 'Pump.fun',
        url: 'https://pump.fun/coin/D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG',
        icon: 'img/icons/community/pumpfun.webp',
    },
    {
        label: 'Dexscreener',
        url: 'https://dexscreener.com/solana/D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG',
        icon: 'img/icons/community/dexscreener.svg',
    },
    {
        label: 'YouTube',
        url: 'https://www.youtube.com/watch?v=ilKcTjacg78',
        icon: 'img/icons/community/youtube.svg',
    },
    {
        label: 'LinkedIn',
        url: 'https://www.linkedin.com/in/xlartas',
        icon: 'img/icons/community/linkedin.svg',
    },
    {
        label: 'Discord',
        url: 'https://discord.gg/mcUKZmcB',
        icon: 'img/icons/community/discrod.svg',
    },
    {
        label: 'X Developer',
        url: 'https://x.com/xlartasov',
        icon: 'img/icons/community/x.svg',
    },
];

let stylesInjected = false;
let modalElements: WelcomeModalElements | null = null;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;
let welcomeControlsEnabled = false;
let welcomeControlsTimer: number | null = null;

function ensureStyles(): void {
    if (stylesInjected) return;
    const style = document.createElement('style');
    style.id = 'welcome-modal-styles';
    style.textContent = `
:root {
    --welcome-overlay-duration: 220ms;
    --welcome-overlay-ease: cubic-bezier(0.32, 0.08, 0.24, 1);
}

.welcome-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
    background: rgba(4, 6, 12, 0);
    backdrop-filter: blur(0px);
    -webkit-backdrop-filter: blur(0px);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
        opacity var(--welcome-overlay-duration) var(--welcome-overlay-ease),
        background var(--welcome-overlay-duration) var(--welcome-overlay-ease),
        backdrop-filter var(--welcome-overlay-duration) var(--welcome-overlay-ease);
    z-index: 10000;
}

.welcome-overlay--visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    background: rgba(6, 6, 12, 0.78);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}

.welcome-modal {
    transform: translateY(18px) scale(0.97);
    opacity: 0;
    filter: blur(2px);
    transition:
        transform var(--welcome-overlay-duration) var(--welcome-overlay-ease),
        opacity var(--welcome-overlay-duration) var(--welcome-overlay-ease),
        filter var(--welcome-overlay-duration) var(--welcome-overlay-ease);
}

.welcome-overlay--visible .welcome-modal {
    transform: translateY(0) scale(1);
    opacity: 1;
    filter: blur(0px);
}

.welcome-modal__links {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: center;
}

.welcome-modal__link {
    color: #f9fafb;
    flex-grow: 1;
    text-align: left;
    text-decoration: none;
}

.welcome-modal__link:hover { 
    background-color: rgba(255, 255, 255, 0.1) !important;
    border-color: rgba(255, 255, 255, 0.25) !important;
}

.welcome-modal__icon {
    width: 28px;
    height: 28px;
    display: block;
    object-fit: contain;
    pointer-events: none;
}

.welcome-modal__label {
    flex: 1;
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #e2e8f0;
}

.welcome-modal__footer {
    width: 100%;
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    color: #94a3b8;
}

.welcome-modal__checkbox {
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 6px;
    border: 1px solid rgba(148, 163, 184, 0.35);
    background: rgba(148, 163, 184, 0.1);
    display: grid;
    place-items: center;
    transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
    cursor: pointer;
    position: relative;
}

.welcome-modal__checkbox:hover {
    border-color: rgba(139, 92, 246, 0.55);
    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.1);
}

.welcome-modal__checkbox::after {
    content: '';
    width: 6px;
    height: 10px;
    border: solid transparent;
    border-width: 0 2px 2px 0;
    transform: translateY(-1px) rotate(45deg) scale(0);
    transition: transform 0.2s ease, border-color 0.2s ease;
}

.welcome-modal__checkbox:checked {
    background: rgba(139, 92, 246, 0.18);
    border-color: rgba(139, 92, 246, 0.7);
    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.12);
}

.welcome-modal__checkbox:checked::after {
    transform: translateY(-1px) rotate(45deg) scale(1);
    border-color: #8b5cf6;
}

.welcome-modal__delayed {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 200ms ease;
}

.welcome-modal__delayed--visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

.welcome-modal__continue {
    width: 100%;
}
`;
    document.head.appendChild(style);
    stylesInjected = true;
}

function createCommunityButton(link: CommunityLink): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'frbc gap-2 rounded-2xl px-3 py-2 transition-all duration-400 w-fit welcome-modal__link';
    button.style.backgroundColor = '#ffffff07';
    button.style.border = '1px solid #ffffff11';

    const icon = document.createElement('img');
    icon.className = 'welcome-modal__icon';
    icon.alt = link.label;

    const iconCandidates = Array.isArray(link.icon) ? link.icon : [link.icon];
    let iconIndex = 0;
    const tryLoadIcon = () => {
        if (iconIndex >= iconCandidates.length) return;
        const currentSrc = iconCandidates[iconIndex];
        icon.src = currentSrc;
    };
    icon.addEventListener('error', () => {
        iconIndex += 1;
        tryLoadIcon();
    }, {once: false});
    tryLoadIcon();

    const label = document.createElement('span');
    label.className = 'welcome-modal__label text-nowrap';
    label.textContent = link.label;

    button.appendChild(icon);
    button.appendChild(label);

    button.addEventListener('click', () => {
        try {
            window.open(link.url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error('Failed to open link', { link: link.url, error });
        }
    });

    return button;
}

function ensureModalElements(): WelcomeModalElements {
    if (modalElements) return modalElements;

    ensureStyles();

    const overlay = document.createElement('div');
    overlay.className = 'welcome-overlay';

    const modal = document.createElement('div');
    modal.className = 'card fc gap-4 welcome-modal no-scrollbar';
    modal.style.width = 'min(640px, 96vw)';
    modal.style.maxHeight = '92vh';
    modal.style.overflow = 'auto';
    modal.style.padding = '28px 26px';
    modal.style.boxShadow = '0 28px 80px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(85, 78, 120, 0.35)';
    modal.style.border = '1px solid rgba(15, 118, 110, 0.25)';

    const header = document.createElement('div');
    header.className = 'frbc';

    const title = document.createElement('h2');
    title.textContent = 'Welcome to XEXAMAI';
    title.className = 'text-xl font-semibold';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-sm welcome-modal__delayed';
    closeBtn.textContent = '✕';
    closeBtn.style.width = '32px';
    closeBtn.style.minWidth = '32px';

    header.appendChild(title);
    header.appendChild(closeBtn);

    const description = document.createElement('p');
    description.className = 'text-sm text-gray-300';
    description.textContent = 'You will find a complete guide to use on our website. Connect with the community, follow project updates, and get the latest resources in one place.';

    const linksContainer = document.createElement('div');
    linksContainer.className = 'welcome-modal__links';

    for (const link of COMMUNITY_LINKS) {
        linksContainer.appendChild(createCommunityButton(link));
    }

    const footer = document.createElement('label');
    footer.className = 'welcome-modal__footer welcome-modal__delayed';

    const dismissCheckbox = document.createElement('input');
    dismissCheckbox.type = 'checkbox';
    dismissCheckbox.id = 'welcome-modal-dismiss';
    dismissCheckbox.className = 'welcome-modal__checkbox';

    const checkboxLabel = document.createElement('span');
    checkboxLabel.textContent = "Don't show again";

    footer.appendChild(dismissCheckbox);
    footer.appendChild(checkboxLabel);

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'btn btn-primary welcome-modal__continue welcome-modal__delayed';
    continueBtn.textContent = 'Continue';

    modal.appendChild(header);
    modal.appendChild(description);
    modal.appendChild(linksContainer);
    modal.appendChild(footer);
    modal.appendChild(continueBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (event) => {
        if (event.target !== overlay) return;
        if (!welcomeControlsEnabled) {
            event.stopPropagation();
            event.preventDefault();
            return;
        }
        void closeWelcomeModal();
    });

    closeBtn.addEventListener('click', () => {
        if (!welcomeControlsEnabled) return;
        void closeWelcomeModal();
    });

    continueBtn.addEventListener('click', () => {
        if (!welcomeControlsEnabled) return;
        void closeWelcomeModal();
    });

    modalElements = {
        overlay,
        modal,
        closeBtn,
        dismissCheckbox,
        footer,
        continueBtn,
    };

    return modalElements;
}

function attachEscapeHandler(): void {
    if (escapeHandler) return;
    escapeHandler = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            if (!welcomeControlsEnabled) return;
            event.preventDefault();
            void closeWelcomeModal();
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

function detachEscapeHandler(): void {
    if (!escapeHandler) return;
    document.removeEventListener('keydown', escapeHandler);
    escapeHandler = null;
}

async function closeWelcomeModal(): Promise<void> {
    if (!modalElements) return;
    const {overlay, dismissCheckbox, closeBtn, footer, continueBtn} = modalElements;
    overlay.classList.remove('welcome-overlay--visible');
    detachEscapeHandler();
    welcomeControlsEnabled = false;
    if (welcomeControlsTimer !== null) {
        window.clearTimeout(welcomeControlsTimer);
        welcomeControlsTimer = null;
    }
    closeBtn.classList.remove('welcome-modal__delayed--visible');
    footer.classList.remove('welcome-modal__delayed--visible');
    continueBtn.classList.remove('welcome-modal__delayed--visible');
    if (dismissCheckbox.checked) {
        try {
            await window.api.settings.setWelcomeModalDismissed(true);
        } catch (error) {
            console.error('Failed to persist welcome modal dismissal', error);
        }
    }
}

async function showWelcomeModal(): Promise<void> {
    const elements = ensureModalElements();
    elements.dismissCheckbox.checked = false;
    welcomeControlsEnabled = false;
    if (welcomeControlsTimer !== null) {
        window.clearTimeout(welcomeControlsTimer);
        welcomeControlsTimer = null;
    }
    elements.closeBtn.classList.remove('welcome-modal__delayed--visible');
    elements.footer.classList.remove('welcome-modal__delayed--visible');
    elements.continueBtn.classList.remove('welcome-modal__delayed--visible');
    attachEscapeHandler();
    requestAnimationFrame(() => {
        elements.overlay.classList.add('welcome-overlay--visible');
    });
    welcomeControlsTimer = window.setTimeout(() => {
        welcomeControlsEnabled = true;
        elements.closeBtn.classList.add('welcome-modal__delayed--visible');
        elements.footer.classList.add('welcome-modal__delayed--visible');
        elements.continueBtn.classList.add('welcome-modal__delayed--visible');
    }, 6000);
}

export async function initializeWelcomeModal(): Promise<void> {
    try {
        const settings = await window.api.settings.get();
        if (settings?.welcomeModalDismissed) {
            return;
        }
    } catch (error) {
        console.warn('Unable to read welcome modal setting, falling back to showing the modal', error);
    }
    await showWelcomeModal();
}

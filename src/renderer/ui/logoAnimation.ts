export function loadLogo(logoElement: HTMLImageElement | null): void {
    if (!logoElement) return;
    try {
        logoElement.src = '../../brand/logo_white.png';
        logoElement.onerror = () => {
            logoElement.src = 'brand/logo_white.png';
            logoElement.onerror = () => {
                logoElement.style.display = 'none';
            };
        };
    } catch (error) {
        console.warn('Could not load logo:', error);
        logoElement.style.display = 'none';
    }
}

export function startLogoAnimation(logoElement: HTMLImageElement, container: HTMLElement): void {
    const startAnimation = () => {
        setTimeout(() => {
            logoElement.classList.add('logo-fade-in');
        }, 100);

        setTimeout(() => {
            logoElement.classList.remove('logo-fade-in');
            logoElement.classList.add('logo-final-state');
            container.classList.add('final-state');
        }, 2500);
    };

    if (logoElement.complete && logoElement.naturalHeight !== 0) {
        startAnimation();
    } else {
        logoElement.addEventListener('load', startAnimation);
        setTimeout(startAnimation, 1000);
    }
}

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

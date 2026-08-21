(() => {
    const showFatalStartupError = (reason) => {
        const root = document.getElementById('root');
        if (!root || root.hasChildNodes()) return;
        const error = reason instanceof Error ? reason : null;
        const message = error?.message?.trim() || 'Unknown startup error';
        root.innerHTML = '';
        const panel = document.createElement('main');
        panel.setAttribute('role', 'alert');
        panel.style.cssText = [
            'box-sizing:border-box',
            'min-height:100%',
            'display:flex',
            'flex-direction:column',
            'justify-content:center',
            'padding:32px',
            'background:#111318',
            'color:#f5f7fb',
            'font:14px/1.5 system-ui,sans-serif',
        ].join(';');
        const title = document.createElement('h1');
        title.textContent = 'XEXAMAI could not start';
        title.style.cssText = 'margin:0 0 12px;font-size:20px';
        const details = document.createElement('p');
        details.textContent = message;
        details.style.cssText = 'margin:0;color:#ffb4ab;overflow-wrap:anywhere';
        const hint = document.createElement('p');
        hint.textContent = 'Open DevTools to copy the full error, then restart the app.';
        hint.style.cssText = 'margin:16px 0 0;color:#aeb7c6';
        panel.append(title, details, hint);
        root.append(panel);
    };

    window.addEventListener('error', (event) => {
        if (event instanceof ErrorEvent && event.error) showFatalStartupError(event.error);
    });
    window.addEventListener('unhandledrejection', (event) => showFatalStartupError(event.reason));
})();

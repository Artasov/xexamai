import {WindowResizer} from '../../common/WindowResizer/WindowResizer';

type LoadingScreenProps = {
    message?: string;
};

export function LoadingScreen({ message = 'Loading…' }: LoadingScreenProps) {
    const handleClose = () => {
        try {
            window.api?.window?.close();
        } catch {
        }
    };

    return (
        <div className="relative h-screen min-w-[330px] text-gray-100">
            <WindowResizer />
            <div
                className="rainbow pointer-events-none"
                style={{ position: 'absolute', width: '480px', height: '480px' }}
            />
            <header className="drag-region absolute top-0 left-0 right-0 flex items-center justify-end px-3 py-2" style={{ zIndex: 5 }}>
                <div className="window-controls no-drag -mr-1 flex items-center">
                    <button className="close mr-[11px]" title="Close" type="button" onClick={handleClose}>
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" fill="none" />
                        </svg>
                    </button>
                </div>
            </header>
            <div className="disable-tap-select relative flex h-full flex-col items-center justify-center gap-4 px-6" style={{ zIndex: 4 }}>
                <div className="loading-spinner" />
                <p className="text-sm text-gray-300">{message}</p>
            </div>
        </div>
    );
}

export default LoadingScreen;

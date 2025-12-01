import {useEffect} from 'react';
import {WindowResizer} from '../../common/WindowResizer/WindowResizer';
import {loadLogo} from '../../../ui/logoAnimation';

type LoadingScreenProps = {
    message?: string;
};

export function LoadingScreen({message = 'Loading…'}: LoadingScreenProps) {
    useEffect(() => {
        loadLogo(document.getElementById('loading-header-logo') as HTMLImageElement | null);
    }, []);

    const handleClose = () => {
        try {
            window.api?.window?.close();
        } catch {
        }
    };

    return (
        <div className="relative h-screen min-w-[330px] text-gray-100">
            <WindowResizer/>
            <div
                className="rainbow pointer-events-none"
                style={{position: 'absolute', width: '480px', height: '480px'}}
            />
            <header
                className="drag-region absolute top-0 left-0 right-0 flex items-center justify-between px-3 py-2"
                style={{zIndex: 5}}
            >
                <div className="pointer-events-none select-none frsc gap-3 text-gray-200">
                    <div className="relative" style={{width: '28px', height: '28px'}}>
                        <img
                            id="loading-header-logo"
                            alt="xexamai"
                            style={{width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 2}}
                        />
                        <div
                            className="rainbow"
                            style={{position: 'absolute', top: 0, left: 0, filter: 'blur(22px) saturate(1.5)'}}
                        />
                    </div>
                    <span className="text-base font-semibold tracking-wide">xexamai</span>
                </div>
                <div className="window-controls no-drag -mr-1 flex items-center">
                    <button className="close mr-[11px]" type="button" onClick={handleClose}>
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        </svg>
                    </button>
                </div>
            </header>
            <div className="disable-tap-select relative flex h-full flex-col items-center justify-center gap-4 px-6"
                 style={{zIndex: 4}}>
                <div className="loading-spinner"/>
                <p className="text-sm text-gray-300">{message}</p>
            </div>
        </div>
    );
}

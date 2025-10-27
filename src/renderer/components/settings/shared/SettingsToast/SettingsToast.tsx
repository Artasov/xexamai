import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import './SettingsToast.scss';

export type SettingsToastMessage = {
    text: string;
    tone: 'success' | 'error';
};

const ensureRoot = (): HTMLDivElement | null => {
    if (typeof document === 'undefined') return null;
    let root = document.getElementById('settings-toast-root') as HTMLDivElement | null;
    if (!root) {
        root = document.createElement('div');
        root.id = 'settings-toast-root';
        document.body.appendChild(root);
    }
    return root;
};

type SettingsToastProps = {
    message: SettingsToastMessage | null;
};

export const SettingsToast = ({ message }: SettingsToastProps) => {
    const portalRoot = useMemo(() => ensureRoot(), []);
    if (!message || !portalRoot) {
        return null;
    }

    return createPortal(
        <div className={`settings-toast settings-toast--${message.tone}`}>
            {message.text}
        </div>,
        portalRoot,
    );
};

export default SettingsToast;

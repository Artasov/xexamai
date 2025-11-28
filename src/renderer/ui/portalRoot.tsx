import {ReactNode} from 'react';
import {createRoot, Root} from 'react-dom/client';

export type PortalRoot = {
    ensure: () => void;
    destroy: () => void;
    render: (node: ReactNode) => void;
    isReady: () => boolean;
};

export function createPortalRoot(): PortalRoot {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;

    const ensure = () => {
        if (root && container) return;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    };

    const destroy = () => {
        if (root) {
            root.unmount();
            root = null;
        }
        if (container) {
            container.remove();
            container = null;
        }
    };

    const render = (node: ReactNode) => {
        if (!root || !container) return;
        root.render(node);
    };

    const isReady = () => Boolean(root && container);

    return { ensure, destroy, render, isReady };
}

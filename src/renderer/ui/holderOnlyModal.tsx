import {useEffect, useState} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Link,
    Stack,
    Typography,
} from '@mui/material';
import {ThemeProvider} from '@mui/material/styles';
import {muiTheme} from '../mui/config.mui';
import {getHolderState} from '../state/holderState';

export type HolderAccess = 'holder' | 'non-holder' | 'pending';

type HolderOnlyDialogProps = {
    open: boolean;
    onClose: () => void;
};

function HolderOnlyDialog({open, onClose}: HolderOnlyDialogProps) {
    const [mounted, setMounted] = useState(open);

    useEffect(() => {
        if (open) {
            setMounted(true);
        }
    }, [open]);

    if (!mounted && !open) {
        return null;
    }

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle>Screen processing is holder-only</DialogTitle>
            <DialogContent dividers>
                <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                        This feature is available only to token holders{' '}
                        <Typography component="span" variant="body2" color="text.primary" fontWeight={600}>
                            D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG
                        </Typography>
                        .
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        All links and instructions are available on our website:
                        {' '}
                        <Link
                            href="https://xldev.ru/en/xexamai"
                            target="_blank"
                            rel="noreferrer"
                            underline="hover"
                            color="primary"
                        >
                            https://xldev.ru/en/xexamai
                        </Link>
                        .
                    </Typography>
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} variant="contained">
                    Got it
                </Button>
            </DialogActions>
        </Dialog>
    );
}

let holderModalContainer: HTMLDivElement | null = null;
let holderModalRoot: Root | null = null;
let holderModalCloseTimer: number | null = null;
let holderModalOpen = false;

function ensureHolderModalRoot(): void {
    if (holderModalRoot && holderModalContainer) return;
    holderModalContainer = document.createElement('div');
    document.body.appendChild(holderModalContainer);
    holderModalRoot = createRoot(holderModalContainer);
}

function destroyHolderModalRoot(): void {
    if (holderModalCloseTimer !== null) {
        window.clearTimeout(holderModalCloseTimer);
        holderModalCloseTimer = null;
    }
    if (holderModalRoot) {
        holderModalRoot.unmount();
        holderModalRoot = null;
    }
    if (holderModalContainer) {
        holderModalContainer.remove();
        holderModalContainer = null;
    }
}

function renderHolderModal(open: boolean) {
    if (!holderModalRoot || !holderModalContainer) return;
    holderModalRoot.render(
        <ThemeProvider theme={muiTheme}>
            <HolderOnlyDialog open={open} onClose={handleHolderModalClose} />
        </ThemeProvider>,
    );
}

function handleHolderModalClose() {
    if (!holderModalRoot) return;
    holderModalOpen = false;
    renderHolderModal(false);
    if (holderModalCloseTimer !== null) {
        window.clearTimeout(holderModalCloseTimer);
    }
    holderModalCloseTimer = window.setTimeout(() => {
        destroyHolderModalRoot();
    }, 250);
}

export function showHolderOnlyModal(): void {
    if (holderModalOpen) {
        return;
    }
    ensureHolderModalRoot();
    holderModalOpen = true;
    if (holderModalCloseTimer !== null) {
        window.clearTimeout(holderModalCloseTimer);
        holderModalCloseTimer = null;
    }
    renderHolderModal(true);
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

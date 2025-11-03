import {useEffect, useState} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Stack,
    Typography,
} from '@mui/material';
import {ThemeProvider} from '@mui/material/styles';
import {muiTheme} from '../mui/config.mui';
import {checkFeatureAccess as checkFeatureAccessUtil} from '../utils/featureAccess';

type FeatureAccessDialogProps = {
    open: boolean;
    onClose: () => void;
    featureCode: 'screen_processing' | 'history' | 'promt_presets';
};

const featureLabels: Record<string, string> = {
    screen_processing: 'Screen Processing',
    history: 'History',
    promt_presets: 'Prompt Presets',
};

function FeatureAccessDialog({open, onClose, featureCode}: FeatureAccessDialogProps) {
    const [mounted, setMounted] = useState(open);

    useEffect(() => {
        if (open) {
            setMounted(true);
        }
    }, [open]);

    if (!mounted && !open) {
        return null;
    }

    const featureLabel = featureLabels[featureCode] || featureCode;

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle>Feature unavailable</DialogTitle>
            <DialogContent dividers>
                <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                        The feature <strong>{featureLabel}</strong> is not available for your current tier.
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Please check your Profile section to see available features and upgrade your tier if needed.
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

let featureModalContainer: HTMLDivElement | null = null;
let featureModalRoot: Root | null = null;
let featureModalCloseTimer: number | null = null;
let featureModalOpen = false;
let currentFeatureCode: 'screen_processing' | 'history' | 'promt_presets' = 'screen_processing';

function ensureFeatureModalRoot(): void {
    if (featureModalRoot && featureModalContainer) return;
    featureModalContainer = document.createElement('div');
    document.body.appendChild(featureModalContainer);
    featureModalRoot = createRoot(featureModalContainer);
}

function destroyFeatureModalRoot(): void {
    if (featureModalCloseTimer !== null) {
        window.clearTimeout(featureModalCloseTimer);
        featureModalCloseTimer = null;
    }
    if (featureModalRoot) {
        featureModalRoot.unmount();
        featureModalRoot = null;
    }
    if (featureModalContainer) {
        featureModalContainer.remove();
        featureModalContainer = null;
    }
}

function renderFeatureModal(open: boolean) {
    if (!featureModalRoot || !featureModalContainer) return;
    featureModalRoot.render(
        <ThemeProvider theme={muiTheme}>
            <FeatureAccessDialog open={open} onClose={handleFeatureModalClose} featureCode={currentFeatureCode} />
        </ThemeProvider>,
    );
}

function handleFeatureModalClose() {
    if (!featureModalRoot) return;
    featureModalOpen = false;
    renderFeatureModal(false);
    if (featureModalCloseTimer !== null) {
        window.clearTimeout(featureModalCloseTimer);
    }
    featureModalCloseTimer = window.setTimeout(() => {
        destroyFeatureModalRoot();
    }, 250);
}

export function showFeatureAccessModal(featureCode: 'screen_processing' | 'history' | 'promt_presets'): void {
    if (featureModalOpen) {
        return;
    }
    ensureFeatureModalRoot();
    currentFeatureCode = featureCode;
    featureModalOpen = true;
    if (featureModalCloseTimer !== null) {
        window.clearTimeout(featureModalCloseTimer);
        featureModalCloseTimer = null;
    }
    renderFeatureModal(true);
}

export function checkFeatureAccess(featureCode: 'screen_processing' | 'history' | 'promt_presets'): boolean {
    return checkFeatureAccessUtil(featureCode);
}

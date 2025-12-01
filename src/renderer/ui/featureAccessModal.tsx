import {useEffect, useState} from 'react';
import {Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, Stack, Typography,} from '@mui/material';
import {ThemeProvider} from '@mui/material/styles';
import {muiTheme} from '../mui/config.mui';
import {checkFeatureAccess as checkFeatureAccessUtil, getCurrentUser} from '../utils/featureAccess';
import {getActiveTier, getMinTierForFeature} from '../utils/features';
import {createPortalRoot} from './portalRoot';

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

function formatBalance(balance: string): string {
    const num = parseFloat(balance);
    if (isNaN(num)) return balance;
    return new Intl.NumberFormat('en-US', {maximumFractionDigits: 2}).format(num);
}

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
    const user = getCurrentUser();
    const activeTierInfo = getActiveTier(user);
    const minTierInfo = getMinTierForFeature(user, featureCode);

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Feature unavailable</DialogTitle>
            <DialogContent dividers className="custom-dropdown-scrollbar">
                <Stack spacing={3}>
                    <Typography variant="body2" color="text.secondary">
                        The feature <strong>{featureLabel}</strong> is not available for your current tier.
                    </Typography>

                    {activeTierInfo && (
                        <Box sx={{
                            p: 2,
                            borderRadius: 2,
                            backgroundColor: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)'
                        }}>
                            <Stack spacing={1.5}>
                                <Typography variant="caption" color="text.secondary"
                                            sx={{textTransform: 'uppercase', letterSpacing: '0.5px'}}>
                                    Your current status
                                </Typography>
                                <Stack direction="row" justifyContent="space-between" alignItems="center">
                                    <Typography variant="body2" color="text.secondary">
                                        Balance:
                                    </Typography>
                                    <Typography variant="body1" fontWeight={600} color="text.primary">
                                        {formatBalance(activeTierInfo.balance)} {activeTierInfo.ticker}
                                    </Typography>
                                </Stack>
                                <Stack direction="row" justifyContent="space-between" alignItems="center">
                                    <Typography variant="body2" color="text.secondary">
                                        Current Tier:
                                    </Typography>
                                    <Typography variant="body1" fontWeight={600} color="text.primary">
                                        {activeTierInfo.tier}
                                    </Typography>
                                </Stack>
                            </Stack>
                        </Box>
                    )}

                    {minTierInfo && (
                        <Box sx={{
                            p: 2,
                            borderRadius: 2,
                            backgroundColor: 'rgba(139, 92, 246, 0.1)',
                            border: '1px solid rgba(139, 92, 246, 0.2)'
                        }}>
                            <Stack spacing={1.5}>
                                <Typography variant="caption" color="text.secondary"
                                            sx={{textTransform: 'uppercase', letterSpacing: '0.5px'}}>
                                    Required for {featureLabel}
                                </Typography>
                                <Stack direction="row" justifyContent="space-between" alignItems="center">
                                    <Typography variant="body2" color="text.secondary">
                                        Minimum Tier:
                                    </Typography>
                                    <Typography variant="body1" fontWeight={600} color="primary.main">
                                        {minTierInfo.tier.name}
                                    </Typography>
                                </Stack>
                                <Stack direction="row" justifyContent="space-between" alignItems="center">
                                    <Typography variant="body2" color="text.secondary">
                                        Required Balance:
                                    </Typography>
                                    <Typography variant="body1" fontWeight={600} color="primary.main">
                                        {formatBalance(minTierInfo.threshold)} {activeTierInfo?.ticker || 'XEXAI'}
                                    </Typography>
                                </Stack>
                                {minTierInfo.tier.description && (
                                    <Typography variant="caption" color="text.secondary"
                                                sx={{mt: 0.5, fontStyle: 'italic'}}>
                                        {minTierInfo.tier.description}
                                    </Typography>
                                )}
                            </Stack>
                        </Box>
                    )}

                    <Typography variant="body2" color="text.secondary">
                        Please{' '}
                        <Link
                            href="https://xldev.ru/en/profile?tab=tokens"
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{
                                color: 'primary.main',
                                textDecoration: 'underline',
                                '&:hover': {
                                    color: 'primary.light',
                                },
                            }}
                        >
                            check your Profile
                        </Link>
                        {' '}section to see available features and upgrade your tier if needed.
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

let featureModalCloseTimer: number | null = null;
let featureModalOpen = false;
let currentFeatureCode: 'screen_processing' | 'history' | 'promt_presets' = 'screen_processing';
const featurePortal = createPortalRoot();

function ensureFeatureModalRoot(): void {
    featurePortal.ensure();
}

function destroyFeatureModalRoot(): void {
    if (featureModalCloseTimer !== null) {
        window.clearTimeout(featureModalCloseTimer);
        featureModalCloseTimer = null;
    }
    featurePortal.destroy();
}

function renderFeatureModal(open: boolean) {
    if (!featurePortal.isReady()) return;
    featurePortal.render(
        <ThemeProvider theme={muiTheme}>
            <FeatureAccessDialog open={open} onClose={handleFeatureModalClose} featureCode={currentFeatureCode}/>
        </ThemeProvider>,
    );
}

function handleFeatureModalClose() {
    if (!featureModalOpen) return;
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

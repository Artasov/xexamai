import {MouseEvent, useEffect, useMemo, useState} from 'react';
import {
    Box,
    Button,
    ButtonBase,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Stack,
    Typography,
} from '@mui/material';
import {ThemeProvider} from '@mui/material/styles';
import {muiTheme} from '../mui/config.mui';
import {createPortalRoot} from './portalRoot';

type CommunityLink = {
    label: string;
    url: string;
    icon: string | string[];
};

type WelcomeDialogProps = {
    open: boolean;
    onClose: (options: { dismiss?: boolean }) => void;
};

const COMMUNITY_LINKS: CommunityLink[] = [
    {
        label: 'Website',
        url: 'https://artasov.github.io/xexamai/',
        icon: ['../../brand/logo_white.png', 'brand/logo_white.png'],
    },
    {
        label: 'X Community',
        url: 'https://x.com/i/communities/1978030402209034469',
        icon: 'img/icons/community/x.svg',
    },
    {
        label: 'Telegram',
        url: 'https://t.me/xexamai',
        icon: 'img/icons/community/telegram.svg',
    },
    {
        label: 'GitHub',
        url: 'https://github.com/Artasov/xexamai',
        icon: 'img/icons/community/github.svg',
    },
    {
        label: 'Pump.fun',
        url: 'https://pump.fun/coin/D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG',
        icon: 'img/icons/community/pumpfun.webp',
    },
    {
        label: 'Dexscreener',
        url: 'https://dexscreener.com/solana/D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG',
        icon: 'img/icons/community/dexscreener.svg',
    },
    {
        label: 'YouTube',
        url: 'https://www.youtube.com/watch?v=ilKcTjacg78',
        icon: 'img/icons/community/youtube.svg',
    },
    {
        label: 'LinkedIn',
        url: 'https://www.linkedin.com/in/xlartas',
        icon: 'img/icons/community/linkedin.svg',
    },
    {
        label: 'Discord',
        url: 'https://discord.gg/mcUKZmcB',
        icon: 'img/icons/community/discrod.svg',
    },
    {
        label: 'X Developer',
        url: 'https://x.com/xlartasov',
        icon: 'img/icons/community/x.svg',
    },
];

function openLink(url: string) {
    try {
        window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
        console.error('Failed to open link', {url, error});
    }
}

function CommunityTile({link}: { link: CommunityLink }) {
    const iconCandidates = useMemo(
        () => (Array.isArray(link.icon) ? link.icon : [link.icon]),
        [link.icon],
    );
    const [iconIndex, setIconIndex] = useState(0);
    const iconSrc = iconCandidates[Math.min(iconIndex, iconCandidates.length - 1)];

    const handleIconError = () => {
        setIconIndex((prev) => Math.min(prev + 1, iconCandidates.length - 1));
    };

    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        openLink(link.url);
    };

    return (
        <Box component="div" sx={{width: '100%'}}>
            <ButtonBase
                onClick={handleClick}
                sx={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    alignItems: 'center',
                    gap: 1.5,
                    px: 2,
                    py: 1.5,
                    borderRadius: 3,
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                        backgroundColor: 'rgba(148, 163, 184, 0.12)',
                        borderColor: 'rgba(148, 163, 184, 0.35)',
                    },
                }}
            >
                <Box
                    component="img"
                    src={iconSrc}
                    alt={link.label}
                    onError={handleIconError}
                    sx={{
                        width: 32,
                        height: 32,
                        objectFit: 'contain',
                        filter: 'drop-shadow(0 4px 12px rgba(15,23,42,0.55))',
                    }}
                />
                <Typography variant="subtitle2" fontWeight={600} color="text.primary">
                    {link.label}
                </Typography>
            </ButtonBase>
        </Box>
    );
}

function WelcomeDialog({open, onClose}: WelcomeDialogProps) {
    const [dismiss, setDismiss] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(false);

    useEffect(() => {
        let timer: number | null = null;
        if (open) {
            setDismiss(false);
            setControlsVisible(false);
            timer = window.setTimeout(() => {
                setControlsVisible(true);
            }, 6000);
        } else {
            setControlsVisible(false);
        }

        return () => {
            if (timer !== null) {
                window.clearTimeout(timer);
            }
        };
    }, [open]);

    if (!open) {
        return null;
    }

    return (
        <Dialog open={open} onClose={() => {
        }} maxWidth="md" fullWidth>
            <DialogTitle>
                <Typography variant="h5" component="h2">
                    Welcome to XEXAMAI
                </Typography>
                <Typography variant="body2" color="text.secondary" mt={1.5}>
                    You will find a complete guide on our website. Connect with the community, follow project updates,
                    and get the latest resources in one place.
                </Typography>
            </DialogTitle>
            <DialogContent dividers>
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                            xs: 'repeat(1, minmax(0, 1fr))',
                            sm: 'repeat(2, minmax(0, 1fr))',
                            md: 'repeat(3, minmax(0, 1fr))',
                        },
                        gap: 1.5,
                    }}
                >
                    {COMMUNITY_LINKS.map((link) => (
                        <CommunityTile key={link.label} link={link}/>
                    ))}
                </Box>
            </DialogContent>
            <DialogActions sx={{flexDirection: 'column', alignItems: 'stretch', gap: 1.5}}>
                <FormControlLabel
                    control={
                        <Checkbox
                            checked={dismiss}
                            onChange={(event) => setDismiss(event.target.checked)}
                            sx={{color: 'rgba(148, 163, 184, 0.7)'}}
                        />
                    }
                    label="Don't show again"
                    sx={{
                        alignSelf: 'stretch',
                        m: 0,
                        opacity: controlsVisible ? 1 : 0.2,
                        pointerEvents: controlsVisible ? 'auto' : 'none',
                        transition: 'opacity 0.3s ease',
                    }}
                />
                <Stack direction="row" gap={1.5} alignSelf="stretch">
                    <Button
                        variant="outlined"
                        fullWidth
                        disabled={!controlsVisible}
                        onClick={() => controlsVisible && onClose({dismiss})}
                    >
                        Close
                    </Button>
                    <Button
                        variant="contained"
                        fullWidth
                        disabled={!controlsVisible}
                        onClick={() => controlsVisible && onClose({dismiss})}
                    >
                        Continue
                    </Button>
                </Stack>
                <Typography
                    variant="caption"
                    color="text.secondary"
                    textAlign="center"
                    sx={{opacity: controlsVisible ? 1 : 0.4}}
                >
                    Controls unlock after 6 seconds — take a moment to explore all links.
                </Typography>
            </DialogActions>
        </Dialog>
    );
}

let welcomeModalOpen = false;
const welcomePortal = createPortalRoot();

function ensureWelcomeModalRoot(): void {
    welcomePortal.ensure();
}

function destroyWelcomeModalRoot(): void {
    welcomePortal.destroy();
    welcomeModalOpen = false;
}

function renderWelcomeModal(open: boolean, onClose: (options: { dismiss?: boolean }) => void) {
    if (!welcomePortal.isReady()) return;
    welcomePortal.render(
        <ThemeProvider theme={muiTheme}>
            <WelcomeDialog open={open} onClose={onClose}/>
        </ThemeProvider>,
    );
}

async function handleWelcomeModalClose(options: { dismiss?: boolean }) {
    if (!welcomeModalOpen) {
        destroyWelcomeModalRoot();
        return;
    }

    if (options.dismiss) {
        try {
            await window.api.settings.setWelcomeModalDismissed(true);
        } catch (error) {
            console.error('Failed to persist welcome modal dismissal', error);
        }
    }

    renderWelcomeModal(false, handleWelcomeModalClose);
    // Allow Dialog to animate out before unmounting
    window.setTimeout(() => destroyWelcomeModalRoot(), 250);
}

async function showWelcomeModal(): Promise<void> {
    ensureWelcomeModalRoot();
    welcomeModalOpen = true;
    renderWelcomeModal(true, handleWelcomeModalClose);
}

export async function initializeWelcomeModal(): Promise<void> {
    try {
        const settings = await window.api.settings.get();
        if (settings?.welcomeModalDismissed) {
            return;
        }
    } catch (error) {
        console.warn('Unable to read welcome modal setting, falling back to showing the modal', error);
    }

    await showWelcomeModal();
}

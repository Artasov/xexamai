import {alpha, createTheme, ThemeOptions} from '@mui/material/styles';

const palette = {
    mode: 'dark' as const,
    primary: {
        main: '#8b5cf6',
        light: '#a78bfa',
        dark: '#6d28d9',
    },
    secondary: {
        main: '#38bdf8',
    },
    background: {
        default: '#080c14',
        paper: 'rgba(10, 14, 22, 0.95)',
    },
    text: {
        primary: '#f1f5f9',
        secondary: '#cbd5f5',
    },
    divider: 'rgba(148, 163, 184, 0.18)',
};

const menuScrollbar = {
    scrollbarWidth: 'thin' as const,
    scrollbarColor: `${palette.primary.main} rgba(139, 92, 246, 0.18)`,
    '&::-webkit-scrollbar': {
        width: '10px',
    },
    '&::-webkit-scrollbar-track': {
        background: 'linear-gradient(180deg, rgba(12,17,27,0.95), rgba(12,17,27,0.75))',
        borderRadius: '9999px',
        boxShadow: 'inset 0 0 0 1px rgba(139, 92, 246, 0.12)',
    },
    '&::-webkit-scrollbar-thumb': {
        background: 'linear-gradient(180deg, #a78bfa, #8b5cf6) !important',
        borderRadius: '9999px',
        border: '2px solid rgba(12, 17, 27, 0.9) !important',
        boxShadow: 'inset 0 1px 2px rgba(255, 255, 255, 0.12) !important',
        transition: 'background 200ms ease, box-shadow 200ms ease',
    },
    '&::-webkit-scrollbar-thumb:hover': {
        background: 'linear-gradient(180deg, #c4b5fd, #8b5cf6) !important',
        boxShadow: 'inset 0 1px 2px rgba(255, 255, 255, 0.2), 0 0 6px rgba(139, 92, 246, 0.18) !important',
    },
};

const components: ThemeOptions['components'] = {
    MuiCssBaseline: {
        styleOverrides: {
            body: {
                backgroundColor: '#080c14',
                color: '#f1f5f9',
            },
        },
    },
    MuiDialog: {
        styleOverrides: {
            paper: {
                borderRadius: '18px',
                padding: 0,
                background: 'rgba(0, 0, 0, 0.2)',
                border: '1px solid rgba(255, 255, 255, 0.04)',
                boxShadow: '0 30px 90px rgba(4, 6, 12, 0.6)',
                backdropFilter: 'none',
                backgroundColor: '#0005',
                '&.MuiDialog-paperScrollPaper': {
                    maxHeight: '90vh',
                },
            },
        },
        defaultProps: {
            fullWidth: true,
            maxWidth: 'sm',
        },
    },
    MuiDialogContent: {
        styleOverrides: {
            root: {
                padding: '24px',
                backgroundColor: 'transparent',
            },
        },
    },
    MuiDialogActions: {
        styleOverrides: {
            root: {
                padding: '20px 24px',
                gap: '12px',
                backgroundColor: 'transparent',
            },
        },
    },
    MuiBackdrop: {
        styleOverrides: {
            root: {
                backdropFilter: 'blur(12px)',
                backgroundColor: 'rgba(4, 6, 12, 0.6)',
            },
        },
    },
    MuiButton: {
        defaultProps: {
            disableElevation: true,
        },
        styleOverrides: {
            root: {
                borderRadius: '12px',
                textTransform: 'none',
                fontWeight: 600,
                letterSpacing: '0.015em',
                paddingInline: '18px',
                paddingBlock: '4px',
                transition: 'all 0.3s ease',
            },
            contained: {
                color: '#f8fafc',
                background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
                border: 0,
                boxShadow: '0 1px 8px rgba(0, 0, 0, 0.2)',
                position: 'relative',
                overflow: 'hidden',
                '&::before': {
                    content: '""',
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.14), rgba(59, 130, 246, 0.08))',
                    opacity: 0,
                    transition: 'opacity 0.3s ease',
                    zIndex: 0,
                },
                '&::after': {
                    content: '""',
                    position: 'absolute',
                    inset: 0,
                    background: 'radial-gradient(circle at center, rgba(255,255,255,0.12) 0%, transparent 70%)',
                    opacity: 0,
                    transition: 'opacity 0.3s ease',
                    zIndex: 0,
                },
                '& > *': {
                    position: 'relative',
                    zIndex: 1,
                },
                '&:hover': {
                    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
                    borderColor: 'rgba(148, 163, 184, 0.3)',
                    '&::before, &::after': {
                        opacity: 1,
                    },
                },
                '&:disabled': {
                    background: 'rgba(17, 24, 39, 0.35)',
                    borderColor: 'rgba(148, 163, 184, 0.12)',
                    boxShadow: 'none',
                },
            },
            outlined: {
                color: '#f8fafc',
                border: '0',
                transition: 'all 0.3s ease',
                background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
                boxShadow: '0 1px 6px rgba(0, 0, 0, 0.2)',
                '&:hover': {
                    borderColor: 'rgba(148, 163, 184, 0.3)',
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.03) 100%)',
                    boxShadow: '0 6px 16px rgba(0, 0, 0, 0.3)',
                },
            },
            text: {
                color: '#f1f5f9',
            },
        },
    },
    MuiFormLabel: {
        styleOverrides: {
            root: {
                color: 'rgba(196, 205, 222, 0.78)',
                fontSize: '0.82rem',
                letterSpacing: '0.04em',
                textTransform: 'none',
                '&.Mui-focused': {
                    color: '#f8fafc',
                },
            },
        },
    },
    MuiInputLabel: {
        styleOverrides: {
            root: {
                transform: 'translate(14px, 12px) scale(1)',
                '&.MuiInputLabel-shrink': {
                    transform: 'translate(14px, -8px) scale(0.85)',
                },
            },
        },
    },
    MuiOutlinedInput: {
        styleOverrides: {
            root: {
                borderRadius: '14px',
                backgroundColor: 'rgba(0, 0, 0, 0.1)',
                transition: 'all 0.2s ease',
                '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(255, 255, 255, 0.04)',
                    transition: 'all 0.3s ease',
                    borderWidth: '1px',
                },
                '&:hover .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(255, 255, 255, 0.2)',
                    borderWidth: '1px',
                },
                '&.Mui-focused': {
                    backgroundColor: 'rgba(0, 0, 0, 0.16)',
                    boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.06)',
                },
                '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(255, 255, 255, 0.2)',
                    borderWidth: '1px',
                },
            },
            input: {
                color: '#f9fafb',
                padding: '9px 14px 12px',
            },
            multiline: {
                padding: 0,
            },
        },
    },
    MuiTextField: {
        defaultProps: {
            variant: 'outlined',
            fullWidth: true,
        },
    },
    MuiMenu: {
        defaultProps: {
            disablePortal: false,
            slotProps: {
                backdrop: {
                    invisible: true,
                    sx: {
                        backgroundColor: 'transparent',
                        backdropFilter: 'none',
                    },
                },
            },
        },
        styleOverrides: {
            paper: {
                borderRadius: '16px',
                marginTop: '8px',
                border: `1px solid ${alpha(palette.primary.main, 0.35)}`,
                backgroundColor: 'transparent !important',
                backdropFilter: 'blur(18px) saturate(160%)',
                color: '#e2e8f0',
                boxShadow: '0 20px 40px rgba(0,0,0,0.45)',
                overflow: 'hidden',
                maxHeight: '60vh',
                ...menuScrollbar,
            },
            list: {
                paddingTop: '8px',
                paddingBottom: '8px',
                backgroundColor: 'transparent',
                overflowY: 'auto',
                maxHeight: 'inherit',
                ...menuScrollbar,
                '& .MuiMenuItem-root': {
                    borderRadius: '10px',
                    margin: '4px 8px',
                    fontWeight: 500,
                    fontSize: '0.94rem',
                    color: '#e2e8f0',
                    transition: 'background-color 150ms ease, color 150ms ease',
                    '&:hover': {
                        backgroundColor: alpha(palette.primary.main, 0.08),
                    },
                    '&.Mui-selected': {
                        backgroundColor: alpha(palette.primary.main, 0.12),
                        color: '#f8fafc',
                        '&:hover': {
                            backgroundColor: alpha(palette.primary.main, 0.18),
                        },
                    },
                },
            },
        },
    },
    MuiMenuList: {
        styleOverrides: {
            root: {
                ...menuScrollbar,
            },
        },
    },
    MuiPaper: {
        styleOverrides: {
            root: {
                backgroundImage: 'none',
                '&.MuiMenu-paper, &.MuiPopover-paper': {
                    ...menuScrollbar,
                    backgroundColor: 'transparent !important',
                    backdropFilter: 'blur(18px) saturate(160%)',
                    borderColor: alpha(palette.primary.main, 0.35),
                },
            },
        },
    },
};

const typography: ThemeOptions['typography'] = {
    fontFamily: `'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif`,
    button: {
        fontWeight: 600,
    },
};

export const muiTheme = createTheme({
    palette,
    typography,
    components,
});

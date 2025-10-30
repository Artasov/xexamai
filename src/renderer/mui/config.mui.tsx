import {createTheme, ThemeOptions} from '@mui/material/styles';

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
        paper: 'rgba(18, 23, 36, 0.96)',
    },
    text: {
        primary: '#f1f5f9',
        secondary: '#cbd5f5',
    },
    divider: 'rgba(148, 163, 184, 0.25)',
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
                borderRadius: '20px',
                padding: '0',
                background: 'rgba(18, 23, 36, 0.96)',
                border: '1px solid rgba(129, 140, 248, 0.35)',
                boxShadow: '0 40px 120px rgba(15, 23, 42, 0.6)',
                backdropFilter: 'blur(18px)',
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
                borderTop: '1px solid rgba(129, 140, 248, 0.2)',
                borderBottom: '1px solid rgba(129, 140, 248, 0.2)',
                backgroundColor: 'rgba(12, 17, 27, 0.85)',
            },
        },
    },
    MuiDialogActions: {
        styleOverrides: {
            root: {
                padding: '20px 24px',
                gap: '12px',
                backgroundColor: 'rgba(12, 17, 27, 0.9)',
            },
        },
    },
    MuiButton: {
        defaultProps: {
            disableElevation: true,
        },
        styleOverrides: {
            root: {
                borderRadius: '999px',
                textTransform: 'none',
                fontWeight: 600,
                letterSpacing: '0.02em',
            },
            contained: {
                background: 'linear-gradient(135deg, #8b5cf6 0%, #38bdf8 100%)',
                boxShadow: '0 12px 30px rgba(59, 130, 246, 0.35)',
                '&:hover': {
                    background: 'linear-gradient(135deg, #a78bfa 0%, #38bdf8 100%)',
                    boxShadow: '0 16px 40px rgba(59, 130, 246, 0.45)',
                },
            },
            outlined: {
                borderColor: 'rgba(148, 163, 184, 0.35)',
                color: '#f8fafc',
                '&:hover': {
                    borderColor: 'rgba(148, 163, 184, 0.6)',
                    backgroundColor: 'rgba(148, 163, 184, 0.08)',
                },
            },
        },
    },
    MuiFormLabel: {
        styleOverrides: {
            root: {
                color: 'rgba(148, 163, 184, 0.85)',
                fontSize: '0.8rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
            },
        },
    },
    MuiOutlinedInput: {
        styleOverrides: {
            root: {
                borderRadius: '14px',
                backgroundColor: 'rgba(0, 0, 0, 0.3)',
                transition: 'all 0.2s ease',
                '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(255, 255, 255, 0.05)',
                    transition: 'all 0.4s ease',
                },
                '&:hover .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                },
                '&.Mui-focused': {
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.25)',
                },
                '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(139, 92, 246, 0)',
                },
            },
            input: {
                color: '#f8fafc',
            },
            multiline: {
                padding: '14px',
            },
        },
    },
    MuiTextField: {
        defaultProps: {
            variant: 'outlined',
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

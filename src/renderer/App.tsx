import {useEffect, useRef, useState} from 'react';
import {TextField} from '@mui/material';
import { initializeRenderer } from './renderer';
import { setStatus } from './ui/status';
import { SettingsView } from './components/settings/SettingsView/SettingsView';
import { WindowResizer } from './components/common/WindowResizer/WindowResizer';
import {ThemeProvider, CssBaseline} from '@mui/material';
import {AuthProvider, useAuth} from './auth';
import {LoginView} from './components/auth/LoginView/LoginView';
import {LoadingScreen} from './components/auth/LoadingScreen/LoadingScreen';
import {ProfileView} from './components/auth/ProfileView/ProfileView';
import {BetaFeedbackWidget} from './components/feedback/BetaFeedbackWidget';
import {muiTheme} from './mui/config.mui';

function AuthenticatedApp() {
    const initializedRef = useRef(false);
    const [activeTab, setActiveTab] = useState<'main' | 'settings' | 'profile'>('main');

    useEffect(() => {
        if (initializedRef.current) return;
        initializedRef.current = true;
        initializeRenderer().catch((error) => {
            console.error(error);
            setStatus('Initialization error', 'error');
        });
    }, []);

    return (
        <div className="app-grid disable-tap-select relative fc h-screen min-w-[330px] text-gray-100">
            <WindowResizer />
            <div
                className="rainbow pointer-events-none"
                style={{ position: 'absolute', width: '500px', height: '500px' }}
            />

            <div
                className="logo-container pointer-events-none fccc"
                style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 2 }}
            >
                <img id="main-logo" alt="xexamai" style={{ width: '70vmin' }} />
            </div>

            <header className="app-header frbc px-3 py-2 text-gray-100 drag-region">
                <div className="frsc gap-3">
                    <div className="relative" style={{ width: '32px', height: '32px' }}>
                        <img
                            id="header-logo"
                            alt="xexamai"
                            style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 2 }}
                        />
                        <div
                            className="rainbow"
                            style={{ position: 'absolute', top: 0, left: 0, filter: 'blur(25px) saturate(1.5)' }}
                        />
                    </div>
                    <h1 className="text-lg font-semibold">xexamai</h1>
                    <div id="status" className="status-badge ready">
                        Ready
                    </div>
                </div>
                <div className="no-drag" />
                <div className="window-controls no-drag -mr-1">
                    <button id="closeBtn" className="close mr-[11px]" type="button">
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" fill="none" />
                        </svg>
                    </button>
                </div>
            </header>

            <main className="flex flex-1 flex-col overflow-auto px-4 pb-4 pt-1">
                <div className="tabs-container">
                    <div className="tabs">
                        <button
                            className={`tab ${activeTab === 'main' ? 'active' : ''}`}
                            type="button"
                            onClick={() => setActiveTab('main')}
                        >
                            Main
                        </button>
                        <button
                            className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
                            type="button"
                            onClick={() => setActiveTab('settings')}
                        >
                            Settings
                        </button>
                        <button
                            className={`tab ${activeTab === 'profile' ? 'active' : ''}`}
                            type="button"
                            onClick={() => setActiveTab('profile')}
                        >
                            Profile
                        </button>
                    </div>
                </div>

                <div className="content-area flex flex-col gap-4 overflow-auto" hidden={activeTab !== 'main'}>
                    <section className="flex flex-col gap-4 overflow-auto md:flex-row">
                        <div className="card h-min flex-grow md:max-w-[320px]">
                            <div id="send-last-container" className="send-last-container">
                                <div className="label mb-2">Send the last:</div>
                                <div id="durations" className="flex flex-wrap gap-2" />
                            </div>

                            <div className="mt-2 flex items-center gap-4">
                                <button id="btnRecord" className="btn" data-state="idle" type="button">
                                    Start Audio Loop
                                </button>
                                <button id="btnToggleInput" type="button">
                                    <img
                                        id="toggleInputIcon"
                                        src="img/icons/mic.png"
                                        alt="MIC"
                                        className="h-5 w-5"
                                        style={{ filter: 'invert(1)', opacity: '80%' }}
                                    />
                                </button>
                                <div id="waveform-container" className="flex-1" />
                                <button
                                    id="btnScreenshot"
                                    type="button"
                                    className="btn btn-secondary"
                                >
                                    <img src="img/icons/image.png" alt="Screenshot" className="h-5 w-5 invert" />
                                </button>
                            </div>

                            <div className="mt-2 flex flex-col">
                                <div className="flex h-[42px] items-stretch gap-2">
                                    <div className="h-full flex-grow">
                                        <TextField
                                            id="textInput"
                                            placeholder="Type your question here..."
                                            fullWidth
                                            variant="outlined"
                                            size="small"
                                            multiline
                                            minRows={1}
                                            maxRows={4}
                                            sx={{
                                                height: '100%',
                                                '& .MuiInputBase-root': {
                                                    height: '100%',
                                                    alignItems: 'center',
                                                },
                                            }}
                                        />
                                    </div>
                                    <div className="h-full">
                                        <button
                                            id="btnSendText"
                                            className="btn btn-primary h-full"
                                            type="button"
                                            disabled
                                        >
                                            Send
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div id="streamResultsSection" className="mt-2 hidden">
                                <div className="label mb-2">Stream Results:</div>
                                <div className="flex gap-2">
                                    <TextField
                                        id="streamResultsTextarea"
                                        placeholder="Stream transcription will appear here..."
                                        variant="outlined"
                                        multiline
                                        minRows={4}
                                        fullWidth
                                    />
                                    <button
                                        id="btnSendStreamText"
                                        className="btn btn-primary self-start"
                                        type="button"
                                        disabled
                                    >
                                        Send
                                    </button>
                                </div>
                                </div>
                        </div>

                        <div className="card flex flex-grow flex-col overflow-y-auto">
                            <div className="label mb-1">Recognized</div>
                            <div id="textOut" />
                            <div className="mt-4 mb-1 flex items-center gap-2">
                                <div className="label">Reply</div>
                                <button
                                    id="btnStopStream"
                                    className="btn btn-secondary hidden !px-1 !py-0 text-xs"
                                    type="button"
                                >
                                    Stop
                                </button>
                            </div>
                            <div id="answerOut" className="min-h-[1rem] overflow-auto" />
                        </div>
                    </section>
                </div>

                <div className="content-area flex flex-col overflow-auto" hidden={activeTab !== 'settings'}>
                    <SettingsView />
                </div>
                <div className="content-area flex flex-col overflow-auto" hidden={activeTab !== 'profile'}>
                    <ProfileView />
                </div>
            </main>

            <footer
                className="pointer-events-none absolute bottom-2 left-0 right-0 flex items-end justify-between px-3 text-[9px] font-light opacity-40"
                style={{ fontWeight: 300 }}
            >
                <div className="pointer-events-auto space-x-1 text-gray-300">
                    <span className="opacity-70">by Nikita Artasov</span>
                    <a
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#c3a5ff]"
                        href="https://t.me/artasov"
                    >
                        @artasov
                    </a>
                </div>
                <div className="pointer-events-auto">
                    <BetaFeedbackWidget />
                </div>
            </footer>
        </div>
    );
}

function AppContent() {
    const { status, isAuthenticated } = useAuth();

    if (status === 'initializing' || status === 'checking') {
        return <LoadingScreen message={status === 'checking' ? 'Restoring session…' : 'Launching…'} />;
    }

    if (!isAuthenticated) {
        return <LoginView />;
    }

    return <AuthenticatedApp />;
}

export function App() {
    return (
        <ThemeProvider theme={muiTheme}>
            <CssBaseline />
            <AuthProvider>
                <AppContent />
            </AuthProvider>
        </ThemeProvider>
    );
}

export default App;

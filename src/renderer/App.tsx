import {useEffect, useRef, useState} from 'react';
import {CssBaseline, ThemeProvider} from '@mui/material';
import {ToastContainer} from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './styles/toast.sass';
import {WindowResizer} from './components/common/WindowResizer/WindowResizer';
import {AuthProvider, useAuth} from './auth';
import {LoginView} from './components/auth/LoginView/LoginView';
import {LoadingScreen} from './components/auth/LoadingScreen/LoadingScreen';
import {BetaFeedbackWidget} from './components/feedback/BetaFeedbackWidget';
import {UpdateCenter} from './components/update/UpdateCenter';
import {MainWorkspace} from './components/main/MainWorkspace';
import {SettingsView} from './components/settings/SettingsView/SettingsView';
import {ProfileView} from './components/auth/ProfileView/ProfileView';
import {HistoryDrawer} from './components/history/HistoryDrawer';
import {muiTheme} from './mui/config.mui';
import {setCurrentUser} from './utils/featureAccess';
import {showFeatureAccessModal} from './ui/featureAccessModal';
import {useRendererSession} from './hooks/useRendererSession';
import {useRendererUiState} from './hooks/useRendererUiState';
import {loadLogo, startLogoAnimation} from './ui/logoAnimation';
import {useAnswerFontSize} from './hooks/useAnswerFontSize';
import {WelcomeModal} from './ui/welcomeModal';
import {initializeRendererActivitySession} from './state/rendererActivity';
import {hasFeatureAccess} from './utils/features';

type AppTab = 'main' | 'settings' | 'profile';
const TABS: AppTab[] = ['main', 'settings', 'profile'];

function AuthenticatedApp() {
    const {user} = useAuth();
    const [activeTab, setActiveTab] = useState<AppTab>('main');
    const [historyOpen, setHistoryOpen] = useState(false);
    const answerFontSizeNotice = useAnswerFontSize();
    const renderer = useRendererSession();
    const {app, status, stopVisible} = useRendererUiState();
    const tabRefs = useRef<Record<AppTab, HTMLButtonElement | null>>({main: null, settings: null, profile: null});
    const mainLogoRef = useRef<HTMLImageElement | null>(null);
    const logoContainerRef = useRef<HTMLDivElement | null>(null);
    const headerLogoRef = useRef<HTMLImageElement | null>(null);

    useEffect(() => {
        loadLogo(mainLogoRef.current);
        loadLogo(headerLogoRef.current);
        if (!mainLogoRef.current || !logoContainerRef.current) return;
        return startLogoAnimation(mainLogoRef.current, logoContainerRef.current);
    }, []);

    useEffect(() => {
        if (!hasFeatureAccess(user, 'history')) setHistoryOpen(false);
    }, [user]);

    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = TABS.indexOf(activeTab);
        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? TABS.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
        const next = TABS[nextIndex];
        setActiveTab(next);
        requestAnimationFrame(() => tabRefs.current[next]?.focus({preventScroll: true}));
    };

    const openHistory = () => {
        // History remains local data, but its UI availability follows the
        // account's advertised product entitlement.
        if (!hasFeatureAccess(user, 'history')) {
            showFeatureAccessModal('history');
            return;
        }
        setHistoryOpen(true);
    };

    return (
        <div className="app-grid disable-tap-select relative fc h-screen min-w-[330px] text-gray-100">
            <WindowResizer/>
            <div className="rainbow pointer-events-none" style={{position: 'absolute', width: 500, height: 500}}/>

            <div
                ref={logoContainerRef}
                className="logo-container pointer-events-none fccc"
                style={{width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 2}}
            >
                <img ref={mainLogoRef} id="main-logo" alt="xexamai" style={{width: '70vmin'}}/>
            </div>

            <header className="app-header frbc px-3 py-2 text-gray-100 drag-region">
                <div className="frsc gap-3">
                    <div className="relative" style={{width: 32, height: 32}}>
                        <img
                            ref={headerLogoRef}
                            id="header-logo"
                            alt="xexamai"
                            style={{width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 2}}
                        />
                        <div className="rainbow" style={{position: 'absolute', top: 0, left: 0, filter: 'blur(25px) saturate(1.5)'}}/>
                    </div>
                    <h1 className="text-lg font-semibold">xexamai</h1>
                    <div className={`status-badge ${status.type}`} role="status" aria-live="polite" aria-atomic="true">
                        {status.text}
                    </div>
                </div>
                <div className="no-drag"/>
                <div className="window-controls no-drag -mr-1">
                    <button
                        className="close mr-[11px]"
                        type="button"
                        aria-label="Close XEXAMAI"
                        onClick={() => void window.api.window.close()}
                        onFocus={(event) => event.currentTarget.blur()}
                    >
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        </svg>
                    </button>
                </div>
            </header>

            <main className="flex flex-1 flex-col overflow-auto px-4 pb-4 pt-1">
                <div className="tabs-container">
                    <div className="tabs" role="tablist" aria-label="Application sections" aria-orientation="horizontal">
                        {TABS.map((tab) => (
                            <button
                                key={tab}
                                ref={(element) => { tabRefs.current[tab] = element; }}
                                className={`tab ${activeTab === tab ? 'active' : ''}`}
                                type="button"
                                role="tab"
                                id={`tab-${tab}`}
                                aria-selected={activeTab === tab}
                                aria-controls={`panel-${tab}`}
                                tabIndex={activeTab === tab ? 0 : -1}
                                onKeyDown={handleTabKeyDown}
                                onClick={() => setActiveTab(tab)}
                            >
                                {tab === 'main' ? 'Main' : tab === 'settings' ? 'Settings' : 'Profile'}
                            </button>
                        ))}
                    </div>
                </div>

                <div id="panel-main" role="tabpanel" aria-labelledby="tab-main" className="content-area flex flex-col gap-4 overflow-auto" hidden={activeTab !== 'main'}>
                    <MainWorkspace
                        renderer={renderer}
                        appState={app}
                        stopVisible={stopVisible}
                        onOpenHistory={openHistory}
                    />
                </div>
                <div id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" className="content-area flex flex-col overflow-auto" hidden={activeTab !== 'settings'}>
                    {activeTab === 'settings' ? <SettingsView/> : null}
                </div>
                <div id="panel-profile" role="tabpanel" aria-labelledby="tab-profile" className="content-area flex flex-col overflow-auto" hidden={activeTab !== 'profile'}>
                    {activeTab === 'profile' ? <ProfileView/> : null}
                </div>
            </main>

            <footer
                className="pointer-events-none absolute bottom-2 left-0 right-0 flex items-end justify-between px-3 text-[9px] font-light opacity-40"
                style={{fontWeight: 300}}
            >
                <div className="pointer-events-auto space-x-1 text-gray-300">
                    <span className="opacity-70">by Nikita Artasov</span>
                    <a target="_blank" rel="noreferrer" className="text-[#c3a5ff]" href="https://t.me/artasov">@artasov</a>
                </div>
                <div className="pointer-events-auto"><BetaFeedbackWidget/></div>
            </footer>

            {historyOpen ? <HistoryDrawer open onClose={() => setHistoryOpen(false)}/> : null}
            <WelcomeModal/>
            {answerFontSizeNotice !== null ? (
                <div className="font-size-notification" role="status" aria-live="polite">
                    Font size: {answerFontSizeNotice}px
                </div>
            ) : null}
        </div>
    );
}

function AppContent() {
    const {status, isAuthenticated, user} = useAuth();

    useEffect(() => {
        setCurrentUser(user);
    }, [user]);

    if (status === 'initializing' || status === 'checking') {
        return <LoadingScreen message={status === 'checking' ? 'Restoring session…' : 'Launching…'}/>;
    }
    if (!isAuthenticated) return <LoginView/>;
    return <AuthenticatedApp/>;
}

function RendererInfrastructure() {
    useEffect(() => {
        void initializeRendererActivitySession().catch(() => {
            // A native operation will retry registration and surface a useful error.
        });
    }, []);
    return <UpdateCenter/>;
}

export function App() {
    return (
        <ThemeProvider theme={muiTheme}>
            <CssBaseline/>
            <AuthProvider>
                <div className="global-update-center">
                    <RendererInfrastructure/>
                </div>
                <AppContent/>
                <ToastContainer
                    position="top-center"
                    style={{marginTop: 49}}
                    autoClose={3200}
                    newestOnTop
                    pauseOnFocusLoss={false}
                    pauseOnHover
                    theme="dark"
                    closeOnClick
                />
            </AuthProvider>
        </ThemeProvider>
    );
}

export default App;

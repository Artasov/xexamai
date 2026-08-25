import type {ReactNode} from 'react';
import {createContext, useContext, useMemo} from 'react';
import type {AppSettings} from '@renderer/types';
import type {SettingsTab} from '@renderer/state/navigationState';
import {useSettings} from '@renderer/hooks/useSettings';
import {GeneralSettings} from '../GeneralSettings/GeneralSettings';
import {AiSettings} from '../AiSettings/AiSettings';
import {AudioSettings} from '../AudioSettings/AudioSettings';
import {HotkeysSettings} from '../HotkeysSettings/HotkeysSettings';
import './SettingsView.scss';

type SettingsContextValue = {
    settings: AppSettings;
    loading: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
    patchLocal: (partial: Partial<AppSettings>) => void;
};

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function useSettingsContext(): SettingsContextValue {
    const value = useContext(SettingsContext);
    if (!value) {
        throw new Error('useSettingsContext must be used within SettingsView');
    }
    return value;
}

const TAB_ORDER = [
    {id: 'general', label: 'General'},
    {id: 'ai', label: 'AI'},
    {id: 'audio', label: 'Audio'},
    {id: 'hotkeys', label: 'Hotkeys'},
] as const;

type SettingsViewProps = {
    activeTab: SettingsTab;
    onActiveTabChange: (tab: SettingsTab) => void;
};

export const SettingsView = ({activeTab, onActiveTabChange}: SettingsViewProps) => {
    const {settings, loading, error, refresh, patchLocal} = useSettings();

    const contextValue = useMemo<SettingsContextValue>(() => ({
        settings,
        loading,
        error,
        refresh,
        patchLocal,
    }), [settings, loading, error, refresh, patchLocal]);

    const renderActiveTab = (tab: SettingsTab): ReactNode => {
        switch (tab) {
            case 'general':
                return <GeneralSettings/>;
            case 'ai':
                return <AiSettings/>;
            case 'audio':
                return <AudioSettings/>;
            case 'hotkeys':
                return <HotkeysSettings/>;
            default:
                return null;
        }
    };

    return (
        <SettingsContext.Provider value={contextValue}>
            <div className="settings-view">
                <div className="tabs settings-tabs">
                    {TAB_ORDER.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            className={`tab settings-tab ${activeTab === tab.id ? 'active' : ''}`}
                            onClick={() => onActiveTabChange(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {error ? (
                    <div className="settings-error">
                        <p>Failed to load settings: {error.message}</p>
                        <button type="button" className="btn btn-sm" onClick={refresh}>
                            Retry
                        </button>
                    </div>
                ) : null}

                <div className="settings-panel-wrapper">
                    {loading ? (
                        <div className="settings-loading">Loading settings…</div>
                    ) : (
                        renderActiveTab(activeTab)
                    )}
                </div>
            </div>
        </SettingsContext.Provider>
    );
};

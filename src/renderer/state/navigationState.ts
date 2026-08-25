export type AppTab = 'main' | 'settings' | 'profile';
export type SettingsTab = 'general' | 'ai' | 'audio' | 'hotkeys';

export type AppNavigationState = {
    activeTab: AppTab;
    activeSettingsTab: SettingsTab;
};

export const INITIAL_APP_NAVIGATION_STATE: AppNavigationState = {
    activeTab: 'main',
    activeSettingsTab: 'general',
};

export function selectAppTab(state: AppNavigationState, activeTab: AppTab): AppNavigationState {
    return state.activeTab === activeTab ? state : {...state, activeTab};
}

export function selectSettingsTab(
    state: AppNavigationState,
    activeSettingsTab: SettingsTab,
): AppNavigationState {
    return state.activeSettingsTab === activeSettingsTab
        ? state
        : {...state, activeSettingsTab};
}

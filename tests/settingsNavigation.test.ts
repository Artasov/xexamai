import {describe, expect, it} from 'vitest';
import {
    INITIAL_APP_NAVIGATION_STATE,
    selectAppTab,
    selectSettingsTab,
} from '../src/renderer/state/navigationState';

describe('settings navigation memory', () => {
    it('keeps the selected settings section while visiting other app tabs', () => {
        let navigation = selectAppTab(INITIAL_APP_NAVIGATION_STATE, 'settings');
        navigation = selectSettingsTab(navigation, 'ai');
        navigation = selectAppTab(navigation, 'main');
        navigation = selectAppTab(navigation, 'profile');
        navigation = selectAppTab(navigation, 'settings');

        expect(navigation).toEqual({
            activeTab: 'settings',
            activeSettingsTab: 'ai',
        });
    });

    it('starts on Main and General without persisting navigation across launches', () => {
        expect(INITIAL_APP_NAVIGATION_STATE).toEqual({
            activeTab: 'main',
            activeSettingsTab: 'general',
        });
    });
});

import type {AuthUser} from '../services/authClient';
import {hasFeatureAccess} from './features';

let currentUser: AuthUser | null = null;

export function setCurrentUser(user: AuthUser | null): void {
    currentUser = user;
}

export function checkFeatureAccess(featureCode: 'screen_processing' | 'history' | 'promt_presets'): boolean {
    return hasFeatureAccess(currentUser, featureCode);
}

export function getCurrentUser(): AuthUser | null {
    return currentUser;
}


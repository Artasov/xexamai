export type SwitchAudioResult = {
    success: boolean;
    activeType: 'microphone' | 'system' | 'mixed';
    previousType: 'microphone' | 'system' | 'mixed';
    activeDeviceId: string;
    previousDeviceId: string;
    rolledBack?: boolean;
    error?: string;
    rollbackError?: string;
};

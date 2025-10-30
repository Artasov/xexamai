export type SwitchAudioResult = {
    success: boolean;
    stream?: MediaStream;
    error?: string;
};

export type SwitchOptions = {
    preStream?: MediaStream | null;
    gesture?: boolean;
};

import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('../src/renderer/bridge/nativeInvoke', () => ({
    invokeNative: mocks.invoke,
}));

afterEach(() => {
    mocks.invoke.mockReset();
    vi.resetModules();
});

describe('assistant cancellation races', () => {
    it('registers batch-transcription cancellation before settings loading completes', async () => {
        let resolveSettings!: (value: Record<string, unknown>) => void;
        const settings = new Promise<Record<string, unknown>>((resolve) => {
            resolveSettings = resolve;
        });
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'config_get') return settings;
            return Promise.resolve(undefined);
        });
        const assistant = await import('../src/renderer/services/nativeAssistant');

        const transcription = assistant.assistantTranscribeOnly({
            arrayBuffer: new ArrayBuffer(16),
            mime: 'audio/wav',
            requestId: 'cancel-batch-before-settings',
        });
        await assistant.assistantStopStream({requestId: 'cancel-batch-before-settings'});
        resolveSettings({transcriptionMode: 'api', transcriptionModel: 'gpt-4o-mini-transcribe'});

        await expect(transcription).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.invoke.mock.calls.some(([command]) => command === 'transcribe_audio')).toBe(false);
    });

    it('registers cancellation before asynchronous settings loading completes', async () => {
        let resolveSettings!: (value: Record<string, unknown>) => void;
        const settings = new Promise<Record<string, unknown>>((resolve) => {
            resolveSettings = resolve;
        });
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'config_get') return settings;
            return Promise.resolve(undefined);
        });
        const assistant = await import('../src/renderer/services/nativeAssistant');

        await assistant.assistantAskChat({text: 'Question', requestId: 'cancel-before-settings'});
        await assistant.assistantStopStream({requestId: 'cancel-before-settings'});
        resolveSettings({llmHost: 'api', llmModel: 'gpt-4.1-nano'});
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.invoke).toHaveBeenCalledWith('cancel_transcription', {
            requestId: 'cancel-before-settings',
        });
        expect(mocks.invoke.mock.calls.some(([command]) => command === 'provider_proxy_stream')).toBe(false);
    });

    it('does not dispatch a streaming native request for an already-aborted signal', async () => {
        const {providerProxyFetch} = await import('../src/renderer/services/providerProxyClient');
        const controller = new AbortController();
        controller.abort();

        await expect(providerProxyFetch(
            'openai',
            'chatCompletions',
            {model: 'gpt-4.1-nano', stream: true, messages: []},
            {stream: true, signal: controller.signal},
        )).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it('cancels a non-stream request aborted while its listener is being registered', async () => {
        mocks.invoke.mockResolvedValue(undefined);
        const {providerProxyFetch} = await import('../src/renderer/services/providerProxyClient');
        const controller = new AbortController();
        const addEventListener = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
            addEventListener(type, listener, options);
            controller.abort();
        });

        await expect(providerProxyFetch(
            'openai',
            'chatCompletions',
            {model: 'gpt-4.1-nano', messages: []},
            {signal: controller.signal},
        )).rejects.toMatchObject({name: 'AbortError'});

        expect(mocks.invoke.mock.calls.some(([command]) => command === 'provider_proxy_request')).toBe(false);
        expect(mocks.invoke.mock.calls.some(([command]) => command === 'provider_proxy_cancel')).toBe(true);
    });

    it('does not dispatch a stream aborted while its listener is being registered', async () => {
        mocks.invoke.mockResolvedValue(undefined);
        const {providerProxyFetch} = await import('../src/renderer/services/providerProxyClient');
        const controller = new AbortController();
        const addEventListener = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
            addEventListener(type, listener, options);
            controller.abort();
        });

        await expect(providerProxyFetch(
            'openai',
            'chatCompletions',
            {model: 'gpt-4.1-nano', stream: true, messages: []},
            {stream: true, signal: controller.signal},
        )).rejects.toMatchObject({name: 'AbortError'});

        expect(mocks.invoke.mock.calls.some(([command]) => command === 'provider_proxy_stream')).toBe(false);
        expect(mocks.invoke.mock.calls.some(([command]) => command === 'provider_proxy_cancel')).toBe(true);
    });

    it('keeps the newest controller registered when a request id is reused', async () => {
        const settingsResolvers: Array<(value: Record<string, unknown>) => void> = [];
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'config_get') {
                return new Promise<Record<string, unknown>>((resolve) => {
                    settingsResolvers.push(resolve);
                });
            }
            return Promise.resolve(undefined);
        });
        const assistant = await import('../src/renderer/services/nativeAssistant');

        await assistant.assistantAskChat({text: 'First', requestId: 'reused-request'});
        await assistant.assistantAskChat({text: 'Second', requestId: 'reused-request'});
        expect(settingsResolvers).toHaveLength(2);

        // Finishing the superseded generation must not delete the controller
        // that belongs to the second request.
        settingsResolvers[0]({llmHost: 'api', llmModel: 'gpt-4.1-nano'});
        await Promise.resolve();
        await Promise.resolve();
        await assistant.assistantStopStream({requestId: 'reused-request'});
        settingsResolvers[1]({llmHost: 'api', llmModel: 'gpt-4.1-nano'});
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.invoke.mock.calls.some(([command]) => command === 'provider_proxy_stream')).toBe(false);
    });
});

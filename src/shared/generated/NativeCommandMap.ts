// This file has been generated from compiler-checked Rust command signatures. Do not edit it manually.
import type {commands} from './NativeBindings';

type NativeBindings = typeof commands;

export type NativeCommandMap = {
    "config_get": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["configGet"]>>;
    };
    "config_update": {
        args: {
            payload: Parameters<NativeBindings["configUpdate"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["configUpdate"]>>;
    };
    "config_reset": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["configReset"]>>;
    };
    "config_path": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["configPath"]>>;
    };
    "open_config_folder": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["openConfigFolder"]>>;
    };
    "app_log_path": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["appLogPath"]>>;
    };
    "open_app_logs_folder": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["openAppLogsFolder"]>>;
    };
    "log_frontend": {
        args: {
            entry: Parameters<NativeBindings["logFrontend"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["logFrontend"]>>;
    };
    "diagnostics_snapshot": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["diagnosticsSnapshot"]>>;
    };
    "app_shutdown_complete": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["appShutdownComplete"]>>;
    };
    "activity_register_session": {
        args: {
            sessionId: Parameters<NativeBindings["activityRegisterSession"]>[0];
            generation: Parameters<NativeBindings["activityRegisterSession"]>[1];
        };
        result: Awaited<ReturnType<NativeBindings["activityRegisterSession"]>>;
    };
    "activity_begin": {
        args: {
            sessionId: Parameters<NativeBindings["activityBegin"]>[0];
            label: Parameters<NativeBindings["activityBegin"]>[1];
        };
        result: Awaited<ReturnType<NativeBindings["activityBegin"]>>;
    };
    "activity_end": {
        args: {
            sessionId: Parameters<NativeBindings["activityEnd"]>[0];
            leaseId: Parameters<NativeBindings["activityEnd"]>[1];
        };
        result: Awaited<ReturnType<NativeBindings["activityEnd"]>>;
    };
    "open_external_url": {
        args: {
            url: Parameters<NativeBindings["openExternalUrl"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["openExternalUrl"]>>;
    };
    "auth_consume_pending": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["authConsumePending"]>>;
    };
    "auth_renderer_not_ready": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["authRendererNotReady"]>>;
    };
    "auth_cancel_pending": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["authCancelPending"]>>;
    };
    "auth_get_methods": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["authGetMethods"]>>;
    };
    "auth_start_oauth": {
        args: {
            provider: Parameters<NativeBindings["authStartOauth"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["authStartOauth"]>>;
    };
    "auth_session_bootstrap": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["authSessionBootstrap"]>>;
    };
    "auth_session_import_legacy": {
        args: {
            tokens: Parameters<NativeBindings["authSessionImportLegacy"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["authSessionImportLegacy"]>>;
    };
    "auth_session_login": {
        args: {
            email: Parameters<NativeBindings["authSessionLogin"]>[0];
            password: Parameters<NativeBindings["authSessionLogin"]>[1];
        };
        result: Awaited<ReturnType<NativeBindings["authSessionLogin"]>>;
    };
    "auth_session_refresh": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["authSessionRefresh"]>>;
    };
    "auth_session_logout": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["authSessionLogout"]>>;
    };
    "google_live_capability": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["googleLiveCapability"]>>;
    };
    "google_live_create_token": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["googleLiveCreateToken"]>>;
    };
    "openai_live_capability": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["openaiLiveCapability"]>>;
    };
    "openai_live_create_token": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["openaiLiveCreateToken"]>>;
    };
    "provider_proxy_request": {
        args: {
            request: Parameters<NativeBindings["providerProxyRequest"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["providerProxyRequest"]>>;
    };
    "provider_proxy_stream": {
        args: {
            request: Parameters<NativeBindings["providerProxyStream"]>[0];
            onEvent: Parameters<NativeBindings["providerProxyStream"]>[1];
        };
        result: Awaited<ReturnType<NativeBindings["providerProxyStream"]>>;
    };
    "provider_proxy_cancel": {
        args: {
            requestId: Parameters<NativeBindings["providerProxyCancel"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["providerProxyCancel"]>>;
    };
    "provider_test_model": {
        args: {
            request: Parameters<NativeBindings["providerTestModel"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["providerTestModel"]>>;
    };
    "local_speech_get_status": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["localSpeechGetStatus"]>>;
    };
    "local_speech_check_health": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["localSpeechCheckHealth"]>>;
    };
    "local_speech_install": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["localSpeechInstall"]>>;
    };
    "local_speech_start": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["localSpeechStart"]>>;
    };
    "local_speech_restart": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["localSpeechRestart"]>>;
    };
    "local_speech_reinstall": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["localSpeechReinstall"]>>;
    };
    "local_speech_stop": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["localSpeechStop"]>>;
    };
    "local_speech_check_model_downloaded": {
        args: {
            model: Parameters<NativeBindings["localSpeechCheckModelDownloaded"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["localSpeechCheckModelDownloaded"]>>;
    };
    "ollama_check_installed": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["ollamaCheckInstalled"]>>;
    };
    "ollama_list_models": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["ollamaListModels"]>>;
    };
    "ollama_pull_model": {
        args: {
            model: Parameters<NativeBindings["ollamaPullModel"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["ollamaPullModel"]>>;
    };
    "ollama_warmup_model": {
        args: {
            model: Parameters<NativeBindings["ollamaWarmupModel"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["ollamaWarmupModel"]>>;
    };
    "ollama_stream_chat": {
        args: {
            requestId: Parameters<NativeBindings["ollamaStreamChat"]>[0];
            body: Parameters<NativeBindings["ollamaStreamChat"]>[1];
            connectTimeoutMs?: Parameters<NativeBindings["ollamaStreamChat"]>[2];
            idleTimeoutMs?: Parameters<NativeBindings["ollamaStreamChat"]>[3];
            totalTimeoutMs?: Parameters<NativeBindings["ollamaStreamChat"]>[4];
            onEvent: Parameters<NativeBindings["ollamaStreamChat"]>[5];
        };
        result: Awaited<ReturnType<NativeBindings["ollamaStreamChat"]>>;
    };
    "ollama_cancel_chat": {
        args: {
            requestId: Parameters<NativeBindings["ollamaCancelChat"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["ollamaCancelChat"]>>;
    };
    "audio_list_devices": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["audioListDevices"]>>;
    };
    "audio_start_capture": {
        args: {
            source: Parameters<NativeBindings["audioStartCapture"]>[0];
            deviceId?: Parameters<NativeBindings["audioStartCapture"]>[1];
            onChunk: Parameters<NativeBindings["audioStartCapture"]>[2];
        };
        result: Awaited<ReturnType<NativeBindings["audioStartCapture"]>>;
    };
    "audio_stop_capture": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["audioStopCapture"]>>;
    };
    "check_app_update": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["checkAppUpdate"]>>;
    };
    "download_app_update": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["downloadAppUpdate"]>>;
    };
    "install_app_update": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["installAppUpdate"]>>;
    };
    "discard_app_update": {
        args: undefined;
        result: Awaited<ReturnType<NativeBindings["discardAppUpdate"]>>;
    };
    "transcribe_audio": {
        args: {
            request: Parameters<NativeBindings["transcribeAudio"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["transcribeAudio"]>>;
    };
    "cancel_transcription": {
        args: {
            requestId: Parameters<NativeBindings["cancelTranscription"]>[0];
        };
        result: Awaited<ReturnType<NativeBindings["cancelTranscription"]>>;
    };
};

export type NativeCommand = keyof NativeCommandMap;

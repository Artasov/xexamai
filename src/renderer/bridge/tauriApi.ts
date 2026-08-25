import { Channel } from "@tauri-apps/api/core";
import { invokeNative as invoke } from "./nativeInvoke";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import {
  AssistantAPI,
  AuthDeepLinkPayload,
  AuthMethodsResponse,
  DiagnosticsSnapshot,
  FastWhisperStatus,
} from "@shared/ipc";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { AsyncListenerSlot } from "./asyncListenerSlot";
import {
  decodeGoogleLiveMessage,
  getGoogleLiveServerError,
  GOOGLE_LIVE_ENDPOINT,
  GOOGLE_LIVE_MODEL,
} from "../services/googleLiveContract";
import {
  buildOpenAiLiveSessionUpdate,
  buildOpenAiLiveWebSocketUrl,
  decodeOpenAiLiveMessage,
  getOpenAiLiveError,
  OPENAI_LIVE_MODEL,
} from "../services/openAiLiveContract";
import type { OllamaStreamEvent } from "@shared/generated/NativeBindings";
import {
  assistantAskChat,
  assistantOffStreamDelta,
  assistantOffStreamDone,
  assistantOffStreamError,
  assistantOffStreamTranscript,
  assistantOnStreamDelta,
  assistantOnStreamDone,
  assistantOnStreamError,
  assistantOnStreamTranscript,
  assistantStopStream,
  assistantTranscribeOnly,
} from "../services/nativeAssistant";

const currentWindow = getCurrentWindow();

async function patchSettings(payload: Record<string, unknown>) {
  await invoke("config_update", { payload });
}

const makeSettingSetter =
  <T>(key: keyof AssistantAPI["settings"] extends never ? string : string) =>
  async (value: T) => {
    await patchSettings({ [key]: value });
  };

const settingsApi: AssistantAPI["settings"] = {
  get: () => invoke("config_get"),
  setOpenaiApiKey: makeSettingSetter<string>("openaiApiKey"),
  setWindowOpacity: async (opacity: number) => {
    await patchSettings({ windowOpacity: opacity });
    // Opacity is applied in Rust via DWM
  },
  setAlwaysOnTop: async (alwaysOnTop: boolean) => {
    await patchSettings({ alwaysOnTop });
    try {
      await currentWindow.setAlwaysOnTop(alwaysOnTop);
    } catch {}
  },
  setHideApp: async (hideApp: boolean) => {
    await patchSettings({ hideApp });
    // Screen recording exclusion is applied in Rust via SetWindowDisplayAffinity
  },
  setWindowSize: async (size) => {
    const width = Math.max(size.width, 400);
    const height = Math.max(size.height, 500);
    await patchSettings({ windowWidth: width, windowHeight: height });
    try {
      await currentWindow.setSize(new LogicalSize(width, height));
    } catch {}
  },
  setWindowScale: async (scale) => {
    await patchSettings({ windowScale: scale });
    // Scale is applied in Rust by resizing the window and adjusting CSS zoom
  },
  setDurations: makeSettingSetter("durations"),
  setDurationHotkeys: makeSettingSetter("durationHotkeys"),
  setAudioInputDevice: makeSettingSetter("audioInputDeviceId"),
  setToggleInputHotkey: makeSettingSetter("toggleInputHotkey"),
  setAudioInputType: makeSettingSetter("audioInputType"),
  setTranscriptionModel: makeSettingSetter("transcriptionModel"),
  setRealtimeTranslationLanguage: makeSettingSetter("realtimeTranslationLanguage"),
  setTranscriptionPrompt: makeSettingSetter("transcriptionPrompt"),
  setLlmModel: async (model, host) => {
    const payload: Record<string, unknown> = { llmModel: model };
    if (host === "local") {
      payload.localLlmModel = model;
    } else if (host === "api") {
      payload.apiLlmModel = model;
    }
    await patchSettings(payload);
  },
  setLlmPrompt: makeSettingSetter("llmPrompt"),
  setTranscriptionMode: makeSettingSetter("transcriptionMode"),
  setLlmHost: makeSettingSetter("llmHost"),
  setLocalWhisperModel: makeSettingSetter("localWhisperModel"),
  setLocalDevice: makeSettingSetter("localDevice"),
  setApiSttTimeoutMs: makeSettingSetter("apiSttTimeoutMs"),
  setApiLlmTimeoutMs: makeSettingSetter("apiLlmTimeoutMs"),
  getAudioDevices: async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          kind: "audioinput" as const,
        }));
    } catch {
      return [];
    }
  },
  openConfigFolder: async () => {
    await invoke("open_config_folder");
  },
  openLogsFolder: async () => {
    await invoke("open_app_logs_folder");
  },
  getLogPath: () => invoke("app_log_path"),
  setWelcomeModalDismissed: makeSettingSetter("welcomeModalDismissed"),
  setGoogleApiKey: makeSettingSetter("googleApiKey"),
  setStreamSendHotkey: makeSettingSetter<string>("streamSendHotkey"),
  setBackendDomain: makeSettingSetter("backendDomain"),
  setDiagnosticsEnabled: makeSettingSetter<boolean>("diagnosticsEnabled"),
};

const audioApi: AssistantAPI["audio"] = {
  listDevices: () => invoke("audio_list_devices"),
  startCapture: (source, deviceId, onChunk) => {
    const channel = new Channel<ArrayBuffer | Uint8Array>();
    channel.onmessage = onChunk;
    return invoke("audio_start_capture", {
      source,
      deviceId,
      onChunk: channel,
    });
  },
  stopCapture: () => invoke("audio_stop_capture"),
};

const diagnosticsApi: AssistantAPI["diagnostics"] = {
  snapshot: () => invoke("diagnostics_snapshot"),
};

const windowApi: AssistantAPI["window"] = {
  minimize: () => currentWindow.minimize(),
  close: () => currentWindow.close(),
  async getBounds() {
    const [position, size, scaleFactor] = await Promise.all([
      currentWindow.outerPosition(),
      currentWindow.outerSize(),
      currentWindow.scaleFactor(),
    ]);
    const logicalPosition = position.toLogical(scaleFactor);
    const logicalSize = size.toLogical(scaleFactor);
    return {
      x: logicalPosition.x,
      y: logicalPosition.y,
      width: logicalSize.width,
      height: logicalSize.height,
    };
  },
  async setBounds(bounds) {
    // Resize first so moving the top/left edge cannot move the webview away
    // from the pointer before the matching size update has been applied.
    await currentWindow.setSize(new LogicalSize(bounds.width, bounds.height));
    await currentWindow.setPosition(new LogicalPosition(bounds.x, bounds.y));
  },
};

const assistantApi: AssistantAPI["assistant"] = {
  transcribeOnly: assistantTranscribeOnly,
  askChat: assistantAskChat,
  stopStream: assistantStopStream,
  onStreamTranscript: (cb) => assistantOnStreamTranscript(cb),
  onStreamDelta: (cb) => assistantOnStreamDelta(cb),
  onStreamDone: (cb) => assistantOnStreamDone(cb),
  onStreamError: (cb) => assistantOnStreamError(cb),
  offStreamTranscript: () => assistantOffStreamTranscript(),
  offStreamDelta: () => assistantOffStreamDelta(),
  offStreamDone: () => assistantOffStreamDone(),
  offStreamError: () => assistantOffStreamError(),
};

type DurationHotkeyEvent = { event: unknown; payload: { sec: number } };
const durationListener = new AsyncListenerSlot<DurationHotkeyEvent>();
const toggleListener = new AsyncListenerSlot<void>();

const hotkeysApi: AssistantAPI["hotkeys"] = {
  onDuration: (cb) => {
    durationListener.replace(
      (emit) =>
        listen<{ sec: number }>("hotkeys:duration", (event) =>
          emit({ event, payload: event.payload }),
        ),
      ({ event, payload }) => cb(event, payload),
    );
  },
  offDuration: () => durationListener.clear(),
  onToggleInput: (cb) => {
    toggleListener.replace(
      (emit) => listen("hotkeys:toggle-input", () => emit()),
      () => cb(),
    );
  },
  offToggleInput: () => toggleListener.clear(),
};

const loopbackApi: AssistantAPI["loopback"] = {
  enable: async () => ({ success: false, error: "Not implemented" }),
  disable: async () => ({ success: false, error: "Not implemented" }),
};

type ScreenCaptureResult = {
  sessionId: number;
  base64: string;
  width: number;
  height: number;
  mime: string;
};

type ScreenCaptureErrorPayload = { sessionId: number; message?: string };

const SCREEN_CAPTURE_STARTUP_TIMEOUT_MS = 12_000;
const SCREEN_CAPTURE_SELECTION_TIMEOUT_MS = 10 * 60_000;
const SCREEN_CAPTURE_PROCESSING_TIMEOUT_MS = 30_000;
let screenCaptureSessionSequence = (() => {
  try {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] & 0x3fffffff;
    return seed || 1;
  } catch {
    return (Date.now() & 0x3fffffff) || 1;
  }
})();
let activeScreenCapture: {
  sessionId: number;
  cancel: () => Promise<void>;
  completion: () => Promise<ScreenCaptureResult | null>;
} | null = null;
let activeFallbackScreenCapture: {
  cancel: () => void;
  completion: Promise<Awaited<ReturnType<typeof captureScreenFrame>> | null>;
  workerCompletion: Promise<void>;
} | null = null;

const nextScreenCaptureSessionId = () => {
  screenCaptureSessionSequence = (screenCaptureSessionSequence + 1) & 0x3fffffff;
  if (!screenCaptureSessionSequence) screenCaptureSessionSequence = 1;
  return screenCaptureSessionSequence;
};

async function captureNativeScreenSelection(): Promise<ScreenCaptureResult | null> {
  if (activeScreenCapture) {
    throw new Error("A screen capture selection is already in progress");
  }
  const completion = new Promise<ScreenCaptureResult | null>((resolve, reject) => {
    const sessionId = nextScreenCaptureSessionId();
    let settled = false;
    let overlayReady = false;
    let captureProcessing = false;
    let phaseTimer: ReturnType<typeof setTimeout> | null = null;
    const unlisteners: UnlistenFn[] = [];

    const cleanup = () => {
      if (phaseTimer !== null) clearTimeout(phaseTimer);
      phaseTimer = null;
      for (const unlisten of unlisteners.splice(0)) {
        try {
          unlisten();
        } catch {}
      }
      if (activeScreenCapture?.sessionId === sessionId) {
        activeScreenCapture = null;
      }
    };

    const requestNativeAbort = () => {
      // Native cleanup is session-scoped and deliberately best-effort. Do not
      // keep the caller pending if the cleanup IPC itself is unavailable.
      void invoke("screen_capture_abort", { sessionId }).catch(() => undefined);
    };
    const abortAfterTimeout = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      requestNativeAbort();
      reject(new Error(message));
    };
    const resolveOnce = (value: ScreenCaptureResult | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error(typeof error === "string" ? error : "Screen capture failed"),
      );
    };

    const registerListener = async <T>(
      eventName: string,
      handler: (event: { payload: T }) => void,
    ): Promise<boolean> => {
      const unlisten = await listen<T>(eventName, handler);
      // The startup timeout may settle while listener registration is still
      // pending. Immediately dispose a late listener and stop the setup chain.
      if (settled) {
        try {
          unlisten();
        } catch {}
        return false;
      }
      unlisteners.push(unlisten);
      return true;
    };

    const cancelFromRenderer = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
      await invoke("screen_capture_abort", { sessionId }).catch(() => undefined);
    };

    activeScreenCapture = {
      sessionId,
      cancel: cancelFromRenderer,
      completion: () => completion,
    };

    // Include listener registration in the startup bound. Otherwise a stalled
    // event subscription can leave the capture promise pending forever.
    phaseTimer = setTimeout(
      () => abortAfterTimeout("Screen capture overlay did not start"),
      SCREEN_CAPTURE_STARTUP_TIMEOUT_MS,
    );

    void (async () => {
      try {
        // Register each listener into the cleanup set immediately. If a later
        // registration fails, earlier listeners cannot leak into the next run.
        if (!await registerListener<number>("screen-capture:ready", (event) => {
            if (event.payload !== sessionId || settled || overlayReady) return;
            overlayReady = true;
            if (phaseTimer !== null) clearTimeout(phaseTimer);
            phaseTimer = setTimeout(
              () => abortAfterTimeout("Screen capture selection timed out"),
              SCREEN_CAPTURE_SELECTION_TIMEOUT_MS,
            );
          })) return;
        if (!await registerListener<number>("screen-capture:capturing", (event) => {
            if (event.payload !== sessionId || settled || captureProcessing) return;
            captureProcessing = true;
            if (phaseTimer !== null) clearTimeout(phaseTimer);
            phaseTimer = setTimeout(
              () => abortAfterTimeout("Screen capture did not finish"),
              SCREEN_CAPTURE_PROCESSING_TIMEOUT_MS,
            );
          })) return;
        if (!await registerListener<ScreenCaptureResult>("screen-capture:completed", (event) => {
            if (event.payload?.sessionId !== sessionId) return;
            resolveOnce(event.payload);
          })) return;
        if (!await registerListener<number>("screen-capture:cancelled", (event) => {
            if (event.payload !== sessionId) return;
            resolveOnce(null);
          })) return;
        if (!await registerListener<ScreenCaptureErrorPayload>("screen-capture:error", (event) => {
            if (event.payload?.sessionId !== sessionId) return;
            requestNativeAbort();
            rejectOnce(new Error(event.payload?.message || "Screen capture failed"));
          })) return;

        if (settled) return;
        await invoke("screen_capture_start", { sessionId });
      } catch (error) {
        if (settled) return;
        requestNativeAbort();
        rejectOnce(error);
      }
    })();
  });
  return completion;
}

function captureFallbackScreenSelection() {
  if (activeFallbackScreenCapture) {
    return Promise.reject(new Error("A screen capture selection is already in progress"));
  }
  const controller = new AbortController();
  let resolveCancellation!: (value: null) => void;
  const cancelled = new Promise<null>((resolve) => {
    resolveCancellation = resolve;
  });
  const capture = captureScreenFrame(controller.signal).catch((error) => {
    if (controller.signal.aborted) return null;
    throw error;
  });
  const completion = Promise.race([capture, cancelled]);
  let workerCompletion!: Promise<void>;
  workerCompletion = capture.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (activeFallbackScreenCapture?.workerCompletion === workerCompletion) {
      activeFallbackScreenCapture = null;
    }
  });
  activeFallbackScreenCapture = {
    cancel: () => {
      if (controller.signal.aborted) return;
      controller.abort();
      // getDisplayMedia does not accept AbortSignal in every WebView. Resolve
      // the app operation now; if the picker later returns a stream, the
      // aborted capture worker immediately stops all of its tracks.
      resolveCancellation(null);
    },
    completion,
    workerCompletion,
  };
  return completion;
}

const screenApi: AssistantAPI["screen"] = {
  capture: async () => {
    if (activeScreenCapture || activeFallbackScreenCapture) {
      throw new Error("A screen capture selection is already in progress");
    }
    try {
      const capture = await captureNativeScreenSelection();
      if (!capture) return null;
      return {
        base64: capture.base64,
        width: capture.width,
        height: capture.height,
        mime: capture.mime,
      };
    } catch (error) {
      if (navigator.userAgent.includes("Windows")) throw error;
      try {
        return await captureFallbackScreenSelection();
      } catch (pickerError) {
        if (isScreenPickerCancellation(pickerError)) return null;
        throw pickerError;
      }
    }
  },
  cancel: async () => {
    const nativeCapture = activeScreenCapture;
    const fallbackCapture = activeFallbackScreenCapture;
    if (nativeCapture) await nativeCapture.cancel();
    fallbackCapture?.cancel();
    await Promise.all([
      nativeCapture?.completion().catch(() => undefined),
      fallbackCapture?.completion.catch(() => undefined),
    ]);
  },
};

const authListeners = new Set<(payload: AuthDeepLinkPayload) => void>();
let authUnlisten: UnlistenFn | null = null;
let authListenPromise: Promise<void> | null = null;

const googleLiveMessageListeners = new Set<(message: any) => void>();
const googleLiveErrorListeners = new Set<(error: string) => void>();
let googleLiveSocket: WebSocket | null = null;
let googleLiveReady = false;
const googleLiveTurnWaiters = new Set<() => void>();

const openAiLiveMessageListeners = new Set<(message: Record<string, any>) => void>();
const openAiLiveErrorListeners = new Set<(error: string) => void>();
let openAiLiveSocket: WebSocket | null = null;
let openAiLiveReady = false;
let openAiLiveAudioPending = false;
let openAiLiveMode: "transcribe" | "translate" = "transcribe";
let openAiNativeTranslationActive = false;
let openAiTranslationUnlisten: UnlistenFn | null = null;
let openAiTranslationListenPromise: Promise<void> | null = null;
let openAiTranslationAudioChain: Promise<void> = Promise.resolve();
const openAiLiveOutstandingItems = new Set<string>();
const openAiLiveCommitWaiters = new Map<number, (itemId: string) => void>();
type OpenAiLiveFinalOutcome = { success: true } | { success: false; message: string };
const openAiLiveFinalWaiters = new Map<
  string,
  Set<(outcome: OpenAiLiveFinalOutcome) => void>
>();
const openAiLiveFinalOutcomes = new Map<string, OpenAiLiveFinalOutcome>();
let openAiLiveCommitSequenceSent = 0;
let openAiLiveCommitSequenceReceived = 0;
let openAiLiveTransportGeneration = 0;
let openAiLiveFinalizeTail: Promise<void> = Promise.resolve();
let openAiLiveLifecycleTail: Promise<void> = Promise.resolve();
let openAiLiveLifecycleIntent = 0;
let openAiLiveActiveLifecycleIntent = 0;
let openAiLivePendingStartAbort: AbortController | null = null;

const OPENAI_LIVE_COMMIT_TIMEOUT_MS = 1_500;
const OPENAI_LIVE_FINAL_TIMEOUT_MS = 3_000;

const resolveGoogleLiveTurnWaiters = () => {
  for (const resolve of googleLiveTurnWaiters) resolve();
  googleLiveTurnWaiters.clear();
};

const notifyGoogleLiveError = (message: string) => {
  for (const listener of googleLiveErrorListeners) {
    try {
      listener(message);
    } catch {}
  }
};

const closeGoogleLiveSocket = (sendAudioEnd = true) => {
  const socket = googleLiveSocket;
  googleLiveSocket = null;
  googleLiveReady = false;
  if (!socket) return;
  resolveGoogleLiveTurnWaiters();
  try {
    if (sendAudioEnd && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }
    socket.close(1000, "client stop");
  } catch {}
};

const stopGoogleLiveGracefully = async () => {
  const socket = googleLiveSocket;
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN) {
    let resolveTurn!: () => void;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurn = resolve;
      googleLiveTurnWaiters.add(resolve);
    });
    try {
      socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      // Keep transcript listeners alive until the protocol confirms the
      // turn, with a bounded fallback for vendor/network failures.
      await Promise.race([
        turnCompleted,
        new Promise<void>((resolve) => window.setTimeout(resolve, 1_500)),
      ]);
    } catch {
    } finally {
      googleLiveTurnWaiters.delete(resolveTurn);
    }
  }
  if (googleLiveSocket === socket) closeGoogleLiveSocket(false);
  else {
    try {
      socket.close(1000, "client stop");
    } catch {}
  }
};

const googleApi: AssistantAPI["google"] = {
  getLiveCapability: async () => {
    if (typeof WebSocket === "undefined") {
      return {
        supported: false,
        configured: false,
        reason: "WebSocket is unavailable in this WebView.",
        model: GOOGLE_LIVE_MODEL,
      };
    }
    try {
      return await invoke("google_live_capability");
    } catch (error) {
      return {
        supported: false,
        configured: false,
        reason: error instanceof Error ? error.message : String(error),
        model: GOOGLE_LIVE_MODEL,
      };
    }
  },
  startLive: async (options) => {
    closeGoogleLiveSocket();
    if (typeof WebSocket === "undefined") {
      throw new Error("Google Live is not supported by this WebView.");
    }

    // The long-lived Google key never crosses IPC. Rust provisions a
    // single-use, model-constrained ephemeral token for this connection.
    const auth = await invoke("google_live_create_token");
    if (!auth?.token)
      throw new Error(
        "Google Live could not create a temporary session token.",
      );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      const socket = new WebSocket(
        `${GOOGLE_LIVE_ENDPOINT}?access_token=${encodeURIComponent(auth.token)}`,
      );
      socket.binaryType = "arraybuffer";
      googleLiveSocket = socket;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        closeGoogleLiveSocket();
        reject(
          new Error(
            opened
              ? "Google Live did not confirm the realtime session setup."
              : "Google Live WebSocket connection timed out.",
          ),
        );
      }, 10_000);

      const fail = (message: string) => {
        notifyGoogleLiveError(message);
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error(message));
      };

      socket.onopen = () => {
        opened = true;
        try {
          // Gemini 3.1 Flash Live requires an AUDIO response modality. Input
          // transcription is delivered independently and is what the UI uses.
          socket.send(
            JSON.stringify({
              setup: {
                model: `models/${auth.model || GOOGLE_LIVE_MODEL}`,
                // The wire-level BidiGenerateContentSetup carries
                // response modalities inside generationConfig. The
                // higher-level SDK's LiveConnectConfig flattens this
                // field, but that shape cannot be sent verbatim.
                generationConfig: {
                  responseModalities: ["AUDIO"],
                },
                inputAudioTranscription:
                  options.transcribeInput === false ? undefined : {},
                outputAudioTranscription: options.transcribeOutput
                  ? {}
                  : undefined,
                sessionResumption: {},
              },
            }),
          );
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      };

      socket.onmessage = (event) => {
        void (async () => {
          try {
            const message = await decodeGoogleLiveMessage(event.data);
            // Decoding Blob/ArrayBuffer frames is asynchronous. Ignore a
            // late frame from a session that has already been replaced.
            if (googleLiveSocket !== socket) return;
            const serverError = getGoogleLiveServerError(message);
            if (serverError) {
              fail(`Google Live rejected the realtime session: ${serverError}`);
              return;
            }
            if (message?.setupComplete && !settled) {
              settled = true;
              googleLiveReady = true;
              window.clearTimeout(timeout);
              resolve();
            }
            if (
              message?.serverContent?.turnComplete ||
              message?.serverContent?.generationComplete
            ) {
              resolveGoogleLiveTurnWaiters();
            }
            for (const listener of googleLiveMessageListeners) {
              try {
                listener(message);
              } catch {}
            }
            if (message?.goAway && googleLiveSocket === socket) {
              // A fresh ephemeral token/session is safer than keeping
              // a dying socket. The controller reconnects and its
              // setup buffer bridges the short rollover gap.
              socket.close(4001, "Google Live session rollover");
            }
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            if (!settled) {
              fail(
                `Google Live returned an unreadable setup response: ${detail}`,
              );
            } else {
              notifyGoogleLiveError(
                `Google Live returned an unreadable response: ${detail}`,
              );
            }
          }
        })();
      };
      socket.onerror = () =>
        fail(
          "Google Live connection failed. Check the API key and network access.",
        );
      socket.onclose = (event) => {
        resolveGoogleLiveTurnWaiters();
        const wasCurrent = googleLiveSocket === socket;
        if (wasCurrent) {
          googleLiveSocket = null;
          googleLiveReady = false;
        }
        if (!settled) {
          fail(
            event.reason || `Google Live closed during setup (${event.code}).`,
          );
        } else if (wasCurrent) {
          // Intentional stops clear googleLiveSocket before close.
          // Any close that is still current, including a vendor 1000
          // session timeout, therefore needs a reconnect.
          notifyGoogleLiveError(
            event.reason || `Google Live connection closed (${event.code}).`,
          );
        }
      };
    });
  },
  sendAudioChunk: ({ data, mime }) => {
    const socket = googleLiveSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !googleLiveReady) {
      return;
    }
    socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data,
            mimeType: mime || "audio/pcm;rate=16000",
          },
        },
      }),
    );
  },
  stopLive: stopGoogleLiveGracefully,
  onMessage: (callback) => {
    googleLiveMessageListeners.add(callback);
    return () => googleLiveMessageListeners.delete(callback);
  },
  onError: (callback) => {
    googleLiveErrorListeners.add(callback);
    return () => googleLiveErrorListeners.delete(callback);
  },
};

const resolveOpenAiLiveFinalWaiters = (
  itemId?: string,
  outcome: OpenAiLiveFinalOutcome = {
    success: false,
    message: "OpenAI Realtime transcription session closed before the transcript finished.",
  },
) => {
  const ids = itemId ? [itemId] : [...openAiLiveFinalWaiters.keys()];
  for (const id of ids) {
    const waiters = openAiLiveFinalWaiters.get(id);
    if (!waiters) continue;
    for (const resolve of waiters) resolve(outcome);
    openAiLiveFinalWaiters.delete(id);
  }
};

const waitForOpenAiLiveFinal = (itemId: string) => {
  const completed = openAiLiveFinalOutcomes.get(itemId);
  if (completed) {
    return {
      promise: Promise.resolve(completed),
      cancel: () => undefined,
    };
  }
  let resolveWaiter!: (outcome: OpenAiLiveFinalOutcome) => void;
  const promise = new Promise<OpenAiLiveFinalOutcome>((resolve) => {
    resolveWaiter = resolve;
    const waiters = openAiLiveFinalWaiters.get(itemId) ?? new Set();
    waiters.add(resolve);
    openAiLiveFinalWaiters.set(itemId, waiters);
  });
  return {
    promise,
    cancel: () => {
      const waiters = openAiLiveFinalWaiters.get(itemId);
      if (!waiters) return;
      waiters.delete(resolveWaiter);
      if (!waiters.size) openAiLiveFinalWaiters.delete(itemId);
    },
  };
};

const waitForOpenAiLiveCommit = () => {
  const sequence = ++openAiLiveCommitSequenceSent;
  const promise = new Promise<string>((resolve) => {
    openAiLiveCommitWaiters.set(sequence, resolve);
  });
  return {
    sequence,
    promise,
    cancel: (rollback = false) => {
      openAiLiveCommitWaiters.delete(sequence);
      if (
        rollback
        && openAiLiveCommitSequenceSent === sequence
        && openAiLiveCommitSequenceReceived < sequence
      ) {
        openAiLiveCommitSequenceSent -= 1;
      }
    },
  };
};

const publishOpenAiLiveCommit = (itemId: string) => {
  const sequence = ++openAiLiveCommitSequenceReceived;
  const resolve = openAiLiveCommitWaiters.get(sequence);
  openAiLiveCommitWaiters.delete(sequence);
  if (itemId && !openAiLiveFinalOutcomes.has(itemId)) {
    openAiLiveOutstandingItems.add(itemId);
  }
  resolve?.(itemId);
};

const waitForOpenAiLiveFinals = async (
  itemIds: Iterable<string>,
  timeoutMs: number,
): Promise<{ completed: boolean; failure?: string }> => {
  const pendingItemIds = [...new Set(itemIds)].filter(Boolean);
  if (!pendingItemIds.length) return { completed: true };
  const waits = pendingItemIds.map((itemId) => ({
    itemId,
    ...waitForOpenAiLiveFinal(itemId),
  }));
  let timer: number | null = null;
  let timedOut = false;
  try {
    await Promise.race([
      Promise.all(waits.map(({ promise }) => promise)).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = window.setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
    for (const wait of waits) wait.cancel();
  }
  const outcomes = waits.map(({ itemId }) => openAiLiveFinalOutcomes.get(itemId));
  const failed = outcomes.find(
    (outcome): outcome is Extract<OpenAiLiveFinalOutcome, { success: false }> =>
      outcome?.success === false,
  );
  if (!timedOut || outcomes.every(Boolean)) {
    for (const itemId of pendingItemIds) openAiLiveFinalOutcomes.delete(itemId);
  }
  return {
    completed: outcomes.every(Boolean),
    ...(failed ? { failure: failed.message } : {}),
  };
};

const openAiLiveSessionChangedError = () =>
  new Error("OpenAI Realtime transcription session changed before the turn was finalized.");

const failOpenAiLiveFinalization = (
  socket: WebSocket,
  transportGeneration: number,
  message: string,
): never => {
  if (
    openAiLiveSocket === socket
    && openAiLiveTransportGeneration === transportGeneration
  ) {
    // A missing commit/final acknowledgement makes event ordering ambiguous.
    // Reset instead of letting the next acknowledgement satisfy the wrong
    // sequence and silently submitting a partial transcript.
    const currentIntent = openAiLiveActiveLifecycleIntent === openAiLiveLifecycleIntent;
    closeOpenAiLiveSocket();
    if (currentIntent) notifyOpenAiLiveError(message);
  }
  throw new Error(message);
};

/**
 * Finalizes one manual transcription turn without closing the Realtime socket.
 * Translation sessions are continuous and intentionally have no commit event.
 */
const commitOpenAiLiveTurnNow = async (transportGeneration: number) => {
  if (openAiLiveTransportGeneration !== transportGeneration) {
    throw openAiLiveSessionChangedError();
  }
  const socket = openAiLiveSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN || !openAiLiveReady) {
    throw new Error("OpenAI Realtime transcription is not connected.");
  }

  let committedItemId = "";
  if (openAiLiveAudioPending) {
    const committed = waitForOpenAiLiveCommit();
    let timer: number | null = null;
    try {
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } catch (error) {
      committed.cancel(true);
      throw error;
    }

    // Audio appended after this synchronous send belongs to the next turn;
    // the later committed event must not clear that newer pending state.
    openAiLiveAudioPending = false;
    let commitTimedOut = false;
    try {
      committedItemId = await Promise.race([
        committed.promise,
        new Promise<string>((resolve) => {
          timer = window.setTimeout(() => {
            commitTimedOut = true;
            resolve("");
          }, OPENAI_LIVE_COMMIT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== null) window.clearTimeout(timer);
      committed.cancel();
    }

    if (
      openAiLiveTransportGeneration !== transportGeneration
      || openAiLiveSocket !== socket
    ) {
      throw openAiLiveSessionChangedError();
    }
    if (commitTimedOut) {
      failOpenAiLiveFinalization(
        socket,
        transportGeneration,
        "OpenAI Realtime did not acknowledge the audio commit. Reconnecting before this turn can be submitted.",
      );
    }
    if (!committedItemId) {
      failOpenAiLiveFinalization(
        socket,
        transportGeneration,
        "OpenAI Realtime acknowledged an audio commit without a transcript item. Reconnecting before this turn can be submitted.",
      );
    }
  }

  const finalItemIds = new Set([
    ...openAiLiveOutstandingItems,
    ...openAiLiveFinalOutcomes.keys(),
  ]);
  if (committedItemId) finalItemIds.add(committedItemId);
  const finalResult = await waitForOpenAiLiveFinals(
    finalItemIds,
    OPENAI_LIVE_FINAL_TIMEOUT_MS,
  );
  if (
    openAiLiveTransportGeneration !== transportGeneration
    || openAiLiveSocket !== socket
  ) {
    throw openAiLiveSessionChangedError();
  }
  if (finalResult.failure) {
    failOpenAiLiveFinalization(
      socket,
      transportGeneration,
      `OpenAI Realtime failed to transcribe the committed audio: ${finalResult.failure}`,
    );
  }
  if (!finalResult.completed) {
    failOpenAiLiveFinalization(
      socket,
      transportGeneration,
      "OpenAI Realtime did not finish the committed transcript. Reconnecting before this turn can be submitted.",
    );
  }
};

const commitOpenAiLiveTurn = (): Promise<void> => {
  // Translation has provider-owned continuous turn detection. Its service
  // waits for translation completion events instead of issuing manual commits.
  if (openAiNativeTranslationActive || openAiLiveMode === "translate") {
    return Promise.resolve();
  }
  if (
    !openAiLiveSocket
    || openAiLiveSocket.readyState !== WebSocket.OPEN
    || !openAiLiveReady
  ) {
    return Promise.reject(new Error("OpenAI Realtime transcription is not connected."));
  }
  const transportGeneration = openAiLiveTransportGeneration;
  const operation = openAiLiveFinalizeTail
    .catch(() => undefined)
    .then(() => commitOpenAiLiveTurnNow(transportGeneration));
  openAiLiveFinalizeTail = operation.catch(() => undefined);
  return operation;
};

const notifyOpenAiLiveError = (message: string) => {
  for (const listener of openAiLiveErrorListeners) {
    try {
      listener(message);
    } catch {}
  }
};

const ensureOpenAiTranslationListener = async () => {
  if (openAiTranslationUnlisten) return;
  if (!openAiTranslationListenPromise) {
    openAiTranslationListenPromise = listen<Record<string, any>>(
      "openai-translation-message",
      ({ payload }) => {
        if (!payload || typeof payload !== "object") return;
        const serverError = getOpenAiLiveError(payload);
        const currentIntent = openAiLiveActiveLifecycleIntent === openAiLiveLifecycleIntent;
        if (serverError && currentIntent) {
          notifyOpenAiLiveError(`OpenAI Realtime rejected the translation session: ${serverError}`);
        }
        for (const listener of openAiLiveMessageListeners) {
          try {
            listener(payload);
          } catch {}
        }
        if (payload.type === "session.closed" && openAiNativeTranslationActive) {
          openAiNativeTranslationActive = false;
          openAiLiveReady = false;
          if (currentIntent) {
            notifyOpenAiLiveError("OpenAI Realtime translation connection closed.");
          }
        }
      },
    )
      .then((unlisten) => {
        openAiTranslationUnlisten = unlisten;
      })
      .finally(() => {
        openAiTranslationListenPromise = null;
      });
  }
  await openAiTranslationListenPromise;
};

const resetOpenAiLiveSocketState = (expectedSocket?: WebSocket): boolean => {
  if (expectedSocket && openAiLiveSocket !== expectedSocket) return false;
  openAiLiveSocket = null;
  openAiLiveReady = false;
  openAiLiveAudioPending = false;
  openAiLiveMode = "transcribe";
  openAiLiveActiveLifecycleIntent = 0;
  openAiLiveTransportGeneration += 1;
  openAiLiveOutstandingItems.clear();
  for (const resolve of openAiLiveCommitWaiters.values()) resolve("");
  openAiLiveCommitWaiters.clear();
  openAiLiveCommitSequenceSent = 0;
  openAiLiveCommitSequenceReceived = 0;
  resolveOpenAiLiveFinalWaiters();
  openAiLiveFinalOutcomes.clear();
  return true;
};

const closeOpenAiLiveSocket = () => {
  const socket = openAiLiveSocket;
  resetOpenAiLiveSocketState();
  if (!socket) return;
  try {
    socket.close(1000, "client stop");
  } catch {}
};

const enqueueOpenAiLiveLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = openAiLiveLifecycleTail.then(operation, operation);
  openAiLiveLifecycleTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

class OpenAiLiveStartSupersededError extends Error {
  constructor() {
    super("OpenAI Realtime start was superseded");
    this.name = "OpenAiLiveStartSupersededError";
  }
}

const throwIfOpenAiLiveStartSuperseded = (signal: AbortSignal) => {
  if (signal.aborted) throw new OpenAiLiveStartSupersededError();
};

const raceOpenAiLiveStart = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(new OpenAiLiveStartSupersededError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new OpenAiLiveStartSupersededError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
};

const stopOpenAiLiveGracefullyNow = async () => {
  if (openAiNativeTranslationActive || openAiLiveMode === "translate") {
    openAiNativeTranslationActive = false;
    openAiLiveActiveLifecycleIntent = 0;
    openAiLiveReady = false;
    openAiLiveAudioPending = false;
    openAiLiveMode = "transcribe";
    try {
      await openAiTranslationAudioChain;
      await invoke("openai_translation_stop");
    } catch {}
    openAiTranslationAudioChain = Promise.resolve();
    return;
  }
  const socket = openAiLiveSocket;
  if (!socket) return;
  if (openAiLiveReady && socket.readyState === WebSocket.OPEN) {
    try {
      await commitOpenAiLiveTurn();
    } catch {
    }
  }
  if (openAiLiveSocket === socket) closeOpenAiLiveSocket();
  else {
    try {
      socket.close(1000, "client stop");
    } catch {}
  }
};

const openaiApi: AssistantAPI["openai"] = {
  getLiveCapability: async () => {
    if (typeof WebSocket === "undefined") {
      return {
        supported: false,
        configured: false,
        reason: "WebSocket is unavailable in this WebView.",
        model: OPENAI_LIVE_MODEL,
      };
    }
    try {
      return await invoke("openai_live_capability");
    } catch (error) {
      return {
        supported: false,
        configured: false,
        reason: error instanceof Error ? error.message : String(error),
        model: OPENAI_LIVE_MODEL,
      };
    }
  },
  startLive: ({ prompt, targetLanguage }) => {
    const lifecycleIntent = ++openAiLiveLifecycleIntent;
    openAiLivePendingStartAbort?.abort();
    const startAbort = new AbortController();
    openAiLivePendingStartAbort = startAbort;
    const { signal } = startAbort;
    return enqueueOpenAiLiveLifecycle(async () => {
      try {
        throwIfOpenAiLiveStartSuperseded(signal);
        // Replacing a transport is one lifecycle transaction: finish/drain the old
        // session first, then establish the requested one. Concurrent start/stop
        // calls are ordered by the lifecycle queue, so a stale start cannot win.
        await stopOpenAiLiveGracefullyNow();
        throwIfOpenAiLiveStartSuperseded(signal);
        // Also clear a native worker whose start may have succeeded after an IPC
        // delivery failure, before its frontend routing flag could be committed.
        await raceOpenAiLiveStart(
          invoke("openai_translation_stop").catch(() => undefined),
          signal,
        );
        const translating = Boolean(targetLanguage?.trim());
        if (translating) {
          await raceOpenAiLiveStart(ensureOpenAiTranslationListener(), signal);
          openAiLiveMode = "translate";
          try {
            openAiTranslationAudioChain = Promise.resolve();
            // Mark the setup generation before awaiting IPC. A session.closed
            // event can be delivered after Rust installs the worker but before
            // the command promise resolves in this WebView.
            openAiNativeTranslationActive = true;
            openAiLiveActiveLifecycleIntent = lifecycleIntent;
            const nativeStart = invoke("openai_translation_start", {
              targetLanguage: targetLanguage!.trim(),
            });
            const cancelPendingNativeStart = () => {
              void invoke("openai_translation_stop").catch(() => undefined);
            };
            signal.addEventListener("abort", cancelPendingNativeStart, { once: true });
            try {
              await raceOpenAiLiveStart(nativeStart, signal);
            } finally {
              signal.removeEventListener("abort", cancelPendingNativeStart);
            }
            throwIfOpenAiLiveStartSuperseded(signal);
            if (!openAiNativeTranslationActive) {
              throw new Error("OpenAI Realtime translation connection closed during setup.");
            }
            openAiLiveReady = true;
            return;
          } catch (error) {
            // The command may have established the native worker before an IPC
            // delivery failure. A best-effort stop prevents an orphaned translator
            // from continuing to emit into a later transcription session.
            await invoke("openai_translation_stop").catch(() => undefined);
            openAiNativeTranslationActive = false;
            openAiLiveActiveLifecycleIntent = 0;
            openAiLiveMode = "transcribe";
            openAiLiveReady = false;
            throw error;
          }
        }
        if (typeof WebSocket === "undefined") {
          throw new Error("OpenAI Realtime is not supported by this WebView.");
        }

        const auth = await raceOpenAiLiveStart(
          invoke("openai_live_create_token"),
          signal,
        );
        if (!auth?.token) {
          throw new Error("OpenAI Realtime could not create a temporary session token.");
        }
        throwIfOpenAiLiveStartSuperseded(signal);

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let opened = false;
          const socket = new WebSocket(
            // The client secret is already bound to a transcription session.
            // Supplying ?model= here would override that session as a generic
            // Realtime model and makes gpt-live-transcribe fail at session.update.
            buildOpenAiLiveWebSocketUrl(),
            ["realtime", `openai-insecure-api-key.${auth.token}`],
          );
          socket.binaryType = "arraybuffer";
          openAiLiveTransportGeneration += 1;
          openAiLiveSocket = socket;
          openAiLiveMode = "transcribe";
          const timeout = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abortPendingSocket);
            closeOpenAiLiveSocket();
            reject(
              new Error(
                opened
                  ? `OpenAI Realtime did not confirm the ${translating ? "translation" : "transcription"} session.`
                  : "OpenAI Realtime WebSocket connection timed out.",
              ),
            );
          }, 10_000);

          const abortPendingSocket = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", abortPendingSocket);
            if (openAiLiveSocket === socket) closeOpenAiLiveSocket();
            reject(new OpenAiLiveStartSupersededError());
          };
          signal.addEventListener("abort", abortPendingSocket, { once: true });
          if (signal.aborted) {
            abortPendingSocket();
            return;
          }

          const fail = (message: string) => {
            const wasCurrent = openAiLiveSocket === socket;
            if (wasCurrent) closeOpenAiLiveSocket();
            const superseded = lifecycleIntent !== openAiLiveLifecycleIntent;
            if (settled) {
              if (wasCurrent && !superseded) notifyOpenAiLiveError(message);
              return;
            }
            settled = true;
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", abortPendingSocket);
            if (!superseded) notifyOpenAiLiveError(message);
            reject(new Error(message));
          };

          socket.onopen = () => {
            opened = true;
            try {
              socket.send(JSON.stringify(buildOpenAiLiveSessionUpdate(prompt)));
            } catch (error) {
              fail(error instanceof Error ? error.message : String(error));
            }
          };

          socket.onmessage = (event) => {
            void (async () => {
              try {
                const message = await decodeOpenAiLiveMessage(event.data);
                if (openAiLiveSocket !== socket) return;
                // Item-level transcription failures belong to the current turn;
                // record and forward them below so finalizeTurn rejects with that
                // outcome. Only a top-level Realtime `error` invalidates setup or
                // the entire socket immediately.
                const serverError = message.type === "error"
                  ? getOpenAiLiveError(message)
                  : null;
                if (serverError) {
                  fail(`OpenAI Realtime rejected the session: ${serverError}`);
                  return;
                }
                if (
                  message.type === "session.updated" &&
                  !settled
                ) {
                  settled = true;
                  openAiLiveReady = true;
                  openAiLiveActiveLifecycleIntent = lifecycleIntent;
                  window.clearTimeout(timeout);
                  signal.removeEventListener("abort", abortPendingSocket);
                  resolve();
                }
                if (message.type === "input_audio_buffer.committed") {
                  publishOpenAiLiveCommit(
                    typeof message.item_id === "string" ? message.item_id : "",
                  );
                }
                if (message.type ===
                  "conversation.item.input_audio_transcription.delta"
                ) {
                  const itemId =
                    typeof message.item_id === "string" ? message.item_id : "";
                  if (itemId) openAiLiveOutstandingItems.add(itemId);
                }
                if (
                  (message.type ===
                    "conversation.item.input_audio_transcription.completed" ||
                    message.type ===
                      "conversation.item.input_audio_transcription.failed")
                ) {
                  const itemId =
                    typeof message.item_id === "string" ? message.item_id : "";
                  if (itemId) {
                    const outcome: OpenAiLiveFinalOutcome = message.type.endsWith(".failed")
                      ? {
                          success: false,
                          message: getOpenAiLiveError(message)
                            || "OpenAI could not transcribe the committed audio segment.",
                        }
                      : { success: true };
                    openAiLiveFinalOutcomes.set(itemId, outcome);
                    openAiLiveOutstandingItems.delete(itemId);
                    resolveOpenAiLiveFinalWaiters(itemId, outcome);
                  }
                }
                for (const listener of openAiLiveMessageListeners) {
                  try {
                    listener(message);
                  } catch {}
                }
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                if (!settled) {
                  fail(`OpenAI Realtime returned an unreadable setup response: ${detail}`);
                } else {
                  notifyOpenAiLiveError(
                    `OpenAI Realtime returned an unreadable response: ${detail}`,
                  );
                }
              }
            })();
          };
          socket.onerror = () =>
            fail(
              `OpenAI Realtime ${translating ? "translation" : "transcription"} connection failed. Check the API key and network access.`,
            );
          socket.onclose = (event) => {
            const wasCurrent = resetOpenAiLiveSocketState(socket);
            if (!settled) {
              fail(event.reason || `OpenAI Realtime closed during setup (${event.code}).`);
            } else if (wasCurrent) {
              notifyOpenAiLiveError(
                event.reason || `OpenAI Realtime connection closed (${event.code}).`,
              );
            }
          };
        });
      } catch (error) {
        // A later start/stop owns the final state. Let that queued operation
        // complete without surfacing the superseded setup failure as a false
        // "realtime unavailable" status to the user.
        if (
          error instanceof OpenAiLiveStartSupersededError
          || lifecycleIntent !== openAiLiveLifecycleIntent
        ) return;
        throw error;
      } finally {
        if (openAiLivePendingStartAbort === startAbort) {
          openAiLivePendingStartAbort = null;
        }
      }
    });
  },
  sendAudioChunk: ({ data }) => {
    if (openAiNativeTranslationActive && openAiLiveReady) {
      // Tauri commands are asynchronous; serialize them explicitly so PCM
      // frames cannot overtake one another before they reach the native
      // WebSocket writer.
      openAiTranslationAudioChain = openAiTranslationAudioChain
        .then(() => invoke("openai_translation_send_audio", { data }))
        .catch((error) => {
          openAiNativeTranslationActive = false;
          openAiLiveReady = false;
          notifyOpenAiLiveError(
            error instanceof Error ? error.message : String(error),
          );
        });
      return;
    }
    const socket = openAiLiveSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !openAiLiveReady) return;
    try {
      socket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data,
        }),
      );
    } catch (error) {
      if (openAiLiveSocket === socket) closeOpenAiLiveSocket();
      notifyOpenAiLiveError(
        error instanceof Error ? error.message : "OpenAI Realtime audio send failed.",
      );
      return;
    }
    if (openAiLiveMode === "transcribe") openAiLiveAudioPending = true;
  },
  commitLiveTurn: commitOpenAiLiveTurn,
  stopLive: () => {
    openAiLiveLifecycleIntent += 1;
    openAiLivePendingStartAbort?.abort();
    openAiLivePendingStartAbort = null;
    return enqueueOpenAiLiveLifecycle(stopOpenAiLiveGracefullyNow);
  },
  onMessage: (callback) => {
    openAiLiveMessageListeners.add(callback);
    return () => openAiLiveMessageListeners.delete(callback);
  },
  onError: (callback) => {
    openAiLiveErrorListeners.add(callback);
    return () => openAiLiveErrorListeners.delete(callback);
  },
};

const providersApi: AssistantAPI["providers"] = {
  testModel: (provider, model) =>
    invoke("provider_test_model", {
      request: { provider, model },
    }),
};

const authApi: AssistantAPI["auth"] = {
  getMethods: () => invoke("auth_get_methods"),
  startOAuth: (provider) => invoke("auth_start_oauth", { provider }),
  cancelPendingOAuth: () => invoke("auth_cancel_pending"),
  onOAuthPayload: (cb) => {
    authListeners.add(cb);
    void ensureAuthSubscription();
    return () => {
      authListeners.delete(cb);
      if (!authListeners.size && authUnlisten) {
        void authUnlisten();
        authUnlisten = null;
        void invoke("auth_renderer_not_ready");
      }
    };
  },
  consumePendingOAuthPayloads: async () => {
    // Install the event listener before marking the renderer ready/draining the
    // queue. Pending payloads are returned to the caller and must not also be
    // dispatched here, otherwise a login is processed twice.
    await ensureAuthSubscription();
    return invoke("auth_consume_pending");
  },
};

const mediaApi: AssistantAPI["media"] = {
  getPrimaryDisplaySourceId: async () => null,
};

const localSpeechApi: AssistantAPI["localSpeech"] = {
  getStatus: () => invoke("local_speech_get_status"),
  checkHealth: () => invoke("local_speech_check_health"),
  install: () => invoke("local_speech_install"),
  start: () => invoke("local_speech_start"),
  restart: () => invoke("local_speech_restart"),
  reinstall: () => invoke("local_speech_reinstall"),
  stop: () => invoke("local_speech_stop"),
  checkModelDownloaded: (model: string) =>
    invoke("local_speech_check_model_downloaded", { model }),
};

const ollamaApi: AssistantAPI["ollama"] = {
  checkInstalled: () => invoke("ollama_check_installed"),
  listModels: () => invoke("ollama_list_models"),
  pullModel: (model: string) => invoke("ollama_pull_model", { model }),
  warmupModel: (model: string) => invoke("ollama_warmup_model", { model }),
  streamChat: (args, onEvent) => {
    const channel = new Channel<OllamaStreamEvent>();
    channel.onmessage = onEvent;
    return invoke("ollama_stream_chat", { ...args, onEvent: channel });
  },
  cancelChat: (requestId: string) =>
    invoke("ollama_cancel_chat", { requestId }),
};

const api: AssistantAPI = {
  assistant: assistantApi,
  hotkeys: hotkeysApi,
  settings: settingsApi,
  window: windowApi,
  loopback: loopbackApi,
  screen: screenApi,
  google: googleApi,
  openai: openaiApi,
  providers: providersApi,
  auth: authApi,
  media: mediaApi,
  localSpeech: localSpeechApi,
  ollama: ollamaApi,
  audio: audioApi,
  diagnostics: diagnosticsApi,
  log: async (entry) => {
    const prefix = `[${entry.category}] ${entry.message}`;
    const data = entry.data;
    const consoleMethod =
      entry.level === "error"
        ? console.error
        : entry.level === "warn"
          ? console.warn
          : entry.level === "debug"
            ? console.debug
            : console.info;
    if (data && typeof data === "object" && Object.keys(data).length > 0) {
      console.groupCollapsed(prefix);
      consoleMethod(data);
      console.groupEnd();
    } else {
      consoleMethod(prefix);
    }
    try {
      await invoke("log_frontend", { entry });
    } catch (error) {
      console.warn("[logger] failed to write frontend log", error);
    }
  },
};

if (typeof window !== "undefined") {
  (window as any).api = api;
}

async function ensureAuthSubscription() {
  if (authUnlisten || !authListeners.size) return;
  if (authListenPromise) return authListenPromise;
  authListenPromise = (async () => {
    const unlisten = await listen<AuthDeepLinkPayload>(
      "auth:deep-link",
      (event) => {
        dispatchAuthPayload(event.payload);
      },
    );
    if (!authListeners.size) {
      unlisten();
      void invoke("auth_renderer_not_ready");
      return;
    }
    authUnlisten = unlisten;
  })();
  try {
    await authListenPromise;
  } finally {
    authListenPromise = null;
  }
}

function dispatchAuthPayload(payload: AuthDeepLinkPayload) {
  authListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("[authBridge] listener failed", error);
    }
  });
}

function isScreenPickerCancellation(error: unknown): boolean {
  const name = error instanceof DOMException
    ? error.name
    : typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  return name === "AbortError" || name === "NotAllowedError";
}

function waitForVideoMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer: number | null = null;
    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
    };
    const handleLoaded = () => {
      cleanup();
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
      else reject(new Error("The selected screen did not provide a video frame"));
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The selected screen could not be read"));
    };
    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while preparing the selected screen"));
    }, timeoutMs);
  });
}

function waitForVideoFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== "function") {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: number | null = null;
    const callbackId = video.requestVideoFrameCallback(() => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      resolve();
    });
    timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      video.cancelVideoFrameCallback(callbackId);
      reject(new Error("Timed out while reading the selected screen"));
    }, timeoutMs);
  });
}

async function captureScreenFrame(signal?: AbortSignal): Promise<{
  base64: string;
  width: number;
  height: number;
  mime: string;
}> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: 1,
    },
    audio: false,
  });
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error("Screen capture was cancelled");
  };
  signal?.addEventListener("abort", stopTracks, { once: true });
  try {
    throwIfAborted();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await waitForVideoMetadata(video, 8_000);
    throwIfAborted();
    await video.play();
    await waitForVideoFrame(video, 8_000);
    throwIfAborted();
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const maxDimension = 1920;
    const scale = Math.min(
      1,
      maxDimension / Math.max(sourceWidth, sourceHeight),
    );
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to capture screen frame");
    }
    ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    const base64 = dataUrl.split(",")[1] || "";
    if (!base64) throw new Error("The selected screen returned an empty image");
    return {
      base64,
      width,
      height,
      mime: "image/jpeg",
    };
  } finally {
    signal?.removeEventListener("abort", stopTracks);
    stopTracks();
  }
}

import {
  appendChatMessage,
  beginRetryChatMessage,
  getActiveChatId,
  getConversationContext,
  removeChatMessages,
  showError,
  updateChatMessage,
} from "../ui/outputs";
import { getStatusSnapshot, setStatus } from "../ui/status";
import { setProcessing, setRecording, state } from "../state/appState";
import { floatsToWav } from "../audio/encoder";
import { logger } from "../utils/logger";
import { settingsStore } from "../state/settingsStore";
import { GoogleStreamingService } from "../services/googleStreamingService";
import {
  OpenAiStreamingService,
  type OpenAiRealtimeAcknowledgement,
} from "../services/openAiStreamingService";
import { LatestIntentQueue } from "./latestIntentQueue";
import {
  checkOllamaInstalled,
  checkOllamaModelDownloaded,
  isOllamaModelDownloading,
  isOllamaModelWarming,
  normalizeOllamaModelName,
} from "../services/ollama";
import { LOCAL_LLM_MODELS } from "@shared/constants";
import {
  getRealtimeTranscriptionTarget,
  type RealtimeTranscriptionTarget,
} from "../services/realtimeTranscription";
import type { SwitchAudioResult } from "./audioSession";
import {
  getAudioInputType,
  getLastSecondsFloats,
  setAudioInputType,
  startRecording as startAudioRecording,
  stopRecording as stopAudioRecording,
  switchAudioInput as switchAudioInputDevice,
} from "./audioSession";
import { hideStopButton, showStopButton } from "../ui/stopButton";
import {
  resolveLlmProvider,
  type ChatProvider,
  type ChatSource,
} from "../ui/chatMetadata";
import { migrateLegacyAudioDeviceSelection } from "./audioSession/deviceSelection";
import type {
  AppSettings,
  AssistantAPI,
  PromptImageAttachment,
} from "@shared/ipc";

type StreamDeltaHandler = Parameters<
  AssistantAPI["assistant"]["onStreamDelta"]
>[0];
type StreamDoneHandler = Parameters<
  AssistantAPI["assistant"]["onStreamDone"]
>[0];
type StreamErrorHandler = Parameters<
  AssistantAPI["assistant"]["onStreamError"]
>[0];

export type AudioInputType = "microphone" | "system" | "mixed";

export type StreamControllerUi = {
  updateRealtimeTranscript?: (previous: string, next: string) => void;
  updateRealtimeTranslation?: (update: {
    sourcePrevious: string;
    sourceNext: string;
    translatedPrevious: string;
    translatedNext: string;
  }) => void;
  applyRealtimeAcknowledgement?: (update: RealtimeAcknowledgementUpdate) => void;
  restoreQuestionIfEmpty?: (text: string) => void;
  onOperationSettled?: (settlement: StreamOperationSettlement) => void;
  setAudioInputPresentation?: (
    type: AudioInputType,
    switching: boolean,
  ) => void;
  onAudioInputChanged?: () => void;
};

export type StopDisposition = "manual" | "auto-continuation" | "auto-new-turn";

export type StopActiveOperationOptions = {
  disposition?: StopDisposition;
  /**
   * Keep a cancelled turn visible, but never feed it back to the model.
   * This is required for superseded multimodal turns because chat history
   * stores only an attachment marker, not the image pixels.
   */
  excludeFromHistory?: boolean;
};

export type StreamOperationSettlement = {
  requestId: string;
  status: "completed" | "failed" | "cancelled";
  disposition?: StopDisposition;
  chatId?: string;
  userText?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  partialText: string;
};

export type StreamOperationSnapshot = {
  inProgress: boolean;
  requestId: string | null;
  chatId: string | null;
  userText: string;
  partialText: string;
};

export type RealtimeCanonicalSnapshot = {
  target: RealtimeTranscriptionTarget | null;
  revision: number;
  /** Text auto mode should submit; translation deliberately wins over the visible toggle. */
  text: string;
  source: string;
  translated: string;
};

export type RealtimeAcknowledgementUpdate = {
  target: RealtimeTranscriptionTarget;
  /** Exact textarea text handed to the manual request, when applicable. */
  submittedText?: string;
  submittedTranslationView?: "source" | "translated";
  acknowledgedTranscript: string;
  acknowledgedSource: string;
  acknowledgedTranslated: string;
  /** Provider text received after the submitted watermark. */
  transcript: string;
  source: string;
  translated: string;
};

type RealtimeSubmissionAcknowledgement = {
  target: RealtimeTranscriptionTarget;
  submittedText?: string;
  submittedTranslationView?: "source" | "translated";
  transcript: string;
  source: string;
  translated: string;
  openAi?: OpenAiRealtimeAcknowledgement;
};

type PendingRealtimeAcknowledgement = {
  acknowledgement: RealtimeSubmissionAcknowledgement | null;
};

export type TextSendOptions = {
  submittedTranslationView?: "source" | "translated";
};

type PendingConversation = {
  chatId: string;
  requestId: string;
  userText: string;
  userMessageId: string;
  assistantMessageId: string;
};

export class StreamController {
  private googleStreamingService = new GoogleStreamingService();
  private openAiStreamingService = new OpenAiStreamingService();
  private initialized = false;
  private disposed = false;

  private currentRequestId: string | null = null;
  private activeOpId = 0;
  private streamDeltaHandler: StreamDeltaHandler | null = null;
  private streamDoneHandler: StreamDoneHandler | null = null;
  private streamErrorHandler: StreamErrorHandler | null = null;

  private streamAccumulator = "";
  private activeRealtimeTarget: RealtimeTranscriptionTarget | null = null;
  private desiredRealtimeTarget: RealtimeTranscriptionTarget | null = null;
  private readonly realtimeTransitions = new LatestIntentQueue();
  private lastRealtimeTranscript = "";
  private lastRealtimeSource = "";
  private lastRealtimeTranslation = "";
  private realtimeRevision = 0;
  private submittedRealtimeFragment = "";
  private pendingRealtimeAcknowledgement: PendingRealtimeAcknowledgement | null = null;
  private realtimeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeRetryAttempt = 0;
  private realtimeTerminalError: string | null = null;
  private operationInProgress = false;
  private audioSwitchInProgress = false;
  private pendingConversation: PendingConversation | null = null;

  constructor(private readonly ui: StreamControllerUi = {}) {}

  getOperationSnapshot(): StreamOperationSnapshot {
    return {
      inProgress: this.operationInProgress || !!this.currentRequestId,
      requestId: this.currentRequestId,
      chatId: this.pendingConversation?.chatId ?? null,
      userText: this.pendingConversation?.userText ?? "",
      partialText: this.streamAccumulator,
    };
  }

  getRealtimeCanonicalSnapshot(): RealtimeCanonicalSnapshot {
    const translating = this.activeRealtimeTarget === "openai-translate"
      || this.desiredRealtimeTarget === "openai-translate";
    const unsubmittedTranscript = this.getUnsubmittedRealtimeTranscript(
      this.lastRealtimeTranscript,
    ).text;
    return {
      target: this.activeRealtimeTarget ?? this.desiredRealtimeTarget,
      revision: this.realtimeRevision,
      text: translating ? this.lastRealtimeTranslation : unsubmittedTranscript,
      source: translating ? this.lastRealtimeSource : unsubmittedTranscript,
      translated: translating ? this.lastRealtimeTranslation : "",
    };
  }

  /** Finalizes only the current realtime utterance while keeping capture alive. */
  async finalizeRealtimeTurn(): Promise<void> {
    const target = this.activeRealtimeTarget ?? this.desiredRealtimeTarget;
    if (target === "openai-transcribe") {
      await this.openAiStreamingService.finalizeTurn();
    } else if (target === "openai-translate") {
      // Translation has provider-side turn detection. Prefer its final output
      // boundary, but never stall Auto indefinitely if the boundary is lost.
      await this.openAiStreamingService.waitForTranslationTurnCompleted(1_200);
    }
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private setErrorStatus(message: string): void {
    setStatus(message, "error");
    setProcessing(false);
  }

  private restoreRecordingAwareStatus(idleText = "Ready"): void {
    if (!state.isRecording) {
      setStatus(idleText, "ready");
      return;
    }
    const current = getStatusSnapshot();
    if (current.type === "error" && current.text.toLowerCase().includes("realtime")) {
      return;
    }
    if (this.realtimeTerminalError) {
      setStatus(this.realtimeTerminalError, "error");
      return;
    }
    if (this.desiredRealtimeTarget && !this.activeRealtimeTarget) {
      setStatus(
        this.realtimeRetryTimer
          ? "Recording · reconnecting realtime…"
          : "Recording · connecting realtime…",
        "recording",
      );
      return;
    }
    const target = this.activeRealtimeTarget;
    setStatus(
      target === "openai-translate"
        ? "Recording · OpenAI Translate"
        : target === "openai-transcribe"
          ? "Recording · OpenAI Live"
          : target === "google"
            ? "Recording · Google Live"
            : "Recording...",
      "recording",
    );
  }

  private notifyOperationSettled(settlement: StreamOperationSettlement): void {
    try {
      this.ui.onOperationSettled?.(settlement);
    } catch (error) {
      logger.warn("stream", "Operation settlement listener failed", { error });
    }
  }

  private isMeaningfulPartial(text: string): boolean {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return false;
    return normalized.length >= 24 || normalized.split(" ").filter(Boolean).length >= 5;
  }

  private async loadSettingsSafe(): Promise<AppSettings> {
    try {
      return settingsStore.get();
    } catch {
      return settingsStore.load();
    }
  }

  private getUnsubmittedRealtimeTranscript(value: string): {
    text: string;
    matchedSubmission: boolean;
  } {
    const submitted = this.submittedRealtimeFragment;
    if (!submitted) return { text: value, matchedSubmission: false };
    const core = value.trim();
    if (!core || core === submitted || submitted.startsWith(core)) {
      return { text: "", matchedSubmission: true };
    }
    if (core.startsWith(submitted)) {
      return {
        // Keep the provider's whitespace boundary. Incremental reconciliation
        // uses it to distinguish a word continuation from a fresh word.
        text: core.slice(submitted.length),
        matchedSubmission: true,
      };
    }
    return { text: value, matchedSubmission: false };
  }

  private readonly onTranscript = (text: string) => {
    if (!text.trim()) return;
    if (text === this.lastRealtimeTranscript) return;
    const previous = this.getUnsubmittedRealtimeTranscript(
      this.lastRealtimeTranscript,
    ).text;
    this.lastRealtimeTranscript = text;
    this.realtimeRevision += 1;
    const unsubmitted = this.getUnsubmittedRealtimeTranscript(text);
    if (this.submittedRealtimeFragment && !unsubmitted.matchedSubmission) {
      // A provider-side turn boundary starts a new independent transcript.
      this.submittedRealtimeFragment = "";
    }
    if (!unsubmitted.text.trim()) return;
    this.ui.updateRealtimeTranscript?.(previous, unsubmitted.text);
  };

  private readonly onTranslation = (text: {source: string; translated: string}) => {
    if (
      text.source === this.lastRealtimeSource &&
      text.translated === this.lastRealtimeTranslation
    ) return;
    const update = {
      sourcePrevious: this.lastRealtimeSource,
      sourceNext: text.source,
      translatedPrevious: this.lastRealtimeTranslation,
      translatedNext: text.translated,
    };
    this.lastRealtimeSource = text.source;
    this.lastRealtimeTranslation = text.translated;
    this.realtimeRevision += 1;
    this.ui.updateRealtimeTranslation?.(update);
  };

  private captureRealtimeAcknowledgement(
    submittedText?: string,
    submittedTranslationView?: "source" | "translated",
  ): RealtimeSubmissionAcknowledgement | null {
    const target = this.activeRealtimeTarget ?? this.desiredRealtimeTarget;
    if (!target) return null;
    return {
      target,
      ...(submittedText === undefined ? {} : { submittedText }),
      ...(submittedTranslationView === undefined
        ? {}
        : { submittedTranslationView }),
      transcript: this.lastRealtimeTranscript,
      source: this.lastRealtimeSource,
      translated: this.lastRealtimeTranslation,
      openAi: target.startsWith("openai")
        ? this.openAiStreamingService.captureAcknowledgement()
        : undefined,
    };
  }

  private remainingAfterAcknowledgement(value: string, captured: string): string {
    if (!captured) return value;
    if (value === captured || captured.startsWith(value)) return "";
    if (value.startsWith(captured)) return value.slice(captured.length);

    const valueCore = value.trim();
    const capturedCore = captured.trim();
    if (!capturedCore) return value;
    if (valueCore === capturedCore || capturedCore.startsWith(valueCore)) return "";
    if (valueCore.startsWith(capturedCore)) {
      return valueCore.slice(capturedCore.length);
    }
    // A final provider revision may replace the captured partial entirely.
    // Keep that revision as a new prompt rather than acknowledging unseen text.
    return value;
  }

  acknowledgeRealtimeSubmission(): void {
    const pending = this.pendingRealtimeAcknowledgement;
    const acknowledgement = pending
      ? pending.acknowledgement
      : this.captureRealtimeAcknowledgement();
    this.pendingRealtimeAcknowledgement = null;
    if (!acknowledgement) return;

    const target = this.activeRealtimeTarget ?? this.desiredRealtimeTarget;
    if (target !== acknowledgement.target) return;

    if (target.startsWith("openai")) {
      if (
        !acknowledgement.openAi
        || !this.openAiStreamingService.acknowledgeTranscript(acknowledgement.openAi)
      ) return;

      const transcript = this.remainingAfterAcknowledgement(
        this.lastRealtimeTranscript,
        acknowledgement.transcript,
      );
      const source = this.remainingAfterAcknowledgement(
        this.lastRealtimeSource,
        acknowledgement.source,
      );
      const translated = this.remainingAfterAcknowledgement(
        this.lastRealtimeTranslation,
        acknowledgement.translated,
      );
      this.lastRealtimeTranscript = transcript;
      this.lastRealtimeSource = source;
      this.lastRealtimeTranslation = translated;
      this.submittedRealtimeFragment = "";
      this.realtimeRevision += 1;
      this.ui.applyRealtimeAcknowledgement?.({
        target,
        ...(acknowledgement.submittedText === undefined
          ? {}
          : { submittedText: acknowledgement.submittedText }),
        ...(acknowledgement.submittedTranslationView === undefined
          ? {}
          : { submittedTranslationView: acknowledgement.submittedTranslationView }),
        acknowledgedTranscript: acknowledgement.transcript,
        acknowledgedSource: acknowledgement.source,
        acknowledgedTranslated: acknowledgement.translated,
        transcript,
        source,
        translated,
      });
      return;
    }

    // Google publishes a cumulative transcript rather than a provider-side
    // acknowledgement boundary. Retain the raw value and advance only the
    // local watermark so the next cumulative revision can be reconciled.
    this.submittedRealtimeFragment = acknowledgement.transcript.trim();
    this.realtimeRevision += 1;
    const transcript = this.getUnsubmittedRealtimeTranscript(
      this.lastRealtimeTranscript,
    ).text;
    this.ui.applyRealtimeAcknowledgement?.({
      target,
      ...(acknowledgement.submittedText === undefined
        ? {}
        : { submittedText: acknowledgement.submittedText }),
      ...(acknowledgement.submittedTranslationView === undefined
        ? {}
        : { submittedTranslationView: acknowledgement.submittedTranslationView }),
      acknowledgedTranscript: acknowledgement.transcript,
      acknowledgedSource: acknowledgement.source,
      acknowledgedTranslated: acknowledgement.translated,
      transcript,
      source: transcript,
      translated: "",
    });
  }

  private onStreamingError(
    target: RealtimeTranscriptionTarget,
    error: string,
  ): void {
    if (target !== this.desiredRealtimeTarget) return;
    console.error(`${target} realtime transcription error:`, error);
    this.activeRealtimeTarget = null;
    if (this.realtimeRetryTimer) return;
    if (this.disposed || !state.isRecording) {
      this.realtimeTerminalError = null;
      void this.stopRealtimeServices();
      return;
    }
    if (this.realtimeRetryAttempt >= 4) {
      void this.stopRealtimeServices();
      this.realtimeTerminalError = `Realtime transcription stopped: ${error}`;
      setStatus(this.realtimeTerminalError, "error");
      return;
    }
    this.realtimeTerminalError = null;
    const delay = Math.min(1_000 * 2 ** this.realtimeRetryAttempt, 8_000);
    this.realtimeRetryAttempt += 1;
    setStatus("Recording · reconnecting realtime…", "recording");
    this.realtimeRetryTimer = setTimeout(() => {
      this.realtimeRetryTimer = null;
      void this.syncRealtimeTranscription();
    }, delay);
  }

  private clearRealtimeRetry(): void {
    if (this.realtimeRetryTimer) clearTimeout(this.realtimeRetryTimer);
    this.realtimeRetryTimer = null;
    this.realtimeRetryAttempt = 0;
  }

  initialize(): void {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    this.googleStreamingService.onTranscript(this.onTranscript);
    this.googleStreamingService.onError((error) =>
      this.onStreamingError("google", error),
    );
    this.openAiStreamingService.onTranscript(this.onTranscript);
    this.openAiStreamingService.onTranslation(this.onTranslation);
    this.openAiStreamingService.onError((error) => {
      const target = this.desiredRealtimeTarget?.startsWith("openai")
        ? this.desiredRealtimeTarget
        : "openai-transcribe";
      this.onStreamingError(target, error);
    });
  }

  async syncInitialSettings(): Promise<void> {
    const settings = await this.loadSettingsSafe();
    try {
      await migrateLegacyAudioDeviceSelection(
        await window.api.audio.listDevices(),
        settings.audioInputDeviceId || "",
      );
    } catch (error) {
      logger.warn(
        "audio",
        "Legacy microphone selection could not be migrated",
        {
          error: this.toErrorMessage(error),
        },
      );
    }
    const audioInputType = (settings.audioInputType ||
      "microphone") as AudioInputType;
    setAudioInputType(audioInputType);
    await this.updateToggleButtonLabel(audioInputType);
  }

  handleSettingsChange(
    key: string,
    value: unknown,
  ): boolean | Promise<boolean> {
    switch (key) {
      case "audioInputType": {
        const normalized =
          value === "system"
            ? "system"
            : value === "mixed"
              ? "mixed"
              : "microphone";
        return this.applyAudioInputSetting(normalized);
      }
      case "audioInputDeviceId":
        return this.applyAudioDeviceSetting(
          typeof value === "string" ? value : "",
        );
      case "transcriptionMode":
      case "transcriptionModel":
      case "realtimeTranslationLanguage": {
        settingsStore.patch({ [key]: value } as Partial<AppSettings>);
        if (key === "realtimeTranslationLanguage" && state.isRecording) {
          // The target language is bound to the short-lived translation
          // session, so changing it requires a fresh session even though the
          // selected model/provider did not change.
          this.activeRealtimeTarget = null;
        }
        return (
          state.isRecording
            ? this.syncRealtimeTranscription()
            : Promise.resolve()
        ).then(() => true);
      }
      default:
        return false;
    }
  }

  async handleRecordToggle(shouldRecord: boolean): Promise<void> {
    try {
      if (shouldRecord) {
        await startAudioRecording();
        await this.syncRealtimeTranscription();
      } else {
        try {
          await stopAudioRecording();
        } finally {
          // Recording state is changed by RendererSession before this
          // call. Queueing the stop prevents it overlapping an older
          // capability/token/WebSocket start.
          await this.syncRealtimeTranscription();
        }
      }
    } catch (error) {
      console.error("Record toggle failed", error);
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (
        code === "system-audio-capture-failed" ||
        message === "system-audio-capture-failed"
      ) {
        setStatus(
          "System audio capture failed. Grant access or switch to microphone.",
          "error",
        );
      } else {
        setStatus("Failed to start recording", "error");
      }
      setRecording(false);
      throw error;
    }
  }

  async handleAskWindow(
    seconds: number,
    promptText = "",
    images: PromptImageAttachment[] = [],
    options: { automatic?: boolean } = {},
  ): Promise<boolean> {
    logger.info("ui", "Handle ask window", { seconds, automatic: options.automatic === true });

    const hasStreamOperation = this.operationInProgress || !!this.currentRequestId;
    if (state.isProcessing && !hasStreamOperation) return false;
    if (hasStreamOperation) {
      await this.stopActiveOperation();
    }

    const opId = ++this.activeOpId;
    const chatId = getActiveChatId();
    this.operationInProgress = true;

    setProcessing(true);
    showStopButton();
    setStatus("Recognizing...", "processing");

    const pcm = getLastSecondsFloats(seconds);
    if (!pcm || pcm.channels[0].length === 0) {
      logger.warn("ui", "No audio in buffer", {
        seconds,
        hasPcm: !!pcm,
        channelsLength: pcm?.channels?.length || 0,
        firstChannelLength: pcm?.channels[0]?.length || 0,
        inputType: getAudioInputType(),
      });
      setStatus("No audio in buffer", "error");
      setProcessing(false);
      this.operationInProgress = false;
      hideStopButton();
      return false;
    }

    const actualSeconds = pcm.durationSeconds;
    const durationLabel =
      actualSeconds >= 10 ? actualSeconds.toFixed(1) : actualSeconds.toFixed(2);
    const hasFullWindow = actualSeconds + 1 / pcm.sampleRate >= seconds;
    if (!options.automatic) {
      appendChatMessage(
        "system",
        hasFullWindow
          ? `Last ${durationLabel}s sent for transcription...`
          : `Only ${durationLabel}s of the requested ${seconds}s is available; sending that audio...`,
        { chatId, source: "audio" },
      );
    }

    let audioBuffer: ArrayBuffer;
    let maxAmplitude = 0;
    let rms = 0;
    let expectedFrames = 0;
    let dataMaxAmp = 0;
    try {
      const result = await this.prepareAudioBuffer(pcm, actualSeconds);
      if (opId !== this.activeOpId) {
        // A newer operation owns all global processing/status state now.
        return false;
      }
      audioBuffer = result.arrayBuffer;
      maxAmplitude = result.maxAmplitude;
      rms = result.rms;
      expectedFrames = result.expectedFrames;
      dataMaxAmp = result.dataMaxAmp;
    } catch (error) {
      if (opId !== this.activeOpId) {
        return false;
      }
      this.setErrorStatus(this.toErrorMessage(error));
      this.operationInProgress = false;
      setProcessing(false);
      hideStopButton();
      return false;
    }

    const requestId = `ask-window-${crypto.randomUUID()}`;
    this.currentRequestId = requestId;
    logger.info("ui", "Sending audio for transcription", {
      size: audioBuffer.byteLength,
      requestedSeconds: seconds,
      actualSeconds,
      sampleRate: pcm.sampleRate,
      channels: pcm.channels.length,
      frames: expectedFrames,
      maxAmplitude,
      rms,
      wavDataMaxAmp: dataMaxAmp,
      wavHeaderValid: true,
    });

    try {
      const transcribeRes = await window.api.assistant.transcribeOnly({
        arrayBuffer: audioBuffer,
        mime: "audio/wav",
        filename: `last_${Math.round(actualSeconds * 1000)}ms.wav`,
        audioSeconds: actualSeconds,
        requestId,
      });

      if (opId !== this.activeOpId) {
        return false;
      }
      if (!transcribeRes.ok) {
        setStatus("Error", "error");
        showError(transcribeRes.error, chatId, { source: "audio" });
        setProcessing(false);
        this.operationInProgress = false;
        this.currentRequestId = null;
        this.notifyOperationSettled({
          requestId,
          status: "failed",
          chatId,
          userMessageId: undefined,
          assistantMessageId: undefined,
          partialText: "",
        });
        hideStopButton();
        return false;
      }

      const transcript = transcribeRes.text.trim();
      const instruction = promptText.trim();
      const text = instruction
        ? `${transcript}\n\nUser request: ${instruction}`
        : transcript;

      setStatus("Sending to LLM...", "sending");
      const started = await this.sendChatRequest(
        requestId,
        text,
        "audio",
        chatId,
        opId,
        images,
      );
      if (!started) {
        this.ui.restoreQuestionIfEmpty?.(instruction || transcript);
      }
      return started;
    } catch (error) {
      if (opId !== this.activeOpId) {
        // A user cancellation invalidates this operation before the
        // native transcription promise rejects. Do not surface that
        // expected cancellation as a new error or disturb its successor.
        return false;
      }
      setStatus("Error", "error");
      const failedPending = this.pendingConversation;
      const hadPending = !!failedPending;
      this.failPendingConversation(this.toErrorMessage(error), this.streamAccumulator);
      if (!hadPending) {
        showError(error, chatId, { source: "audio" });
      }
      setProcessing(false);
      this.operationInProgress = false;
      this.currentRequestId = null;
      this.notifyOperationSettled({
        requestId,
        status: "failed",
        chatId: failedPending?.chatId ?? chatId,
        userText: failedPending?.userText,
        userMessageId: failedPending?.userMessageId,
        assistantMessageId: failedPending?.assistantMessageId,
        partialText: this.streamAccumulator.trim(),
      });
      hideStopButton();
      this.removeStreamHandlers();
      return false;
    }
  }

  async handleTextSend(
    text: string,
    images: PromptImageAttachment[] = [],
    source: ChatSource = "text",
    options: TextSendOptions = {},
  ): Promise<boolean> {
    const normalizedText =
      text.trim() || (images.length ? "Analyze the attached image(s)." : "");
    if (!normalizedText) return false;
    if (state.isProcessing || this.operationInProgress || this.currentRequestId) return false;
    // Manual callers acknowledge only after the asynchronous bridge dispatch
    // succeeds. Capture the provider watermark now so speech received during
    // model/settings/IPC awaits remains available for the next prompt. Auto
    // mode already acknowledges immediately before its audio-source dispatch.
    this.pendingRealtimeAcknowledgement = null;
    const realtimeAcknowledgement = source === "audio" || !text.trim()
      ? null
      : this.captureRealtimeAcknowledgement(
          text,
          options.submittedTranslationView,
        );
    logger.info("ui", "Handle text send", {
      textLength: normalizedText.length,
    });
    const opId = ++this.activeOpId;
    const chatId = getActiveChatId();
    this.operationInProgress = true;
    setProcessing(true);
    showStopButton();

    const requestId = `text-send-${crypto.randomUUID()}`;

    try {
      if (opId !== this.activeOpId) {
        return false;
      }
      setStatus("Sending to LLM...", "sending");
      const started = await this.sendChatRequest(
        requestId,
        normalizedText,
        source,
        chatId,
        opId,
        images,
      );
      if (started && source !== "audio") {
        this.pendingRealtimeAcknowledgement = {
          acknowledgement: realtimeAcknowledgement,
        };
      }
      return started;
    } catch (error) {
      if (opId !== this.activeOpId) {
        return false;
      }
      setStatus("Error", "error");
      const failedPending = this.pendingConversation;
      const hadPending = !!failedPending;
      this.failPendingConversation(this.toErrorMessage(error), this.streamAccumulator);
      if (!hadPending) {
        showError(error, chatId, { source });
      }
      setProcessing(false);
      this.operationInProgress = false;
      this.currentRequestId = null;
      this.notifyOperationSettled({
        requestId,
        status: "failed",
        chatId: failedPending?.chatId ?? chatId,
        userText: failedPending?.userText,
        userMessageId: failedPending?.userMessageId,
        assistantMessageId: failedPending?.assistantMessageId,
        partialText: this.streamAccumulator.trim(),
      });
      hideStopButton();
      this.removeStreamHandlers();
      return false;
    }
  }

  async stopActiveStream(
    options: StopActiveOperationOptions | StopDisposition = {},
  ): Promise<boolean> {
    return this.stopActiveOperation(options);
  }

  async retryFailedMessage(
    detail: { chatId?: string; messageId?: string; text?: string } | string,
  ): Promise<boolean> {
    const payload = typeof detail === "string" ? { text: detail } : detail;
    const normalized = payload.text?.trim() || "";
    if (
      !normalized ||
      !payload.chatId ||
      !payload.messageId ||
      state.isProcessing
    )
      return false;

    const opId = ++this.activeOpId;
    this.operationInProgress = true;
    setProcessing(true);
    setStatus("Checking model...", "processing");
    try {
      const llmReady = await this.ensureLlmReady(opId);
      if (opId !== this.activeOpId) return false;
      if (!llmReady) {
        setProcessing(false);
        this.operationInProgress = false;
        return false;
      }
      const retry = beginRetryChatMessage(payload.chatId, payload.messageId);
      if (!retry)
        throw new Error("The selected message can no longer be retried.");
      const requestId = `retry-${crypto.randomUUID()}`;
      this.pendingConversation = { ...retry, requestId };
      const provider = resolveLlmProvider(await this.loadSettingsSafe());
      if (opId !== this.activeOpId) return false;
      updateChatMessage(
        retry.assistantMessageId,
        {
          retryText: retry.userText,
          pending: true,
          source: retry.source,
          provider,
        },
        { chatId: retry.chatId },
      );
      const history = getConversationContext(retry.chatId);
      const lastHistoryMessage = history[history.length - 1];
      if (
        lastHistoryMessage?.role === "user" &&
        lastHistoryMessage.content.trim() === retry.userText
      ) {
        history.pop();
      }
      this.currentRequestId = requestId;
      this.prepareStreamHandlers(requestId);
      showStopButton();
      setStatus("Retrying...", "sending");
      await window.api.assistant.askChat({
        text: retry.userText,
        requestId,
        history,
      });
      return true;
    } catch (error) {
      if (opId !== this.activeOpId) return false;
      this.failPendingConversation(this.toErrorMessage(error), this.streamAccumulator);
      setStatus("Error", "error");
      setProcessing(false);
      this.operationInProgress = false;
      this.currentRequestId = null;
      hideStopButton();
      this.removeStreamHandlers();
      return false;
    }
  }

  async stopActiveOperation(
    options: StopActiveOperationOptions | StopDisposition = {},
  ): Promise<boolean> {
    const hasActive = this.operationInProgress || !!this.currentRequestId;
    if (!hasActive) {
      return false;
    }

    const disposition = typeof options === "string"
      ? options
      : options.disposition ?? "manual";
    const excludeFromHistory = typeof options === "string"
      ? false
      : options.excludeFromHistory === true;
    this.activeOpId++;
    const requestId = this.currentRequestId;
    const pending = this.pendingConversation;
    const partial = this.streamAccumulator.trim();
    logger.info("ui", "Stop operation requested", { requestId, disposition });

    // Detach first so an expected abort event cannot race the disposition-
    // specific chat update below and turn an automatic supersession into an
    // error card.
    this.currentRequestId = null;
    this.pendingConversation = null;
    this.removeStreamHandlers();
    if (requestId) {
      try {
        await window.api.assistant.stopStream({ requestId });
      } catch (error) {
        console.error("Stop stream error", error);
      }
    }

    if (pending) {
      const meaningfulPartial = this.isMeaningfulPartial(partial);
      if (disposition === "manual") {
        updateChatMessage(
          pending.userMessageId,
          { historyExcluded: true },
          { chatId: pending.chatId },
        );
        updateChatMessage(
          pending.assistantMessageId,
          {
            role: "error",
            text: partial
              ? `${partial}\n\n[Interrupted — retry to continue]`
              : "[Interrupted — retry to continue]",
            pending: false,
            interrupted: true,
            retryText: pending.userText,
            historyExcluded: true,
          },
          { chatId: pending.chatId },
        );
      } else if (!meaningfulPartial) {
        removeChatMessages(
          [pending.userMessageId, pending.assistantMessageId],
          { chatId: pending.chatId },
        );
      } else {
        const historyExcluded = disposition === "auto-continuation"
          || excludeFromHistory;
        updateChatMessage(
          pending.userMessageId,
          { historyExcluded },
          { chatId: pending.chatId },
        );
        updateChatMessage(
          pending.assistantMessageId,
          {
            role: "assistant",
            text: partial,
            pending: false,
            interrupted: false,
            retryText: undefined,
            historyExcluded,
          },
          { chatId: pending.chatId },
        );
      }
    }

    if (requestId) {
      this.notifyOperationSettled({
        requestId,
        status: "cancelled",
        disposition,
        chatId: pending?.chatId,
        userText: pending?.userText,
        userMessageId: pending?.userMessageId,
        assistantMessageId: pending?.assistantMessageId,
        partialText: partial,
      });
    }
    this.restoreRecordingAwareStatus();
    setProcessing(false);
    this.operationInProgress = false;
    hideStopButton();
    return true;
  }

  async handleHotkeyToggleRequest(): Promise<void> {
    await this.handleAudioInputToggle();
  }

  async handleAudioInputToggleRequest(): Promise<void> {
    await this.handleAudioInputToggle();
  }

  private async applyAudioInputSetting(type: AudioInputType): Promise<boolean> {
    if (type === getAudioInputType()) {
      await this.updateToggleButtonLabel(type);
      return true;
    }
    if (this.audioSwitchInProgress) {
      settingsStore.patch({ audioInputType: getAudioInputType() });
      return false;
    }

    this.audioSwitchInProgress = true;
    this.ui.setAudioInputPresentation?.(getAudioInputType(), true);
    try {
      const result = await this.switchAudioInput(type);
      return result.success;
    } catch (error) {
      logger.error("audio", "Settings audio input switch failed", {
        error: this.toErrorMessage(error),
      });
      return false;
    } finally {
      this.audioSwitchInProgress = false;
      this.ui.setAudioInputPresentation?.(getAudioInputType(), false);
    }
  }

  private async applyAudioDeviceSetting(deviceId: string): Promise<boolean> {
    const current = settingsStore.get().audioInputDeviceId || "";
    if (deviceId === current) return true;
    if (this.audioSwitchInProgress) return false;

    this.audioSwitchInProgress = true;
    this.ui.setAudioInputPresentation?.(getAudioInputType(), true);
    try {
      const result = await this.switchAudioInput(getAudioInputType(), deviceId);
      return result.success;
    } catch (error) {
      logger.error("audio", "Settings microphone switch failed", {
        error: this.toErrorMessage(error),
      });
      return false;
    } finally {
      this.audioSwitchInProgress = false;
      this.ui.setAudioInputPresentation?.(getAudioInputType(), false);
    }
  }

  private async prepareAudioBuffer(
    pcm: {
      channels: Float32Array[];
      sampleRate: number;
      durationSeconds: number;
    },
    seconds: number,
  ): Promise<{
    arrayBuffer: ArrayBuffer;
    maxAmplitude: number;
    rms: number;
    expectedFrames: number;
    dataMaxAmp: number;
  }> {
    let maxAmplitude = 0;
    let sumSquared = 0;
    let sampleCount = 0;
    for (const channel of pcm.channels) {
      for (let i = 0; i < channel.length; i++) {
        const amp = Math.abs(channel[i]);
        sumSquared += channel[i] * channel[i];
        sampleCount++;
        if (amp > maxAmplitude) {
          maxAmplitude = amp;
        }
      }
    }
    const rms = Math.sqrt(sumSquared / Math.max(1, sampleCount));

    if (maxAmplitude < 0.0001 && rms < 0.00005) {
      logger.warn("ui", "Audio appears to be silence", {
        maxAmplitude,
        rms,
        seconds,
        frames: pcm.channels[0].length,
      });
      throw new Error(
        "No audio signal detected (silence). Check microphone and speak louder.",
      );
    }

    if (maxAmplitude < 0.01) {
      logger.warn("ui", "Audio is very quiet, may cause transcription issues", {
        maxAmplitude,
        rms,
        seconds,
      });
    }

    const expectedFrames = pcm.channels[0]?.length || 0;
    for (let i = 1; i < pcm.channels.length; i++) {
      if (pcm.channels[i]?.length !== expectedFrames) {
        logger.error("ui", "Channel length mismatch", {
          channel0: pcm.channels[0]?.length,
          channelI: pcm.channels[i]?.length,
          channelIndex: i,
        });
      }
    }

    const wav = floatsToWav(pcm.channels, pcm.sampleRate);
    const arrayBuffer = await wav.arrayBuffer();

    if (arrayBuffer.byteLength < 1000) {
      logger.error("ui", "WAV file too small", {
        size: arrayBuffer.byteLength,
        seconds,
        frames: expectedFrames,
        sampleRate: pcm.sampleRate,
        channels: pcm.channels.length,
      });
      throw new Error("Audio buffer too small or empty");
    }

    const view = new DataView(arrayBuffer);
    const riff = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    );
    const wave = String.fromCharCode(
      view.getUint8(8),
      view.getUint8(9),
      view.getUint8(10),
      view.getUint8(11),
    );
    if (riff !== "RIFF" || wave !== "WAVE") {
      logger.error("ui", "Invalid WAV header", { riff, wave });
      throw new Error("Invalid audio format");
    }

    let dataMaxAmp = 0;
    if (arrayBuffer.byteLength > 44) {
      const dataView = new DataView(arrayBuffer, 44);
      const sampleCount = (arrayBuffer.byteLength - 44) / 2;
      for (let i = 0; i < Math.min(sampleCount, 1000); i++) {
        const sample = dataView.getInt16(i * 2, true);
        const amp = Math.abs(sample / 32767.0);
        if (amp > dataMaxAmp) dataMaxAmp = amp;
      }
    }

    return { arrayBuffer, maxAmplitude, rms, expectedFrames, dataMaxAmp };
  }

  private async sendChatRequest(
    requestId: string,
    text: string,
    source: ChatSource,
    chatId: string,
    opId?: number,
    images: PromptImageAttachment[] = [],
  ): Promise<boolean> {
    if (typeof opId === "number" && opId !== this.activeOpId) {
      return false;
    }
    const llmReady = await this.ensureLlmReady(opId);
    if (typeof opId === "number" && opId !== this.activeOpId) {
      return false;
    }
    if (!llmReady) {
      if (this.currentRequestId === requestId) this.currentRequestId = null;
      setProcessing(false);
      this.operationInProgress = false;
      hideStopButton();
      return false;
    }
    if (typeof opId === "number" && opId !== this.activeOpId) {
      return false;
    }
    const currentSettings = await this.loadSettingsSafe();
    if (typeof opId === "number" && opId !== this.activeOpId) {
      return false;
    }
    const provider = resolveLlmProvider(currentSettings);
    const history = getConversationContext(chatId);
    const attachmentLabel = images.length
      ? `[${images.length} image${images.length === 1 ? "" : "s"} attached; pixels are not stored in chat history]`
      : "";
    const displayText = attachmentLabel ? `${attachmentLabel}\n${text}` : text;
    this.pendingConversation = this.createPendingConversation(
      chatId,
      requestId,
      text,
      images.length ? "screenshot" : source,
      provider,
      displayText,
    );
    this.currentRequestId = requestId;
    this.prepareStreamHandlers(requestId);
    showStopButton();
    await window.api.assistant.askChat({ text, requestId, history, images });
    // A stop can win while a slower bridge is dispatching the request. Report
    // that as not started so the caller does not clear the user's prompt. Do
    // not key this check off currentRequestId: an exceptionally fast provider
    // may already have completed successfully without invalidating the op id.
    if (typeof opId === "number" && opId !== this.activeOpId) {
      return false;
    }
    return true;
  }

  private prepareStreamHandlers(requestId: string): void {
    this.removeStreamHandlers();
    this.streamAccumulator = "";

    this.streamDeltaHandler = (
      _e: unknown,
      payload: { requestId?: string; delta: string },
    ) => {
      if (
        !payload ||
        (payload.requestId && payload.requestId !== requestId) ||
        this.currentRequestId !== requestId
      )
        return;
      this.streamAccumulator += payload.delta || "";
      if (this.pendingConversation?.requestId === requestId) {
        const pending = this.pendingConversation;
        updateChatMessage(
          this.pendingConversation.assistantMessageId,
          {
            text: this.streamAccumulator,
            pending: true,
          },
          { chatId: pending.chatId },
        );
      }
      setStatus("Responding...", "processing");
      showStopButton();
    };

    this.streamDoneHandler = (
      _e: unknown,
      payload: { requestId?: string; full: string },
    ) => {
      if (
        !payload ||
        (payload.requestId && payload.requestId !== requestId) ||
        this.currentRequestId !== requestId
      )
        return;
      logger.info("stream", "Stream done handler called", {
        requestId: payload.requestId,
      });
      const full = (payload.full || this.streamAccumulator || "").trim();
      const pending =
        this.pendingConversation?.requestId === requestId
          ? this.pendingConversation
          : null;
      if (!full) {
        if (pending) {
          this.failPendingConversation("The model returned an empty response.");
        }
        this.currentRequestId = null;
        this.notifyOperationSettled({
          requestId,
          status: "failed",
          chatId: pending?.chatId,
          userText: pending?.userText,
          userMessageId: pending?.userMessageId,
          assistantMessageId: pending?.assistantMessageId,
          partialText: "",
        });
        setStatus("Error", "error");
        setProcessing(false);
        this.operationInProgress = false;
        hideStopButton();
        this.removeStreamHandlers();
        return;
      }
      if (pending) {
        updateChatMessage(
          pending.userMessageId,
          { historyExcluded: false },
          { chatId: pending.chatId },
        );
        updateChatMessage(
          pending.assistantMessageId,
          {
            text: full,
            pending: false,
            retryText: undefined,
            interrupted: false,
            historyExcluded: false,
          },
          { chatId: pending.chatId },
        );
        this.pendingConversation = null;
      }
      this.currentRequestId = null;
      this.notifyOperationSettled({
        requestId,
        status: "completed",
        chatId: pending?.chatId,
        userText: pending?.userText,
        userMessageId: pending?.userMessageId,
        assistantMessageId: pending?.assistantMessageId,
        partialText: full,
      });
      this.restoreRecordingAwareStatus("Done");
      setProcessing(false);
      this.operationInProgress = false;
      hideStopButton();
      this.removeStreamHandlers();
    };

    this.streamErrorHandler = (
      _e: unknown,
      payload: { requestId?: string; error: string },
    ) => {
      if (
        !payload ||
        (payload.requestId && payload.requestId !== requestId) ||
        this.currentRequestId !== requestId
      )
        return;
      logger.info("stream", "Stream error handler called", {
        requestId: payload.requestId,
        error: payload.error,
      });
      this.currentRequestId = null;
      const pending =
        this.pendingConversation?.requestId === requestId
          ? this.pendingConversation
          : null;
      if (pending) {
        // Intentional stops detach these handlers before aborting the native
        // request. Any error that still reaches this listener is therefore a
        // real failure, even if an upstream provider happens to use the word
        // "aborted" in its diagnostic text.
        this.failPendingConversation(payload.error, this.streamAccumulator.trim());
      }

      setStatus("Error", "error");
      this.notifyOperationSettled({
        requestId,
        status: "failed",
        chatId: pending?.chatId,
        userText: pending?.userText,
        userMessageId: pending?.userMessageId,
        assistantMessageId: pending?.assistantMessageId,
        partialText: this.streamAccumulator.trim(),
      });
      setProcessing(false);
      this.operationInProgress = false;
      hideStopButton();
      this.removeStreamHandlers();
    };

    window.api.assistant.onStreamDelta(this.streamDeltaHandler);
    window.api.assistant.onStreamDone(this.streamDoneHandler);
    window.api.assistant.onStreamError(this.streamErrorHandler);
  }

  private createPendingConversation(
    chatId: string,
    requestId: string,
    userText: string,
    source: ChatSource,
    provider: ChatProvider,
    displayText = userText,
  ): PendingConversation {
    const userMessageId = appendChatMessage("user", displayText, {
      chatId,
      source,
      provider,
    });
    const assistantMessageId = appendChatMessage("assistant", "Syncing...", {
      pending: true,
      chatId,
      retryText: userText,
      source,
      provider,
    });
    return {
      chatId,
      requestId,
      userText,
      userMessageId,
      assistantMessageId,
    };
  }

  private failPendingConversation(errorMessage: string, partialText = ""): void {
    if (!this.pendingConversation) return;
    const pending = this.pendingConversation;
    const partial = partialText.trim();
    updateChatMessage(
      pending.userMessageId,
      { historyExcluded: true },
      { chatId: pending.chatId },
    );
    updateChatMessage(
      pending.assistantMessageId,
      {
        role: "error",
        text: partial ? `${partial}\n\n[Request failed: ${errorMessage}]` : errorMessage,
        pending: false,
        interrupted: false,
        retryText: pending.userText,
        historyExcluded: true,
      },
      { chatId: pending.chatId },
    );
    this.pendingConversation = null;
  }

  private async ensureLlmReady(opId?: number): Promise<boolean> {
    const isCurrent = () => typeof opId !== "number" || opId === this.activeOpId;
    const settings = await this.loadSettingsSafe();
    if (!isCurrent()) return false;

    if (settings.llmHost !== "local") {
      return true;
    }

    const model = normalizeOllamaModelName(
      settings.localLlmModel ||
        settings.llmModel ||
        LOCAL_LLM_MODELS[0] ||
        "gpt-oss:20b",
    );

    try {
      const installed = await checkOllamaInstalled();
      if (!isCurrent()) return false;
      if (!installed) {
        setStatus("Install Ollama to use local LLMs", "error");
        return false;
      }
    } catch (error) {
      if (!isCurrent()) return false;
      logger.error("llm", "Failed to detect Ollama", { error });
      setStatus("Failed to detect Ollama installation", "error");
      return false;
    }

    try {
      const downloaded = await checkOllamaModelDownloaded(model, {
        force: true,
      });
      if (!isCurrent()) return false;
      if (!downloaded) {
        setStatus(`Download the ${model} LLM model first`, "error");
        return false;
      }
      if (isOllamaModelDownloading(model)) {
        setStatus(`The ${model} model is downloading`, "error");
        return false;
      }
      if (isOllamaModelWarming(model)) {
        setStatus(`The ${model} model is warming up`, "error");
        return false;
      }
    } catch (error) {
      if (!isCurrent()) return false;
      logger.error("llm", "Failed to verify Ollama model", { error });
      setStatus("Failed to verify local LLM model", "error");
      return false;
    }

    return true;
  }

  private removeStreamHandlers(): void {
    try {
      window.api.assistant.offStreamDelta();
      window.api.assistant.offStreamDone();
      window.api.assistant.offStreamError();
    } catch {}
    this.streamDeltaHandler = null;
    this.streamDoneHandler = null;
    this.streamErrorHandler = null;
    this.streamAccumulator = "";
  }

  private async handleAudioInputToggle(): Promise<void> {
    if (this.audioSwitchInProgress) return;
    this.audioSwitchInProgress = true;
    this.ui.setAudioInputPresentation?.(getAudioInputType(), true);
    try {
      const currentType = getAudioInputType();
      const nextType: "microphone" | "system" | "mixed" =
        currentType === "microphone"
          ? "system"
          : currentType === "system"
            ? "mixed"
            : "microphone";

      const result = await this.switchAudioInput(nextType);
      settingsStore.patch({ audioInputType: result.activeType });
    } catch (error) {
      console.error("Toggle input failed", error);
    } finally {
      this.audioSwitchInProgress = false;
      this.ui.setAudioInputPresentation?.(getAudioInputType(), false);
    }
  }

  private async stopRealtimeServices(): Promise<void> {
    await Promise.allSettled([
      this.googleStreamingService.stop(),
      this.openAiStreamingService.stop(),
    ]);
  }

  private async syncRealtimeTranscription(): Promise<void> {
    return this.realtimeTransitions.run(async (isCurrent) => {
      if (!isCurrent()) return;
      const settings = await this.loadSettingsSafe();
      if (!isCurrent()) return;
      const target = !this.disposed && state.isRecording
        ? getRealtimeTranscriptionTarget(
            settings.transcriptionMode,
            settings.transcriptionModel,
          )
        : null;
      this.desiredRealtimeTarget = target;
      if (!target) {
        this.clearRealtimeRetry();
        this.realtimeTerminalError = null;
        await this.stopRealtimeServices();
        if (!isCurrent()) return;
        this.activeRealtimeTarget = null;
        this.lastRealtimeTranscript = "";
        this.lastRealtimeSource = "";
        this.lastRealtimeTranslation = "";
        this.submittedRealtimeFragment = "";
        this.pendingRealtimeAcknowledgement = null;
        this.realtimeRevision += 1;
        return;
      }
      if (this.activeRealtimeTarget === target) return;
      this.realtimeTerminalError = null;

      // Stop only the provider we are leaving. The target service's start()
      // performs its own restart while preserving audio accumulated during a
      // token/WebSocket backoff, so the first words after an outage are not
      // discarded.
      if (target.startsWith("openai")) {
        await this.googleStreamingService.stop();
      } else {
        await this.openAiStreamingService.stop();
      }
      if (!isCurrent()) return;
      this.activeRealtimeTarget = null;
      this.lastRealtimeTranscript = "";
      this.lastRealtimeSource = "";
      this.lastRealtimeTranslation = "";
      this.submittedRealtimeFragment = "";
      this.pendingRealtimeAcknowledgement = null;
      this.realtimeRevision += 1;
      try {
        if (target.startsWith("openai")) {
          await this.openAiStreamingService.start({
            prompt: target === "openai-transcribe" ? settings.transcriptionPrompt : undefined,
            targetLanguage: target === "openai-translate"
              ? settings.realtimeTranslationLanguage || "en"
              : undefined,
          });
        } else {
          await this.googleStreamingService.start(null, { streamMode: "base" });
        }
        if (!isCurrent()) return;
        this.activeRealtimeTarget = target;
        this.clearRealtimeRetry();
        this.realtimeTerminalError = null;
        setStatus(
          target === "openai-translate"
            ? "Recording · OpenAI Translate"
            : target === "openai-transcribe"
              ? "Recording · OpenAI Live"
              : "Recording · Google Live",
          "recording",
        );
      } catch (error) {
        this.activeRealtimeTarget = null;
        // The target service deliberately remains subscribed to native audio
        // during the bounded reconnect backoff. Stop only the other provider;
        // the next target start() replaces its failed transport while keeping
        // the buffered speech.
        if (target.startsWith("openai")) {
          await this.googleStreamingService.stop();
        } else {
          await this.openAiStreamingService.stop();
        }
        if (!isCurrent()) return;
        const errorMessage = this.toErrorMessage(error);
        logger.warn(`${target}-live`, "Realtime transcription unavailable", {
          error: errorMessage,
        });
        // Initial token/WebSocket/setup failures need the same bounded
        // reconnect path as failures from an established session.
        this.onStreamingError(target, errorMessage);
      }
    });
  }

  private async switchAudioInput(
    newType: AudioInputType,
    newDeviceId?: string,
  ): Promise<SwitchAudioResult> {
    logger.info("audio", "Switch input requested", { newType, newDeviceId });

    const result = await switchAudioInputDevice(newType, newDeviceId);
    setAudioInputType(result.activeType);
    settingsStore.patch({
      audioInputType: result.activeType,
      audioInputDeviceId: result.activeDeviceId,
    });
    try {
      await this.updateToggleButtonLabel(result.activeType);
    } catch {}
    if (!result.success) return result;

    this.ui.onAudioInputChanged?.();

    if (state.isRecording) {
      // Realtime services subscribe to the shared native audio bus, so the
      // existing session automatically receives the new
      // source. Keeping it open avoids dropping audio during a reconnect.
      this.restoreRecordingAwareStatus();
    }

    return result;
  }

  private async updateToggleButtonLabel(
    preferred?: AudioInputType,
  ): Promise<void> {
    let type: AudioInputType | undefined = preferred;
    if (!type) {
      const settings = await this.loadSettingsSafe();
      type = (settings.audioInputType || "microphone") as AudioInputType;
    }
    if (!type) type = getAudioInputType();

    setAudioInputType(type);
    this.ui.setAudioInputPresentation?.(type, this.audioSwitchInProgress);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRealtimeRetry();
    this.activeOpId += 1;
    await this.stopActiveOperation().catch(() => false);
    await this.syncRealtimeTranscription().catch(() => undefined);
    this.activeRealtimeTarget = null;
    this.desiredRealtimeTarget = null;
    this.removeStreamHandlers();
  }
}

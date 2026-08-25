import {beforeEach, describe, expect, it, vi} from "vitest";

const mocks = vi.hoisted(() => ({
  state: {isProcessing: false, isRecording: false},
  capture: vi.fn(),
  cancel: vi.fn(),
  releaseActivity: vi.fn(),
  beginActivity: vi.fn(),
  addPromptImages: vi.fn(),
  stopActiveOperation: vi.fn().mockResolvedValue(false),
  setStatus: vi.fn(),
}));

vi.mock("../src/renderer/state/appState", () => ({
  state: mocks.state,
  setDuration: vi.fn(),
  setProcessing: (value: boolean) => {
    mocks.state.isProcessing = value;
  },
  setRecording: (value: boolean) => {
    mocks.state.isRecording = value;
  },
}));

vi.mock("../src/renderer/app/streamController", () => ({
  StreamController: class {
    stopActiveOperation = mocks.stopActiveOperation;
    handleRecordToggle = vi.fn().mockResolvedValue(undefined);

    constructor(_options: unknown) {}
  },
}));

vi.mock("../src/renderer/ui/featureAccessModal", () => ({
  checkFeatureAccess: () => true,
  showFeatureAccessModal: vi.fn(),
}));

vi.mock("../src/renderer/state/rendererActivity", () => ({
  beginNativeRendererActivity: mocks.beginActivity,
}));

vi.mock("../src/renderer/ui/status", () => ({
  getStatusSnapshot: () => ({text: "Ready", type: "ready"}),
  setStatus: mocks.setStatus,
}));

vi.mock("../src/renderer/ui/stopButton", () => ({
  hideStopButton: vi.fn(),
}));

vi.mock("../src/renderer/ui/outputs", () => ({
  CHAT_RETRY_EVENT_NAME: "xexamai:test-retry",
  removeChatMessages: vi.fn(),
  updateChatMessage: vi.fn(),
}));

const createUi = () => ({
  updateRealtimeTranscript: vi.fn(),
  updateRealtimeTranslation: vi.fn(),
  applyRealtimeAcknowledgement: vi.fn(),
  restoreQuestionIfEmpty: vi.fn(),
  getQuestion: () => "",
  getPromptImages: () => [],
  getAutoPromptSnapshot: () => ({
    text: "",
    visibleText: "",
    images: [],
    realtimeTranslation: false,
  }),
  restoreAutoPrompt: vi.fn(),
  restoreAutoPromptImages: vi.fn(),
  clearAutoSubmittedPrompt: vi.fn(),
  addPromptImages: mocks.addPromptImages,
  clearSubmittedPrompt: vi.fn(),
  setAudioInputPresentation: vi.fn(),
  setSettingsSnapshot: vi.fn(),
  setAutoModeEnabled: vi.fn(),
  setReady: vi.fn(),
});

type ShutdownCapableSession = {
  captureScreenshot: () => Promise<void>;
  shutdownActiveWork: (requireIdle?: boolean) => Promise<void>;
};

beforeEach(() => {
  mocks.state.isProcessing = false;
  mocks.state.isRecording = false;
  mocks.capture.mockReset();
  mocks.cancel.mockReset();
  mocks.releaseActivity.mockReset().mockResolvedValue(undefined);
  mocks.beginActivity.mockReset().mockResolvedValue(mocks.releaseActivity);
  mocks.addPromptImages.mockReset();
  mocks.stopActiveOperation.mockReset().mockResolvedValue(false);
  mocks.setStatus.mockReset();
  vi.stubGlobal("window", {
    api: {
      screen: {capture: mocks.capture, cancel: mocks.cancel},
      google: {stopLive: vi.fn().mockResolvedValue(undefined)},
      openai: {stopLive: vi.fn().mockResolvedValue(undefined)},
    },
    setTimeout,
    clearTimeout,
  });
});

describe("RendererSession screenshot shutdown", () => {
  it("cancels and joins an active native screenshot before reporting idle", async () => {
    let resolveCapture!: (value: null) => void;
    mocks.capture.mockReturnValue(new Promise<null>((resolve) => {
      resolveCapture = resolve;
    }));
    mocks.cancel.mockImplementation(async () => resolveCapture(null));

    const {RendererSession} = await import("../src/renderer/renderer");
    const session = new RendererSession(createUi()) as unknown as ShutdownCapableSession;
    const capturing = session.captureScreenshot();
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());

    await session.shutdownActiveWork(true);
    await capturing;

    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.releaseActivity).toHaveBeenCalledOnce();
    expect(mocks.addPromptImages).not.toHaveBeenCalled();
    expect(mocks.state.isProcessing).toBe(false);
  });

  it("invalidates a capture waiting for its activity lease before native startup", async () => {
    let resolveActivity!: (release: () => Promise<void>) => void;
    mocks.beginActivity.mockReturnValue(new Promise((resolve) => {
      resolveActivity = resolve;
    }));
    mocks.cancel.mockResolvedValue(undefined);

    const {RendererSession} = await import("../src/renderer/renderer");
    const session = new RendererSession(createUi()) as unknown as ShutdownCapableSession;
    const capturing = session.captureScreenshot();
    await vi.waitFor(() => expect(mocks.beginActivity).toHaveBeenCalledOnce());

    const shutdown = session.shutdownActiveWork(true);
    resolveActivity(mocks.releaseActivity);
    await shutdown;
    await capturing;

    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.releaseActivity).toHaveBeenCalledOnce();
    expect(mocks.state.isProcessing).toBe(false);
  });

  it("does not surface an error from a capture invalidated by shutdown", async () => {
    let rejectCapture!: (error: Error) => void;
    mocks.capture.mockReturnValue(new Promise<null>((_resolve, reject) => {
      rejectCapture = reject;
    }));
    mocks.cancel.mockImplementation(async () => {
      rejectCapture(new Error("native capture aborted"));
    });

    const {RendererSession} = await import("../src/renderer/renderer");
    const session = new RendererSession(createUi()) as unknown as ShutdownCapableSession;
    const capturing = session.captureScreenshot();
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());

    await session.shutdownActiveWork(true);
    await capturing;

    expect(mocks.setStatus).not.toHaveBeenCalledWith("native capture aborted", "error");
    expect(mocks.releaseActivity).toHaveBeenCalledOnce();
    expect(mocks.state.isProcessing).toBe(false);
  });
});

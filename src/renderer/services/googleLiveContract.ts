import { GOOGLE_LIVE_TRANSCRIBE_MODEL } from "@shared/constants";

export const GOOGLE_LIVE_MODEL = GOOGLE_LIVE_TRANSCRIBE_MODEL;

export const isGoogleRealtimeTranscription = (
  mode: string | undefined,
  model: string | undefined,
): boolean => mode !== "local" && model === GOOGLE_LIVE_MODEL;

// Ephemeral tokens are supported only by the constrained v1beta Live endpoint.
export const GOOGLE_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

/** Decode the JSON frames returned by Gemini Live in browser WebSockets.
 * Chromium exposes Google's binary text frames as Blob by default, while
 * WebView2 may return either Blob or ArrayBuffer depending on binaryType.
 */
export const decodeGoogleLiveMessage = async (
  data: unknown,
): Promise<Record<string, any>> => {
  let json: string;
  if (typeof data === "string") {
    json = data;
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    json = await data.text();
  } else if (data instanceof ArrayBuffer) {
    json = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    json = new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  } else {
    throw new Error("Unsupported Google Live WebSocket frame type.");
  }

  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google Live returned a non-object message.");
  }
  return parsed as Record<string, any>;
};

export const getGoogleLiveServerError = (
  message: Record<string, any>,
): string | null => {
  const error = message.error;
  const raw =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && typeof error.message === "string"
        ? error.message
        : null;
  if (!raw) return null;
  const normalized = raw.split(/\s+/).filter(Boolean).join(" ");
  return normalized ? normalized.slice(0, 320) : null;
};

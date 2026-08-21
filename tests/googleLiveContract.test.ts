import { describe, expect, it } from "vitest";
import {
  decodeGoogleLiveMessage,
  getGoogleLiveServerError,
  GOOGLE_LIVE_ENDPOINT,
  GOOGLE_LIVE_MODEL,
  isGoogleRealtimeTranscription,
} from "../src/renderer/services/googleLiveContract";

describe("Google Live ephemeral-token contract", () => {
  it("uses the constrained v1beta endpoint required by ephemeral tokens", () => {
    expect(GOOGLE_LIVE_ENDPOINT).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
    );
    expect(GOOGLE_LIVE_MODEL).toBe("gemini-3.1-flash-live-preview");
  });

  it("enables realtime only for the explicit Live model", () => {
    expect(isGoogleRealtimeTranscription("api", GOOGLE_LIVE_MODEL)).toBe(true);
    expect(isGoogleRealtimeTranscription("api", "gemini-3.7-flash")).toBe(
      false,
    );
    expect(isGoogleRealtimeTranscription("local", GOOGLE_LIVE_MODEL)).toBe(
      false,
    );
  });

  it("decodes text, Blob, and ArrayBuffer server frames", async () => {
    const payload = JSON.stringify({ setupComplete: {} });
    await expect(decodeGoogleLiveMessage(payload)).resolves.toEqual({
      setupComplete: {},
    });
    await expect(decodeGoogleLiveMessage(new Blob([payload]))).resolves.toEqual(
      { setupComplete: {} },
    );
    const bytes = new TextEncoder().encode(payload);
    await expect(decodeGoogleLiveMessage(bytes.buffer)).resolves.toEqual({
      setupComplete: {},
    });
    await expect(decodeGoogleLiveMessage(bytes.subarray(0))).resolves.toEqual({
      setupComplete: {},
    });
  });

  it("fails clearly for malformed or unsupported server frames", async () => {
    await expect(
      decodeGoogleLiveMessage(new Blob(["not-json"])),
    ).rejects.toThrow();
    await expect(decodeGoogleLiveMessage(42)).rejects.toThrow("Unsupported");
  });

  it("extracts a bounded vendor error without exposing arbitrary payload fields", () => {
    expect(
      getGoogleLiveServerError({ error: { message: "  Invalid   setup  " } }),
    ).toBe("Invalid setup");
    expect(getGoogleLiveServerError({ error: "Unavailable" })).toBe(
      "Unavailable",
    );
    expect(getGoogleLiveServerError({ serverContent: {} })).toBeNull();
  });
});

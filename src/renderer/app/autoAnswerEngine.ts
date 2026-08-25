export type AutoAnswerMode = 'realtime' | 'buffered';

export type AutoAnswerToken = Readonly<{
    epoch: number;
    cycle: number;
}>;

export type AutoAnswerAudioFrame = Readonly<{
    /** Linear PCM RMS in the 0..1 range. */
    rms: number;
    /** Duration represented by this frame. */
    durationMs: number;
    /** Monotonic timestamp at the end of this frame. */
    now: number;
}>;

export type AutoAnswerTranscriptChange = Readonly<{
    text: string;
    /** Monotonic timestamp at which this revision became visible. */
    now: number;
}>;

export type AutoAnswerSpeechStartEvent = Readonly<{
    type: 'speech-start';
    token: AutoAnswerToken;
    at: number;
    speechStartedAt: number;
    continuation: boolean;
    resumedFromCycle?: number;
}>;

export type AutoAnswerEndpointEvent = Readonly<{
    type: 'endpoint';
    token: AutoAnswerToken;
    at: number;
    mode: AutoAnswerMode;
    continuation: boolean;
    resumedFromCycle?: number;
    transcript: string;
    /** Tail duration to request from the rolling PCM buffer, including pre-roll and endpoint silence. */
    captureDurationMs: number;
    preRollMs: number;
    voicedDurationMs: number;
    silenceDurationMs: number;
}>;

export type AutoAnswerEvent = AutoAnswerSpeechStartEvent | AutoAnswerEndpointEvent;

export type AutoAnswerEngineOptions = Readonly<{
    mode: AutoAnswerMode;
    /** One-time ambient calibration after construction. Set to zero when an external floor is known. */
    calibrationMs?: number;
    /** Sustained energy required before speech is confirmed. */
    speechAttackMs?: number;
    /** Minimum accumulated voiced energy required to produce an endpoint. */
    minimumVoicedMs?: number;
    /** Acoustic quiet period before an utterance may be submitted. */
    endpointSilenceMs?: number;
    /** Realtime text must remain unchanged for this long before submission. */
    transcriptStableMs?: number;
    /** A realtime utterance with no transcript is discarded after this quiet period. */
    transcriptWaitTimeoutMs?: number;
    /** A new confirmed utterance inside this window is classified as a continuation. */
    continuationWindowMs?: number;
    /** Audio retained before the first confirmed speech energy. */
    preRollMs?: number;
    /** Hard cap for a buffered capture request. Always clamped to 60 seconds. */
    maxCaptureMs?: number;
    initialNoiseFloorDb?: number;
    speechMarginDb?: number;
    releaseMarginDb?: number;
}>;

export type AutoAnswerEngineSnapshot = Readonly<{
    mode: AutoAnswerMode;
    token: AutoAnswerToken;
    phase: 'calibrating' | 'idle' | 'attacking' | 'speaking';
    noiseFloorDb: number;
    speechThresholdDb: number;
    releaseThresholdDb: number;
    transcript: string;
    transcriptRevision: number;
    voicedDurationMs: number;
    silenceDurationMs: number;
}>;

type NormalizedOptions = {
    calibrationMs: number;
    speechAttackMs: number;
    minimumVoicedMs: number;
    endpointSilenceMs: number;
    transcriptStableMs: number;
    transcriptWaitTimeoutMs: number;
    continuationWindowMs: number;
    preRollMs: number;
    maxCaptureMs: number;
    initialNoiseFloorDb: number;
    speechMarginDb: number;
    releaseMarginDb: number;
};

type LastEndpoint = {
    at: number;
    cycle: number;
    captureAnchorAt: number;
};

const HARD_MAX_CAPTURE_MS = 60_000;

/**
 * Monotonic media clock for Auto endpointing.
 *
 * Native capture already emits silent PCM frames. Advancing this clock from
 * wall-clock ticks as well would count delayed/batched frames twice and could
 * manufacture a silence endpoint before those frames are delivered.
 */
export class AutoAnswerTimeline {
    private timestamp = 0;

    reset(anchor: number): number {
        this.timestamp = Number.isFinite(anchor) ? Math.max(0, anchor) : this.timestamp;
        return this.timestamp;
    }

    advanceAudio(durationMs: number): number {
        if (Number.isFinite(durationMs) && durationMs > 0) {
            this.timestamp += durationMs;
        }
        return this.timestamp;
    }

    current(): number {
        return this.timestamp;
    }
}

const DEFAULTS: NormalizedOptions = {
    calibrationMs: 300,
    speechAttackMs: 180,
    minimumVoicedMs: 320,
    endpointSilenceMs: 1_500,
    transcriptStableMs: 650,
    transcriptWaitTimeoutMs: 4_000,
    continuationWindowMs: 3_000,
    preRollMs: 350,
    maxCaptureMs: HARD_MAX_CAPTURE_MS,
    initialNoiseFloorDb: -60,
    speechMarginDb: 10,
    releaseMarginDb: 6,
};

/**
 * Pure state machine used by automatic answer mode.
 *
 * It deliberately combines acoustic activity with transcript stability. RMS
 * decides when speech starts and stops; provider text decides when a realtime
 * utterance is safe to submit. No timers or audio APIs are owned by the class,
 * so callers can drive it from native PCM packets and a monotonic clock.
 */
export class AutoAnswerEngine {
    private mode: AutoAnswerMode;
    private readonly options: NormalizedOptions;
    private epoch = 1;
    private cycle = 0;
    private lastNow = 0;

    private calibrationRemainingMs: number;
    private noiseFloorDb: number;
    private attackDurationMs = 0;
    private attackStartedAt = 0;

    private speaking = false;
    private speechStartedAt = 0;
    private lastVoiceAt = 0;
    private voicedDurationMs = 0;
    private captureAnchorAt = 0;
    private continuation = false;
    private resumedFromCycle: number | undefined;
    private cycleTranscriptRevision = 0;

    private transcript = '';
    private normalizedTranscript = '';
    private transcriptRevision = 0;
    private lastTranscriptChangeAt = Number.NEGATIVE_INFINITY;
    private lastEndpoint: LastEndpoint | null = null;

    constructor(options: AutoAnswerEngineOptions) {
        this.mode = options.mode;
        this.options = normalizeOptions(options);
        this.calibrationRemainingMs = this.options.calibrationMs;
        this.noiseFloorDb = this.options.initialNoiseFloorDb;
    }

    ingestAudio(frame: AutoAnswerAudioFrame): AutoAnswerEvent[] {
        const durationMs = finiteRange(frame.durationMs, 0, 2_000, 0);
        const now = this.advanceNow(frame.now);
        const events: AutoAnswerEvent[] = [];
        if (durationMs <= 0) {
            this.maybeFinish(now, events);
            return events;
        }

        // If a source emits no explicit silent packets, account for the gap
        // before treating this packet as the beginning of a new utterance.
        this.maybeFinish(Math.max(this.lastNowBeforeAdvance, now - durationMs), events);

        const levelDb = rmsToDb(frame.rms);
        if (this.calibrationRemainingMs > 0 && !this.speaking) {
            this.observeNoise(levelDb, durationMs, true);
            this.calibrationRemainingMs = Math.max(0, this.calibrationRemainingMs - durationMs);
            this.resetAttack();
            return events;
        }

        if (this.speaking) {
            if (levelDb >= this.releaseThresholdDb()) {
                this.voicedDurationMs += durationMs;
                this.lastVoiceAt = now;
            } else {
                this.maybeFinish(now, events);
            }
            return events;
        }

        if (levelDb >= this.speechThresholdDb()) {
            if (this.attackDurationMs === 0) {
                this.attackStartedAt = now - durationMs;
            }
            this.attackDurationMs += durationMs;
            if (this.attackDurationMs >= this.options.speechAttackMs) {
                events.push(this.confirmSpeech(now));
            }
        } else {
            this.observeNoise(levelDb, durationMs, false);
            this.resetAttack();
        }
        return events;
    }

    updateTranscript(change: AutoAnswerTranscriptChange): AutoAnswerEvent[] {
        const now = this.advanceNow(change.now);
        const text = typeof change.text === 'string' ? change.text.trim() : '';
        const normalized = normalizeTranscript(text);
        if (normalized !== this.normalizedTranscript) {
            this.transcript = text;
            this.normalizedTranscript = normalized;
            this.transcriptRevision += 1;
            this.lastTranscriptChangeAt = now;
        }
        const events: AutoAnswerEvent[] = [];
        this.maybeFinish(now, events);
        return events;
    }

    tick(now: number): AutoAnswerEvent[] {
        const timestamp = this.advanceNow(now);
        const events: AutoAnswerEvent[] = [];
        this.maybeFinish(timestamp, events);
        return events;
    }

    setMode(mode: AutoAnswerMode, now = this.lastNow): AutoAnswerToken {
        if (mode === this.mode) return this.currentToken();
        this.mode = mode;
        return this.invalidate(now);
    }

    /** Invalidates every outstanding event/request while retaining the learned noise floor. */
    invalidate(now = this.lastNow): AutoAnswerToken {
        this.advanceNow(now);
        this.epoch += 1;
        this.cycle = 0;
        this.transcript = '';
        this.normalizedTranscript = '';
        this.transcriptRevision = 0;
        this.lastTranscriptChangeAt = Number.NEGATIVE_INFINITY;
        this.lastEndpoint = null;
        this.resetUtterance();
        return this.currentToken();
    }

    /**
     * Invalidates outstanding work and starts a fresh ambient-noise calibration.
     * Use this when the active audio source or its gain changes materially.
     */
    recalibrate(now = this.lastNow): AutoAnswerToken {
        const token = this.invalidate(now);
        this.noiseFloorDb = this.options.initialNoiseFloorDb;
        this.calibrationRemainingMs = this.options.calibrationMs;
        return token;
    }

    currentToken(): AutoAnswerToken {
        return {epoch: this.epoch, cycle: this.cycle};
    }

    isCurrent(token: AutoAnswerToken): boolean {
        return token.epoch === this.epoch && token.cycle === this.cycle;
    }

    /** Marks a completed request as final so nearby future speech starts a new turn. */
    finalize(token: AutoAnswerToken): boolean {
        if (!this.isCurrent(token) || this.lastEndpoint?.cycle !== token.cycle) return false;
        this.lastEndpoint = null;
        return true;
    }

    snapshot(): AutoAnswerEngineSnapshot {
        return {
            mode: this.mode,
            token: this.currentToken(),
            phase: this.calibrationRemainingMs > 0
                ? 'calibrating'
                : this.speaking
                    ? 'speaking'
                    : this.attackDurationMs > 0
                        ? 'attacking'
                        : 'idle',
            noiseFloorDb: this.noiseFloorDb,
            speechThresholdDb: this.speechThresholdDb(),
            releaseThresholdDb: this.releaseThresholdDb(),
            transcript: this.transcript,
            transcriptRevision: this.transcriptRevision,
            voicedDurationMs: this.voicedDurationMs,
            silenceDurationMs: this.speaking ? Math.max(0, this.lastNow - this.lastVoiceAt) : 0,
        };
    }

    private lastNowBeforeAdvance = 0;

    private advanceNow(now: number): number {
        this.lastNowBeforeAdvance = this.lastNow;
        const candidate = Number.isFinite(now) ? now : this.lastNow;
        this.lastNow = Math.max(this.lastNow, candidate);
        return this.lastNow;
    }

    private confirmSpeech(now: number): AutoAnswerSpeechStartEvent {
        this.cycle += 1;
        const attackStart = this.attackStartedAt;
        const previous = this.lastEndpoint;
        const isContinuation = !!previous
            && attackStart >= previous.at
            && attackStart - previous.at <= this.options.continuationWindowMs;

        this.speaking = true;
        this.speechStartedAt = attackStart;
        this.lastVoiceAt = now;
        this.voicedDurationMs = this.attackDurationMs;
        this.continuation = isContinuation;
        this.resumedFromCycle = isContinuation ? previous?.cycle : undefined;
        this.captureAnchorAt = isContinuation && previous
            ? previous.captureAnchorAt
            : attackStart - this.options.preRollMs;
        this.resetAttack();

        return {
            type: 'speech-start',
            token: this.currentToken(),
            at: now,
            speechStartedAt: attackStart,
            continuation: isContinuation,
            ...(this.resumedFromCycle === undefined ? {} : {resumedFromCycle: this.resumedFromCycle}),
        };
    }

    private maybeFinish(now: number, events: AutoAnswerEvent[]): void {
        if (!this.speaking) return;
        const silenceDurationMs = Math.max(0, now - this.lastVoiceAt);
        if (silenceDurationMs < this.options.endpointSilenceMs) return;

        if (this.voicedDurationMs < this.options.minimumVoicedMs) {
            this.resetUtterance();
            return;
        }

        if (this.mode === 'realtime') {
            const hasCurrentTranscript = !!this.normalizedTranscript
                && this.transcriptRevision > this.cycleTranscriptRevision;
            if (!hasCurrentTranscript) {
                if (silenceDurationMs >= this.options.transcriptWaitTimeoutMs) {
                    this.resetUtterance();
                }
                return;
            }
            if (now - this.lastTranscriptChangeAt < this.options.transcriptStableMs) return;
        }

        const token = this.currentToken();
        const captureDurationMs = Math.min(
            this.options.maxCaptureMs,
            Math.max(0, now - this.captureAnchorAt),
        );
        const event: AutoAnswerEndpointEvent = {
            type: 'endpoint',
            token,
            at: now,
            mode: this.mode,
            continuation: this.continuation,
            ...(this.resumedFromCycle === undefined ? {} : {resumedFromCycle: this.resumedFromCycle}),
            transcript: this.transcript,
            captureDurationMs,
            preRollMs: this.options.preRollMs,
            voicedDurationMs: this.voicedDurationMs,
            silenceDurationMs,
        };
        this.lastEndpoint = {
            at: now,
            cycle: token.cycle,
            captureAnchorAt: this.captureAnchorAt,
        };
        this.resetUtterance();
        events.push(event);
    }

    private resetUtterance(): void {
        this.speaking = false;
        this.speechStartedAt = 0;
        this.lastVoiceAt = 0;
        this.voicedDurationMs = 0;
        this.captureAnchorAt = 0;
        this.continuation = false;
        this.resumedFromCycle = undefined;
        this.cycleTranscriptRevision = this.transcriptRevision;
        this.resetAttack();
    }

    private resetAttack(): void {
        this.attackDurationMs = 0;
        this.attackStartedAt = 0;
    }

    private observeNoise(levelDb: number, durationMs: number, calibrating: boolean): void {
        // Ambient increases slowly once calibrated so a new speaker cannot
        // immediately redefine the floor. Quieter observations converge faster.
        // The short initial calibration is deliberately capped: Auto can be
        // enabled after somebody has already started speaking, and learning
        // those first syllables as ambient would make the entire turn invisible.
        const observedLevelDb = calibrating
            ? Math.min(levelDb, Math.max(this.options.initialNoiseFloorDb, -44))
            : levelDb;
        const tauMs = calibrating
            ? 120
            : observedLevelDb <= this.noiseFloorDb
                ? 500
                : 3_500;
        const alpha = 1 - Math.exp(-durationMs / tauMs);
        this.noiseFloorDb = finiteRange(
            this.noiseFloorDb + (observedLevelDb - this.noiseFloorDb) * alpha,
            -90,
            -24,
            this.options.initialNoiseFloorDb,
        );
    }

    private speechThresholdDb(): number {
        return finiteRange(this.noiseFloorDb + this.options.speechMarginDb, -52, -24, -42);
    }

    private releaseThresholdDb(): number {
        const release = finiteRange(this.noiseFloorDb + this.options.releaseMarginDb, -58, -28, -48);
        return Math.min(release, this.speechThresholdDb() - 3);
    }
}

function normalizeOptions(options: AutoAnswerEngineOptions): NormalizedOptions {
    return {
        calibrationMs: finiteRange(options.calibrationMs, 0, 5_000, DEFAULTS.calibrationMs),
        speechAttackMs: finiteRange(options.speechAttackMs, 80, 1_000, DEFAULTS.speechAttackMs),
        minimumVoicedMs: finiteRange(options.minimumVoicedMs, 100, 5_000, DEFAULTS.minimumVoicedMs),
        endpointSilenceMs: finiteRange(options.endpointSilenceMs, 400, 8_000, DEFAULTS.endpointSilenceMs),
        transcriptStableMs: finiteRange(options.transcriptStableMs, 100, 5_000, DEFAULTS.transcriptStableMs),
        transcriptWaitTimeoutMs: finiteRange(
            options.transcriptWaitTimeoutMs,
            1_000,
            15_000,
            DEFAULTS.transcriptWaitTimeoutMs,
        ),
        continuationWindowMs: finiteRange(
            options.continuationWindowMs,
            500,
            10_000,
            DEFAULTS.continuationWindowMs,
        ),
        preRollMs: finiteRange(options.preRollMs, 0, 5_000, DEFAULTS.preRollMs),
        maxCaptureMs: finiteRange(
            options.maxCaptureMs,
            1_000,
            HARD_MAX_CAPTURE_MS,
            DEFAULTS.maxCaptureMs,
        ),
        initialNoiseFloorDb: finiteRange(
            options.initialNoiseFloorDb,
            -90,
            -24,
            DEFAULTS.initialNoiseFloorDb,
        ),
        speechMarginDb: finiteRange(options.speechMarginDb, 3, 30, DEFAULTS.speechMarginDb),
        releaseMarginDb: finiteRange(options.releaseMarginDb, 1, 24, DEFAULTS.releaseMarginDb),
    };
}

function finiteRange(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(minimum, Math.min(maximum, Number(value)));
}

function rmsToDb(value: number): number {
    const rms = finiteRange(value, 0, 1, 0);
    return Math.max(-100, 20 * Math.log10(Math.max(rms, 0.000_01)));
}

function normalizeTranscript(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

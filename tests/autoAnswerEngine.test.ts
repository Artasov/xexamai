import {describe, expect, it} from 'vitest';
import {
    AutoAnswerEngine,
    AutoAnswerTimeline,
    type AutoAnswerEndpointEvent,
    type AutoAnswerEvent,
    type AutoAnswerSpeechStartEvent,
} from '../src/renderer/app/autoAnswerEngine';

class Driver {
    now = 0;
    readonly events: AutoAnswerEvent[] = [];

    constructor(readonly engine: AutoAnswerEngine) {}

    audio(rms: number, durationMs: number, frameMs = 20): AutoAnswerEvent[] {
        const emitted: AutoAnswerEvent[] = [];
        let remaining = durationMs;
        while (remaining > 0) {
            const duration = Math.min(frameMs, remaining);
            this.now += duration;
            const next = this.engine.ingestAudio({rms, durationMs: duration, now: this.now});
            emitted.push(...next);
            this.events.push(...next);
            remaining -= duration;
        }
        return emitted;
    }

    transcript(text: string): AutoAnswerEvent[] {
        const events = this.engine.updateTranscript({text, now: this.now});
        this.events.push(...events);
        return events;
    }

    tick(afterMs: number): AutoAnswerEvent[] {
        this.now += afterMs;
        const events = this.engine.tick(this.now);
        this.events.push(...events);
        return events;
    }

    starts(): AutoAnswerSpeechStartEvent[] {
        return this.events.filter((event): event is AutoAnswerSpeechStartEvent => event.type === 'speech-start');
    }

    endpoints(): AutoAnswerEndpointEvent[] {
        return this.events.filter((event): event is AutoAnswerEndpointEvent => event.type === 'endpoint');
    }
}

function calibrated(mode: 'realtime' | 'buffered' = 'realtime') {
    const driver = new Driver(new AutoAnswerEngine({mode}));
    driver.audio(0.001, 400);
    return driver;
}

describe('AutoAnswerEngine', () => {
    it('does not double-count delayed PCM when wall-clock ticks occur before a burst', () => {
        const timeline = new AutoAnswerTimeline();
        timeline.reset(1_000);

        // Timer/transcript callbacks only observe the media clock. Two 100 ms
        // PCM packets remain 200 ms of elapsed audio even if a wall timer fired
        // while the native callbacks were queued.
        expect(timeline.current()).toBe(1_000);
        expect(timeline.current()).toBe(1_000);
        expect(timeline.advanceAudio(100)).toBe(1_100);
        expect(timeline.current()).toBe(1_100);
        expect(timeline.advanceAudio(100)).toBe(1_200);
        expect(timeline.current()).toBe(1_200);
    });

    it('does not manufacture an endpoint from timer ticks while PCM callbacks are delayed', () => {
        const timeline = new AutoAnswerTimeline();
        timeline.reset(1_000);
        const engine = new AutoAnswerEngine({
            mode: 'realtime',
            calibrationMs: 0,
            speechAttackMs: 80,
            minimumVoicedMs: 100,
            endpointSilenceMs: 400,
            transcriptStableMs: 100,
        });

        engine.ingestAudio({rms: 0.1, durationMs: 100, now: timeline.advanceAudio(100)});
        engine.ingestAudio({rms: 0.1, durationMs: 100, now: timeline.advanceAudio(100)});
        engine.updateTranscript({text: 'Delayed callback question', now: timeline.current()});
        for (let tick = 0; tick < 20; tick += 1) {
            expect(engine.tick(timeline.current())).toEqual([]);
        }

        let endpoint: AutoAnswerEndpointEvent | undefined;
        for (let frame = 0; frame < 4; frame += 1) {
            const events = engine.ingestAudio({
                rms: 0.001,
                durationMs: 100,
                now: timeline.advanceAudio(100),
            });
            endpoint = events.find((event): event is AutoAnswerEndpointEvent => event.type === 'endpoint')
                ?? endpoint;
        }
        expect(endpoint?.transcript).toBe('Delayed callback question');
    });

    it('adapts to a steady noise floor, confirms sustained speech, and endpoints stable realtime text', () => {
        const driver = new Driver(new AutoAnswerEngine({mode: 'realtime'}));
        driver.audio(0.01, 1_000);
        expect(driver.events).toEqual([]);
        expect(driver.engine.snapshot().noiseFloorDb).toBeGreaterThan(-45);

        driver.audio(0.12, 200);
        expect(driver.starts()).toHaveLength(1);
        expect(driver.starts()[0].at - driver.starts()[0].speechStartedAt).toBeGreaterThanOrEqual(180);

        driver.audio(0.1, 300);
        driver.transcript('How does optimistic locking work?');
        driver.audio(0.01, 1_520);

        expect(driver.endpoints()).toHaveLength(1);
        expect(driver.endpoints()[0]).toMatchObject({
            mode: 'realtime',
            transcript: 'How does optimistic locking work?',
            continuation: false,
        });
        expect(driver.endpoints()[0].captureDurationMs).toBeGreaterThan(2_000);
    });

    it('ignores short clicks and does not endpoint a brief cough-like impulse', () => {
        const driver = calibrated('buffered');
        driver.audio(0.3, 100);
        driver.audio(0.001, 1_600);
        expect(driver.starts()).toHaveLength(0);
        expect(driver.endpoints()).toHaveLength(0);

        driver.audio(0.3, 220);
        expect(driver.starts()).toHaveLength(1);
        driver.audio(0.001, 1_600);
        expect(driver.endpoints()).toHaveLength(0);
        expect(driver.engine.snapshot().phase).toBe('idle');
    });

    it('treats a natural pause shorter than the endpoint silence as the same utterance', () => {
        const driver = calibrated();
        driver.audio(0.08, 500);
        driver.transcript('Can you explain');
        driver.audio(0.001, 1_100);
        expect(driver.endpoints()).toHaveLength(0);

        driver.audio(0.08, 300);
        driver.transcript('Can you explain database isolation levels?');
        expect(driver.starts()).toHaveLength(1);
        driver.audio(0.001, 1_500);

        expect(driver.endpoints()).toHaveLength(1);
        expect(driver.endpoints()[0].transcript).toContain('isolation levels');
    });

    it('requires a nonempty stable transcript in realtime mode', () => {
        const driver = calibrated();
        driver.audio(0.08, 500);
        driver.audio(0.001, 1_600);
        expect(driver.endpoints()).toHaveLength(0);

        driver.transcript('What is a covering index?');
        driver.tick(649);
        expect(driver.endpoints()).toHaveLength(0);
        driver.tick(1);
        expect(driver.endpoints()).toHaveLength(1);
    });

    it('keeps the first realtime transcript revision received during calibration', () => {
        const driver = new Driver(new AutoAnswerEngine({mode: 'realtime'}));
        driver.audio(0.08, 100);
        driver.transcript('Short question?');
        driver.audio(0.08, 200);
        driver.audio(0.08, 400);
        driver.audio(0.001, 1_500);

        expect(driver.starts()).toHaveLength(1);
        expect(driver.endpoints()).toHaveLength(1);
        expect(driver.endpoints()[0].transcript).toBe('Short question?');
    });

    it('does not learn modest speech as ambient when enabled mid-utterance', () => {
        const driver = new Driver(new AutoAnswerEngine({mode: 'realtime'}));
        driver.audio(0.02, 100);
        driver.transcript('Question already in progress');
        driver.audio(0.02, 200);
        driver.audio(0.02, 400);
        driver.audio(0.001, 1_500);

        expect(driver.starts()).toHaveLength(1);
        expect(driver.endpoints()).toHaveLength(1);
        expect(driver.endpoints()[0].transcript).toBe('Question already in progress');
    });

    it('keeps the first realtime transcript revision received during speech attack', () => {
        const driver = calibrated();
        driver.audio(0.08, 100);
        driver.transcript('Question received during attack?');
        driver.audio(0.08, 300);
        driver.audio(0.001, 1_500);

        expect(driver.starts()).toHaveLength(1);
        expect(driver.endpoints()).toHaveLength(1);
        expect(driver.endpoints()[0].transcript).toBe('Question received during attack?');
    });

    it('does not reuse an acknowledged final transcript for the next utterance', () => {
        const driver = calibrated();
        driver.audio(0.08, 400);
        driver.transcript('First question');
        driver.audio(0.001, 1_500);
        expect(driver.endpoints()).toHaveLength(1);

        // A provider can publish final wording after acoustic endpointing. The
        // renderer acknowledges that turn by clearing the engine transcript.
        driver.transcript('First question, finalized');
        driver.transcript('');
        driver.audio(0.08, 400);
        driver.audio(0.001, 1_500);
        expect(driver.endpoints()).toHaveLength(1);

        driver.transcript('Second question');
        driver.tick(650);
        expect(driver.endpoints()).toHaveLength(2);
        expect(driver.endpoints()[1].transcript).toBe('Second question');
    });

    it('allows buffered mode to endpoint without transcript text', () => {
        const driver = calibrated('buffered');
        driver.audio(0.08, 500);
        driver.audio(0.001, 1_500);

        expect(driver.endpoints()).toHaveLength(1);
        expect(driver.endpoints()[0].transcript).toBe('');
    });

    it('invalidates the previous cycle and classifies nearby resumed speech as a continuation', () => {
        const driver = calibrated('buffered');
        driver.audio(0.08, 500);
        driver.audio(0.001, 1_500);
        const firstEndpoint = driver.endpoints()[0];
        const firstCapture = firstEndpoint.captureDurationMs;
        expect(driver.engine.isCurrent(firstEndpoint.token)).toBe(true);

        driver.tick(2_000);
        driver.audio(0.08, 200);
        const resumed = driver.starts()[1];
        expect(resumed).toMatchObject({continuation: true, resumedFromCycle: firstEndpoint.token.cycle});
        expect(driver.engine.isCurrent(firstEndpoint.token)).toBe(false);

        driver.audio(0.08, 200);
        driver.audio(0.001, 1_500);
        const secondEndpoint = driver.endpoints()[1];
        expect(secondEndpoint.continuation).toBe(true);
        expect(secondEndpoint.captureDurationMs).toBeGreaterThan(firstCapture);
    });

    it('starts a new turn after the continuation window or explicit finalization', () => {
        const driver = calibrated('buffered');
        driver.audio(0.08, 400);
        driver.audio(0.001, 1_500);
        const first = driver.endpoints()[0];
        driver.tick(3_100);
        driver.audio(0.08, 200);
        expect(driver.starts()[1].continuation).toBe(false);

        const finalizedDriver = calibrated('buffered');
        finalizedDriver.audio(0.08, 400);
        finalizedDriver.audio(0.001, 1_500);
        const finalized = finalizedDriver.endpoints()[0];
        expect(finalizedDriver.engine.finalize(finalized.token)).toBe(true);
        finalizedDriver.tick(500);
        finalizedDriver.audio(0.08, 200);
        expect(finalizedDriver.starts()[1].continuation).toBe(false);
    });

    it('caps rolling-buffer capture requests at sixty seconds including pre-roll', () => {
        const driver = new Driver(new AutoAnswerEngine({mode: 'buffered', calibrationMs: 0, preRollMs: 800}));
        driver.audio(0.08, 59_000, 100);
        driver.audio(0.001, 1_500, 100);
        expect(driver.endpoints()).toHaveLength(1);
        expect(driver.endpoints()[0].captureDurationMs).toBe(60_000);
        expect(driver.endpoints()[0].preRollMs).toBe(800);
    });

    it('uses epoch and cycle tokens to reject stale asynchronous work', () => {
        const driver = calibrated('buffered');
        driver.audio(0.08, 400);
        const speechToken = driver.starts()[0].token;
        expect(driver.engine.isCurrent(speechToken)).toBe(true);

        const invalidated = driver.engine.invalidate(driver.now);
        expect(invalidated.epoch).toBe(speechToken.epoch + 1);
        expect(invalidated.cycle).toBe(0);
        expect(driver.engine.isCurrent(speechToken)).toBe(false);

        const changedMode = driver.engine.setMode('realtime', driver.now);
        expect(changedMode.epoch).toBe(invalidated.epoch + 1);
        expect(driver.engine.snapshot().mode).toBe('realtime');
    });

    it('recalibrates ambient noise while invalidating outstanding work', () => {
        const driver = new Driver(new AutoAnswerEngine({mode: 'buffered'}));
        driver.audio(0.01, 1_000);
        expect(driver.engine.snapshot().noiseFloorDb).toBeGreaterThan(-45);

        driver.audio(0.12, 200);
        const speechToken = driver.starts()[0].token;
        const recalibrated = driver.engine.recalibrate(driver.now);

        expect(recalibrated).toEqual({epoch: speechToken.epoch + 1, cycle: 0});
        expect(driver.engine.isCurrent(speechToken)).toBe(false);
        expect(driver.engine.snapshot()).toMatchObject({
            phase: 'calibrating',
            noiseFloorDb: -60,
            transcript: '',
            transcriptRevision: 0,
        });
    });
});

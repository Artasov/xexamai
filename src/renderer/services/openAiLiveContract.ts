import {
    OPENAI_LIVE_TRANSCRIBE_MODEL,
    OPENAI_REALTIME_TRANSLATE_MODEL,
} from '@shared/constants';

export const OPENAI_LIVE_MODEL = OPENAI_LIVE_TRANSCRIBE_MODEL;
export const OPENAI_LIVE_ENDPOINT = 'wss://api.openai.com/v1/realtime';
export const OPENAI_TRANSLATION_MODEL = OPENAI_REALTIME_TRANSLATE_MODEL;

/**
 * A client secret is already bound to its transcription session. A `model`
 * query parameter is a generic Realtime model override and must not be added.
 */
export const buildOpenAiLiveWebSocketUrl = (): string => OPENAI_LIVE_ENDPOINT;

export const isOpenAiRealtimeTranscription = (
    mode: string | undefined,
    model: string | undefined,
): boolean => mode !== 'local' && model === OPENAI_LIVE_MODEL;

export const isOpenAiRealtimeTranslation = (
    mode: string | undefined,
    model: string | undefined,
): boolean => mode !== 'local' && model === OPENAI_TRANSLATION_MODEL;

const normalizePrompt = (prompt: string | undefined): string | undefined => {
    const normalized = prompt?.replace(/\s+/g, ' ').trim();
    return normalized ? normalized.slice(0, 1_024) : undefined;
};

/**
 * Builds the exact public Realtime transcription session contract. Language
 * hints are deliberately omitted so code-switched speech is auto-detected.
 */
export const buildOpenAiLiveSessionUpdate = (prompt?: string) => {
    const normalizedPrompt = normalizePrompt(prompt);
    return {
        type: 'session.update' as const,
        session: {
            type: 'transcription' as const,
            audio: {
                input: {
                    format: {
                        type: 'audio/pcm' as const,
                        rate: 24_000 as const,
                    },
                    noise_reduction: {
                        type: 'far_field' as const,
                    },
                    transcription: {
                        model: OPENAI_LIVE_MODEL,
                        delay: 'medium' as const,
                        ...(normalizedPrompt ? {prompt: normalizedPrompt} : {}),
                    },
                    // This model streams deltas without VAD and finalizes the
                    // current item after input_audio_buffer.commit.
                    turn_detection: null,
                },
            },
        },
    };
};

export const decodeOpenAiLiveMessage = async (data: unknown): Promise<Record<string, any>> => {
    let json: string;
    if (typeof data === 'string') {
        json = data;
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        json = await data.text();
    } else if (data instanceof ArrayBuffer) {
        json = new TextDecoder().decode(data);
    } else if (ArrayBuffer.isView(data)) {
        json = new TextDecoder().decode(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
    } else {
        throw new Error('Unsupported OpenAI Realtime WebSocket frame type.');
    }
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('OpenAI Realtime returned a non-object message.');
    }
    return parsed as Record<string, any>;
};

export const getOpenAiLiveError = (message: Record<string, any>): string | null => {
    if (message.type !== 'error' && !message.error) return null;
    const raw = typeof message.error === 'string'
        ? message.error
        : typeof message.error?.message === 'string'
            ? message.error.message
            : typeof message.message === 'string'
                ? message.message
                : null;
    if (!raw) return null;
    const normalized = raw.split(/\s+/).filter(Boolean).join(' ');
    return normalized ? normalized.slice(0, 320) : null;
};

type TranscriptItem = {
    text: string;
    completed: boolean;
    acknowledgedText: string;
};

export type OpenAiTranscriptAcknowledgement = {
    items: Array<{id: string; text: string}>;
};

const advanceAcknowledgement = (
    current: string,
    existing: string,
    captured: string,
): string => {
    if (captured && current.startsWith(captured)) return captured;
    if (existing && current.startsWith(existing)) return existing;
    // The provider can replace a partial with an authoritative completion.
    // If it no longer shares the acknowledged prefix, publishing the complete
    // revision is safer than silently swallowing text the user never sent.
    return '';
};

/** Reconciles interleaved Realtime transcript events by item_id. */
export class OpenAiTranscriptAssembler {
    private readonly order: string[] = [];
    private readonly items = new Map<string, TranscriptItem>();

    reset(): void {
        this.order.length = 0;
        this.items.clear();
    }

    captureAcknowledgement(): OpenAiTranscriptAcknowledgement {
        return {
            items: this.order.flatMap((id) => {
                const item = this.items.get(id);
                return item ? [{id, text: item.text}] : [];
            }),
        };
    }

    acknowledge(
        acknowledgement: OpenAiTranscriptAcknowledgement = this.captureAcknowledgement(),
    ): void {
        const capturedById = new Map(
            acknowledgement.items.map(({id, text}) => [id, text]),
        );
        for (const [id, item] of this.items) {
            const captured = capturedById.get(id);
            if (captured === undefined) continue;
            item.acknowledgedText = advanceAcknowledgement(
                item.text,
                item.acknowledgedText,
                captured,
            );
        }
    }

    apply(message: Record<string, any>): string | null {
        const type = message.type;
        if (type === 'input_audio_buffer.committed') {
            const itemId = typeof message.item_id === 'string' ? message.item_id : '';
            if (itemId) {
                this.ensureItem(
                    itemId,
                    typeof message.previous_item_id === 'string' ? message.previous_item_id : undefined,
                );
            }
            return null;
        }
        if (
            type !== 'conversation.item.input_audio_transcription.delta'
            && type !== 'conversation.item.input_audio_transcription.completed'
        ) return null;

        const itemId = typeof message.item_id === 'string' && message.item_id
            ? message.item_id
            : `item-${this.order.length}`;
        const item = this.ensureItem(itemId);

        if (type.endsWith('.delta') && typeof message.delta === 'string') {
            item.text += message.delta;
        } else if (type.endsWith('.completed') && typeof message.transcript === 'string') {
            item.text = message.transcript;
            item.completed = true;
        }

        return this.render();
    }

    private ensureItem(itemId: string, previousItemId?: string): TranscriptItem {
        let item = this.items.get(itemId);
        if (!item) {
            item = {text: '', completed: false, acknowledgedText: ''};
            this.items.set(itemId, item);
            this.order.push(itemId);
        }
        if (previousItemId) {
            const currentIndex = this.order.indexOf(itemId);
            const previousIndex = this.order.indexOf(previousItemId);
            if (previousIndex >= 0 && currentIndex !== previousIndex + 1) {
                if (currentIndex >= 0) this.order.splice(currentIndex, 1);
                this.order.splice(previousIndex + 1, 0, itemId);
            }
        }
        return item;
    }

    private render(): string {
        let output = '';
        for (const id of this.order) {
            const item = this.items.get(id);
            if (!item) continue;
            const text = item.acknowledgedText && item.text.startsWith(item.acknowledgedText)
                ? item.text.slice(item.acknowledgedText.length)
                : item.text;
            if (!text) continue;
            if (output && !/\s$/.test(output) && !/^\s/.test(text)) output += ' ';
            output += text;
        }
        return output;
    }
}

export type OpenAiTranslationTranscript = {
    source: string;
    translated: string;
};

export type OpenAiTranslationCompletion = {
    input: boolean;
    output: boolean;
};

export type OpenAiTranslationAcknowledgement = OpenAiTranslationTranscript & {
    revision: number;
};

/** Assembles translation deltas while treating completed transcripts as authoritative. */
export class OpenAiTranslationTranscriptAssembler {
    private source = '';
    private translated = '';
    private acknowledgedSource = '';
    private acknowledgedTranslation = '';
    private inputCompleted = false;
    private outputCompleted = false;
    private outputBoundaryPending = false;
    private revision = 0;

    reset(): void {
        this.source = '';
        this.translated = '';
        this.acknowledgedSource = '';
        this.acknowledgedTranslation = '';
        this.revision = 0;
        this.resetCompletion();
    }

    captureAcknowledgement(): OpenAiTranslationAcknowledgement {
        return {
            source: this.source,
            translated: this.translated,
            revision: this.revision,
        };
    }

    acknowledge(
        acknowledgement: OpenAiTranslationAcknowledgement = this.captureAcknowledgement(),
    ): void {
        this.acknowledgedSource = advanceAcknowledgement(
            this.source,
            this.acknowledgedSource,
            acknowledgement.source,
        );
        this.acknowledgedTranslation = advanceAcknowledgement(
            this.translated,
            this.acknowledgedTranslation,
            acknowledgement.translated,
        );
        if (acknowledgement.revision === this.revision) this.resetCompletion();
    }

    completionState(): OpenAiTranslationCompletion {
        return {
            input: this.inputCompleted,
            output: this.outputCompleted,
        };
    }

    isOutputCompleted(): boolean {
        return this.outputCompleted;
    }

    /** Returns true once for each newly completed translated-output boundary. */
    consumeOutputBoundary(): boolean {
        const pending = this.outputBoundaryPending;
        this.outputBoundaryPending = false;
        return pending;
    }

    apply(message: Record<string, any>): OpenAiTranslationTranscript | null {
        const type = message.type;
        const inputDelta = type === 'session.input_transcript.delta';
        const outputDelta = type === 'session.output_transcript.delta';
        const inputComplete = type === 'session.input_transcript.completed';
        const outputComplete = type === 'session.output_transcript.completed';
        if (!inputDelta && !outputDelta && !inputComplete && !outputComplete) {
            return null;
        }
        this.revision += 1;

        if (inputDelta || outputDelta) {
            // Either stream beginning another delta means the previous output
            // boundary is no longer the current turn. `acknowledge` performs
            // the same reset after the coordinator consumes a turn.
            this.resetCompletion();
            const delta = typeof message.delta === 'string' ? message.delta : '';
            if (inputDelta) this.source += delta;
            else this.translated += delta;
        } else {
            const transcript = typeof message.transcript === 'string'
                ? message.transcript
                : null;
            if (inputComplete) {
                if (transcript !== null) this.source = transcript;
                this.inputCompleted = true;
            } else {
                if (transcript !== null) this.translated = transcript;
                if (!this.outputCompleted) this.outputBoundaryPending = true;
                this.outputCompleted = true;
            }
        }
        return this.render();
    }

    private resetCompletion(): void {
        this.inputCompleted = false;
        this.outputCompleted = false;
        this.outputBoundaryPending = false;
    }

    private render(): OpenAiTranslationTranscript {
        return {
            source: this.withoutAcknowledged(this.source, this.acknowledgedSource),
            translated: this.withoutAcknowledged(this.translated, this.acknowledgedTranslation),
        };
    }

    private withoutAcknowledged(value: string, acknowledged: string): string {
        if (!acknowledged) return value;
        return value.startsWith(acknowledged) ? value.slice(acknowledged.length) : value;
    }
}

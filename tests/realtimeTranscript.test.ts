import {describe, expect, it} from 'vitest';
import {
    appendSubmittedPrompt,
    composeRealtimeTranslationPrompt,
    extractRealtimeSourceEdit,
    reconcileRealtimeAcknowledgement,
    reconcileRealtimeTranslationAcknowledgement,
    reconcileRealtimeTextWithEdit,
    reconcileRealtimeTranscript,
    removeSubmittedPromptPrefix,
} from '../src/renderer/utils/realtimeTranscript';

describe('reconcileRealtimeTranscript', () => {
    it('replaces a corrected partial instead of duplicating it', () => {
        expect(reconcileRealtimeTranscript('Question hello worl', 'hello worl', 'hello world'))
            .toBe('Question hello world');
        expect(reconcileRealtimeTranscript('Question hello world', 'hello world', 'hello word'))
            .toBe('Question hello word');
    });

    it('appends a disjoint next transcription segment', () => {
        expect(reconcileRealtimeTranscript('Question hello', 'hello', ' from audio'))
            .toBe('Question hello from audio');
    });

    it('separates the first provider fragment from a user instruction', () => {
        expect(reconcileRealtimeTranscript('Answer for Java.', '', 'What is polymorphism?'))
            .toBe('Answer for Java. What is polymorphism?');
        expect(reconcileRealtimeTranscript('Answer for Java. ', '', 'What is polymorphism?'))
            .toBe('Answer for Java. What is polymorphism?');
    });

    it('preserves provider boundaries when a word is split across chunks', () => {
        let current = reconcileRealtimeTranscript('', '', ' Ho');
        current = reconcileRealtimeTranscript(current, ' Ho', 'w');
        current = reconcileRealtimeTranscript(current, 'w', ' are');
        expect(current).toBe('How are');
    });

    it('does not overwrite user edits after a prior partial', () => {
        expect(reconcileRealtimeTranscript('hello typed suffix', 'hello', 'hello world'))
            .toBe('hello world typed suffix');
    });

    it('extracts explicit edits made in the source translation view', () => {
        expect(extractRealtimeSourceEdit('What is polymorphism?', 'What is polymorphism? Answer for Java.'))
            .toBe('Answer for Java.');
        expect(extractRealtimeSourceEdit('What is polimorphism?', 'What is polymorphism?'))
            .toBe('What is polymorphism?');
        expect(extractRealtimeSourceEdit('What is polymorphism?', 'What is polymorphism?'))
            .toBe('');
        expect(extractRealtimeSourceEdit(
            'What is polymorphism? Follow up',
            'What is polymorphism? Answer for Java. Follow up',
        )).toBe('Answer for Java.');
    });

    it('keeps translation primary while carrying a source-side clarification', () => {
        expect(composeRealtimeTranslationPrompt('Что такое полиморфизм?', 'Answer for Java.'))
            .toBe('Что такое полиморфизм?\n\nUser-provided clarification:\nAnswer for Java.');
        expect(composeRealtimeTranslationPrompt('', 'Use the source wording.'))
            .toBe('Use the source wording.');
    });

    it('clears and restores the exact submitted canonical prompt', () => {
        expect(removeSubmittedPromptPrefix(
            'What is polymorphism? Follow-up words',
            'What is polymorphism?',
        )).toBe('Follow-up words');
        expect(appendSubmittedPrompt('Follow-up words', 'What is polymorphism?'))
            .toBe('What is polymorphism? Follow-up words');
    });

    it('keeps provider and user text that arrives while a submitted snapshot is dispatching', () => {
        let current = reconcileRealtimeAcknowledgement(
            'First question with detail typed note',
            'First question',
            ' with detail',
        );
        expect(current).toBe('with detail typed note');
        current = reconcileRealtimeTranscript(
            current,
            ' with detail',
            ' with detail and context',
        );
        expect(current).toBe('with detail and context typed note');
        expect(reconcileRealtimeAcknowledgement(
            'Как дела Answer for Java',
            'Как',
            ' дела',
        )).toBe('дела Answer for Java');
    });

    it('keeps ambiguous in-place user edits instead of erasing them on acknowledgement', () => {
        expect(reconcileRealtimeAcknowledgement(
            'Corrected question',
            'Wrong question',
            '',
        )).toBe('Corrected question');
    });

    it('acknowledges the originally submitted translation view after the user toggles views', () => {
        expect(reconcileRealtimeTranslationAcknowledgement(
            {
                source: 'How are Answer briefly',
                translated: 'Как дела New translated note',
            },
            {
                submittedText: 'How',
                submittedTranslationView: 'source',
                acknowledgedSource: 'How',
                acknowledgedTranslated: 'Как',
                source: ' are',
                translated: ' дела',
            },
        )).toEqual({
            source: 'are Answer briefly',
            translated: 'дела New translated note',
        });
    });

    it('does not remove or suppress a merely similar prompt prefix', () => {
        expect(removeSubmittedPromptPrefix('Whatever follows', 'What')).toBe('Whatever follows');
        expect(appendSubmittedPrompt('Whatever follows', 'What')).toBe('What Whatever follows');
        expect(extractRealtimeSourceEdit('SQL', 'NoSQL')).toBe('NoSQL');
    });

    it('applies provider growth without duplicating an edited live field', () => {
        expect(reconcileRealtimeTextWithEdit(
            'Answer briefly.',
            '',
            'What is polymorphism?',
            'Answer briefly.',
        )).toBe('Answer briefly. What is polymorphism?');
        expect(reconcileRealtimeTextWithEdit(
            'What is polymorphism? Answer for Java.',
            'What is polymorphism?',
            'What is polymorphism? Please give an example.',
            'Answer for Java.',
        )).toBe('What is polymorphism? Please give an example. Answer for Java.');
        expect(reconcileRealtimeTextWithEdit(
            'What is polymorphism?',
            'What is poly',
            'What is poly used for?',
            'What is polymorphism?',
        )).toBe('What is polymorphism? used for?');
        expect(reconcileRealtimeTextWithEdit(
            'Corrected wording',
            'Wrong wording',
            'Different provider correction',
            'Corrected wording',
        )).toBe('Corrected wording');
    });
});

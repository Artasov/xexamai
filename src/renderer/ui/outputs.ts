import {marked} from 'marked';
import {addErrorHelpStyles, formatError} from '../utils/errorFormatter';

// Initialize styles for error help blocks
addErrorHelpStyles();

let textOut: HTMLDivElement | null = null;
let answerOut: HTMLDivElement | null = null;

export function initOutputs(elements: { text?: HTMLDivElement | null; answer?: HTMLDivElement | null }) {
    if (typeof elements !== 'object' || !elements) return;
    if (elements.text) textOut = elements.text;
    if (elements.answer) answerOut = elements.answer;
}

export function showText(text: string) {
    const target = textOut ?? (document.getElementById('textOut') as HTMLDivElement | null);
    if (!target) return;
    textOut = target;
    target.textContent = text || '';
}

export function showAnswer(text: string) {
    const target = answerOut ?? (document.getElementById('answerOut') as HTMLDivElement | null);
    if (!target) return;

    answerOut = target;

    // Preserve current scroll position
    const currentScrollTop = target.scrollTop;
    const currentScrollHeight = target.scrollHeight;
    const isAtBottom = currentScrollTop + target.clientHeight >= currentScrollHeight - 5; // 5px tolerance

    target.innerHTML = text ? (marked.parse(text, {async: false}) as string) : '';

    // Restore scroll position only if the user was not at the bottom
    if (!isAtBottom) {
        target.scrollTop = currentScrollTop;
    }
}

export function showError(error: unknown) {
    const formattedError = formatError(error);

    const target = answerOut ?? (document.getElementById('answerOut') as HTMLDivElement | null);
    if (!target) return;

    answerOut = target;

    let errorHtml = `<div class="error-message">${formattedError.displayText}</div>`;

    if (formattedError.helpHtml) {
        errorHtml += formattedError.helpHtml;
    }

    target.innerHTML = errorHtml;
}

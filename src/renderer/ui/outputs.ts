const textOut = document.getElementById('textOut') as HTMLDivElement | null;
const answerOut = document.getElementById('answerOut') as HTMLDivElement | null;

export function showText(text: string) {
    if (textOut) textOut.textContent = text || '';
}

export function showAnswer(text: string) {
    if (answerOut) answerOut.textContent = text || '';
}


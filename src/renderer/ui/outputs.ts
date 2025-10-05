const textOut = document.getElementById('textOut') as HTMLDivElement | null;
const answerOut = document.getElementById('answerOut') as HTMLDivElement | null;

export function showText(text: string) {
    if (textOut) textOut.textContent = text || '';
}

export function showAnswer(text: string) {
    if (answerOut) {
        if (text) {
            // Рендерим Markdown через глобальный marked
            const html = (window as any).marked.parse(text);
            answerOut.innerHTML = html;
        } else {
            answerOut.innerHTML = '';
        }
    }
}


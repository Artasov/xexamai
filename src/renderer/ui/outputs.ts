import { formatError, addErrorHelpStyles } from '../utils/errorFormatter.js';

const textOut = document.getElementById('textOut') as HTMLDivElement | null;
const answerOut = document.getElementById('answerOut') as HTMLDivElement | null;

// Инициализируем стили для помощи при ошибках
addErrorHelpStyles();

export function showText(text: string) {
    if (textOut) textOut.textContent = text || '';
}

export function showAnswer(text: string) {
    if (answerOut) {
        // Сохраняем текущую позицию скролла
        const currentScrollTop = answerOut.scrollTop;
        const currentScrollHeight = answerOut.scrollHeight;
        const isAtBottom = currentScrollTop + answerOut.clientHeight >= currentScrollHeight - 5; // 5px tolerance
        
        if (text) {
            // Рендерим Markdown через глобальный marked
            const html = (window as any).marked.parse(text);
            answerOut.innerHTML = html;
        } else {
            answerOut.innerHTML = '';
        }
        
        // Восстанавливаем позицию скролла только если пользователь не был внизу
        if (!isAtBottom) {
            answerOut.scrollTop = currentScrollTop;
        }
    }
}

export function showError(error: unknown) {
    const formattedError = formatError(error);
    
    if (answerOut) {
        let errorHtml = `<div class="error-message">${formattedError.displayText}</div>`;
        
        if (formattedError.helpHtml) {
            errorHtml += formattedError.helpHtml;
        }
        
        answerOut.innerHTML = errorHtml;
    }
}


export interface ErrorInfo {
    title: string;
    message: string;
    helpUrl?: string;
    helpText?: string;
    actionText?: string;
    actionUrl?: string;
}

export interface FormattedError {
    displayText: string;
    helpHtml?: string;
    isUserFriendly: boolean;
}

const GUIDE_URL = 'https://xldev.ru/en/xexamai';

// Error mappings to user-friendly messages
const ERROR_MAPPINGS: Record<string, ErrorInfo> = {
    'OPENAI_API_KEY is not set': {
        title: 'OpenAI API key not configured',
        message: 'To use ChatGPT, you need to configure your OpenAI API key.',
        helpUrl: GUIDE_URL,
        helpText: 'Detailed setup instructions'
    },
    'GOOGLE_API_KEY is not set': {
        title: 'Google API key not configured',
        message: 'To use Google, you need to configure your Google AI API key.',
        helpUrl: GUIDE_URL,
        helpText: 'Detailed setup instructions'
    },
    'Google API key not configured': {
        title: 'Google API key not configured',
        message: 'To use Google, you need to configure your Google AI API key.',
        helpUrl: GUIDE_URL,
        helpText: 'Detailed setup instructions'
    },
    'API key is invalid': {
        title: 'Invalid API key',
        message: 'Please check the API key you entered in the settings.',
        helpUrl: GUIDE_URL,
        helpText: 'How to get a valid API key'
    },
    'Insufficient API credits': {
        title: 'Insufficient API credits',
        message: 'Your account does not have enough credits to complete this request.',
        helpUrl: GUIDE_URL,
        helpText: 'How to add API credits'
    },
    'Rate limit exceeded': {
        title: 'Rate limit exceeded',
        message: 'Too many requests. Please try again in a few minutes.',
        helpUrl: GUIDE_URL,
        helpText: 'API rate limit information'
    },
    'Network error': {
        title: 'Network error',
        message: 'There is a problem with your internet connection. Please check your connection.',
        helpUrl: GUIDE_URL,
        helpText: 'Network troubleshooting'
    },
    'Timeout': {
        title: 'Request timeout',
        message: 'The request is taking too long. Please try again.',
        helpUrl: GUIDE_URL,
        helpText: 'Performance optimization'
    },
    'Microphone access denied': {
        title: 'Microphone access denied',
        message: 'Please allow microphone access in your browser settings to record audio.',
        helpUrl: GUIDE_URL,
        helpText: 'How to allow microphone access'
    },
    'Audio recording failed': {
        title: 'Audio recording failed',
        message: 'Failed to record audio. Please check your microphone and permissions.',
        helpUrl: GUIDE_URL,
        helpText: 'Audio troubleshooting'
    },
    'Screen capture failed': {
        title: 'Screen capture failed',
        message: 'Failed to capture screen image. Please check your permissions.',
        helpUrl: GUIDE_URL,
        helpText: 'How to allow screen capture'
    }
};

export function formatError(error: unknown): FormattedError {
    const errorMessage = getErrorMessage(error);

    // Look for exact match
    let errorInfo = ERROR_MAPPINGS[errorMessage];

    // If no exact match, look for partial match
    if (!errorInfo) {
        for (const [key, info] of Object.entries(ERROR_MAPPINGS)) {
            if (errorMessage.toLowerCase().includes(key.toLowerCase()) ||
                key.toLowerCase().includes(errorMessage.toLowerCase())) {
                errorInfo = info;
                break;
            }
        }
    }

    if (errorInfo) {
        return {
            displayText: `${errorInfo.title}: ${errorInfo.message}`,
            helpHtml: createHelpHtml(errorInfo),
            isUserFriendly: true
        };
    }

    // For unknown errors, return basic message
    return {
        displayText: `Error: ${errorMessage}`,
        helpHtml: createGenericHelpHtml(),
        isUserFriendly: false
    };
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return String(error);
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function createHelpHtml(errorInfo: ErrorInfo): string {
    let html = '<div class="error-help">';

    if (errorInfo.helpUrl) {
        const helpText = errorInfo.helpText || 'Detailed instructions';
        html += `<p><a href="${escapeHtml(errorInfo.helpUrl)}" target="_blank" class="help-link">${escapeHtml(helpText)}</a></p>`;
    }

    if (errorInfo.actionText && errorInfo.actionUrl) {
        if (errorInfo.actionUrl.startsWith('#')) {
            html += `<p><button onclick="document.querySelector('${escapeHtml(errorInfo.actionUrl)}').scrollIntoView()" class="action-button">${escapeHtml(errorInfo.actionText)}</button></p>`;
        } else {
            html += `<p><a href="${escapeHtml(errorInfo.actionUrl)}" target="_blank" class="action-link">${escapeHtml(errorInfo.actionText)}</a></p>`;
        }
    }

    html += '</div>';
    return html;
}

function createGenericHelpHtml(): string {
    return `
        <div class="error-help">
            <p><a href="${escapeHtml(GUIDE_URL)}" target="_blank" class="help-link">📖 Get help</a></p>
        </div>
    `;
}

// Function to add help styles
export function addErrorHelpStyles(): void {
    if (document.getElementById('error-help-styles')) return;

    const style = document.createElement('style');
    style.id = 'error-help-styles';
    style.textContent = `
        .error-help {
            margin-top: 12px;
            padding: 12px;
            background: rgba(59, 130, 246, 0.1);
            border: 1px solid rgba(59, 130, 246, 0.2);
            border-radius: 6px;
            font-size: 14px;
        }
        
        .error-help p {
            margin: 0 0 8px 0;
        }
        
        .error-help p:last-child {
            margin-bottom: 0;
        }
        
        .help-link, .action-link {
            color: #3b82f6;
            text-decoration: none;
            font-weight: 500;
        }
        
        .help-link:hover, .action-link:hover {
            text-decoration: underline;
        }
        
        .action-button {
            background: #3b82f6;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
        }
        
        .action-button:hover {
            background: #2563eb;
        }
    `;

    document.head.appendChild(style);
}

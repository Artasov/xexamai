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
        helpText: 'Detailed setup instructions',
        actionText: 'Open settings',
        actionUrl: '#settings'
    },
    'GOOGLE_API_KEY is not set': {
        title: 'Google API key not configured',
        message: 'To use Google, you need to configure your Google AI API key.',
        helpUrl: GUIDE_URL,
        helpText: 'Detailed setup instructions',
        actionText: 'Open settings',
        actionUrl: '#settings'
    },
    'Google API key not configured': {
        title: 'Google API key not configured',
        message: 'To use Google, you need to configure your Google AI API key.',
        helpUrl: GUIDE_URL,
        helpText: 'Detailed setup instructions',
        actionText: 'Open settings',
        actionUrl: '#settings'
    },
    'API key is invalid': {
        title: 'Invalid API key',
        message: 'Please check the API key you entered in the settings.',
        helpUrl: GUIDE_URL,
        helpText: 'How to get a valid API key',
        actionText: 'Open settings',
        actionUrl: '#settings'
    },
    'Insufficient API credits': {
        title: 'Insufficient API credits',
        message: 'Your account does not have enough credits to complete this request.',
        helpUrl: GUIDE_URL,
        helpText: 'How to add API credits',
        actionText: 'Check balance',
        actionUrl: 'https://platform.openai.com/usage'
    },
    'Rate limit exceeded': {
        title: 'Rate limit exceeded',
        message: 'Too many requests. Please try again in a few minutes.',
        helpUrl: GUIDE_URL,
        helpText: 'API rate limit information',
        actionText: 'Wait and retry'
    },
    'Network error': {
        title: 'Network error',
        message: 'There is a problem with your internet connection. Please check your connection.',
        helpUrl: GUIDE_URL,
        helpText: 'Network troubleshooting',
        actionText: 'Check connection'
    },
    'Timeout': {
        title: 'Request timeout',
        message: 'The request is taking too long. Please try again.',
        helpUrl: GUIDE_URL,
        helpText: 'Performance optimization',
        actionText: 'Retry request'
    },
    'Microphone access denied': {
        title: 'Microphone access denied',
        message: 'Please allow microphone access in your browser settings to record audio.',
        helpUrl: GUIDE_URL,
        helpText: 'How to allow microphone access',
        actionText: 'Check permissions'
    },
    'Audio recording failed': {
        title: 'Audio recording failed',
        message: 'Failed to record audio. Please check your microphone and permissions.',
        helpUrl: GUIDE_URL,
        helpText: 'Audio troubleshooting',
        actionText: 'Check microphone'
    },
    'Screen capture failed': {
        title: 'Screen capture failed',
        message: 'Failed to capture screen image. Please check your permissions.',
        helpUrl: GUIDE_URL,
        helpText: 'How to allow screen capture',
        actionText: 'Check permissions'
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
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
            <p><button onclick="document.querySelector('#settings').scrollIntoView()" class="action-button">⚙️ Open settings</button></p>
        </div>
    `;
}

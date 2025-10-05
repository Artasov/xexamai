# Security Policy

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please follow these steps:

### 1. Include the following information

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Suggested fix (if you have one)
- Your contact information

### 2. Response timeline

- **Initial response**: Within 48 hours
- **Status update**: Within 7 days
- **Resolution**: Depends on complexity, but we aim for timely fixes

## Security Best Practices

### For Users

- Keep the application updated to the latest version
- Use strong, unique API keys
- Don't share your OpenAI API key with others
- Be cautious when using on shared computers
- Review the privacy policy and data handling practices

### For Developers

- Never commit API keys or secrets to the repository
- Use environment variables for sensitive configuration
- Follow Electron security best practices
- Validate all user inputs
- Keep dependencies updated
- Use secure coding practices

## Data Privacy

### What we collect

- **No personal data** is collected by the application
- **No telemetry** or usage analytics
- **No data** is sent to our servers

### What you control

- Your OpenAI API key (stored locally)
- Your audio data (processed locally, not stored)
- Your application settings (stored locally)

### Data handling

- Audio is processed locally and not stored
- API keys are stored in your local Electron userData directory
- No data is transmitted to third parties except OpenAI (for AI processing)
- You can delete all data by uninstalling the application

## Security Considerations

### API Key Security

- API keys are stored locally in your system's secure storage
- Keys are not transmitted to our servers
- You can view/change your API key in the Settings tab
- Keys are encrypted at rest by Electron's secure storage

### Audio Processing

- Audio is processed in real-time and not stored
- Audio data is only sent to OpenAI for transcription and AI processing
- No audio data is saved to disk
- Audio processing happens locally before transmission

### Network Security

- All API communications use HTTPS
- No unencrypted data transmission
- API keys are sent securely to OpenAI

## Disclosure Policy

When we receive a security vulnerability report, we will:

1. Confirm receipt of the vulnerability report
2. Investigate and confirm the vulnerability
3. Develop a fix for the vulnerability
4. Release the fix in a timely manner
5. Credit the reporter (if they wish to be credited)

## Security Updates

Security updates will be released as:

- **Patch releases** for critical security fixes
- **Minor releases** for important security improvements
- **Major releases** for significant security enhancements

## Contact

For security-related questions or concerns, please contact us through the methods mentioned in the "Reporting a Vulnerability" section above.

Thank you for helping keep xexamai secure! 🔒

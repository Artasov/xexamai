# Contributing to xexamai

Thank you for your interest in contributing to xexamai! This document provides guidelines and information for contributors.

## How to Contribute

### Reporting Issues

Before creating an issue, please:
1. Check if the issue already exists
2. Use the issue templates when available
3. Provide detailed information about the problem
4. Include steps to reproduce the issue

### Suggesting Features

We welcome feature suggestions! Please:
1. Check if the feature has already been requested
2. Provide a clear description of the proposed feature
3. Explain why this feature would be useful
4. Consider the impact on existing functionality

### Code Contributions

#### Getting Started

1. Fork the repository
2. Clone your fork locally
3. Create a new branch for your feature/fix
4. Make your changes
5. Test your changes thoroughly
6. Submit a pull request

#### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/xexamai.git
cd xexamai

# Install dependencies
npm install

# Run in development mode
npm run dev
```

#### Code Style

- Follow the existing code style and conventions
- Use TypeScript with strict mode enabled
- Use 4-space indentation for TypeScript files
- Use 2-space indentation for JSON files
- Use camelCase for variables and functions
- Use PascalCase for types and enums
- Use kebab-case for file names with role suffixes

#### Testing

- Test your changes manually before submitting
- Ensure the application builds successfully
- Test on your target platform(s)
- Include a manual test plan in your PR description

#### Pull Request Process

1. Create a clear, descriptive title
2. Provide a detailed description of changes
3. Include screenshots/GIFs for UI changes
4. List the platforms you've tested on
5. Reference any related issues

## Development Guidelines

### Project Structure

- `src/main/` - Electron main process
- `src/renderer/` - UI components and logic
- `src/preload/` - Preload scripts for security
- `configs/` - Configuration files
- `scripts/` - Build and utility scripts

### Key Technologies

- **Electron** - Cross-platform desktop framework
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS** - Utility-first CSS framework
- **OpenAI API** - AI integration

### Security Considerations

- Never commit API keys or secrets
- Use environment variables for sensitive data
- Follow Electron security best practices
- Validate all user inputs

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions?

If you have questions about contributing, please:
1. Check the existing issues and discussions
2. Create a new issue with the "question" label
3. Join our community discussions

Thank you for contributing to xexamai! 🚀

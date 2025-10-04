<div align="center">
  <img src="brand/logo.png" alt="xexamai Logo" width="200" height="200">
  <h1>xexamai</h1>
  <p><strong>Your smart assistant for interviews and exams</strong></p>
  <p>Record the last seconds of conversation, get instant answers from AI</p>
  <p>⭐ <strong>Star this repository if it helped you!</strong> ⭐</p>
</div>

## 🚀 Key Features

- **🎯 Complete invisibility** - stays hidden during screen sharing in Zoom, Google Meet, Teams and other platforms
- **🎨 Adjustable transparency** - customize the interface to your needs
- **🧠 Advanced AI models** - uses cutting-edge speech recognition and AI generation
- **⚡ Instant processing** - send the last X seconds of audio with one click
- **🔒 Privacy & Security** - all data processed locally, audio is not stored
- **💻 Cross-platform** - works on Windows, macOS and Linux
- **🎧 Flexible audio settings** - choose between system sound and microphone
- **📱 Simple interface** - intuitive and easy to use

## 📥 Download

[![Download Latest Release](https://img.shields.io/badge/Download-Latest%20Release-blue?style=for-the-badge&logo=github)](https://github.com/yourusername/xexamai/releases/latest)

## 🎯 How to Use

### 1. Setup

1. Open xexamai application
2. Go to **"Settings"** tab
3. Enter your **OpenAI API key** (get it from [platform.openai.com](https://platform.openai.com))
4. Choose **audio input device**:
    - **System Audio** - for recording sound from applications (Zoom, Teams, etc.)
    - **Microphone** - for recording your voice

### 2. Usage

1. Switch to **"Main"** tab
2. Click **"Start Listening"** - the app will start recording audio in the background
3. When needed, click **"Send Last X Seconds"** to get an AI response
4. Get instant answers to help you during interviews or exams

### 3. Usage Tips

- **For interviews**: use system audio to record interviewer's questions
- **For exams**: configure microphone to record your questions
- **Adjust transparency** for maximum stealth
- **Practice** before important events

## ⚠️ Important Notes

- This application is intended for educational purposes
- Ensure that AI assistance is allowed in your situation
- Follow honesty and academic integrity rules
- OpenAI API key is stored locally and not shared with third parties

## 🔧 For Developers

### Contributing

We welcome contributions to the project! If you want to contribute:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Local Development

#### Requirements

- Node.js 20+
- npm or yarn

#### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/xexamai.git
cd xexamai

# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev
```

#### Project Structure

```
src/
├── main/           # Electron main process
├── renderer/       # Renderer process (UI)
├── preload/        # Preload scripts
└── shared/         # Shared types and utilities
```

#### Available Commands

- `npm run dev` - run in development mode
- `npm run build` - build the project
- `npm run build:win` - create portable Windows executable
- `npm run build:mac` - create portable macOS executable (только на macOS)
- `npm run build:linux` - create portable Linux directory
- `npm run build:all` - create portable executables for Windows and Linux
- `npm run build:win-linux` - same as build:all
- `npm run clean` - clean build directory

#### Building for Different Platforms

##### Windows
```bash
npm run build:win
```
Creates:
- Portable executable (`xexamai-${version}.exe`)

##### macOS
```bash
npm run build:mac
```
Creates:
- ZIP archive for Intel and Apple Silicon (`xexamai-${version}-x64.zip`, `xexamai-${version}-arm64.zip`)

**Note**: For macOS builds, you may need to:
1. Install Xcode Command Line Tools: `xcode-select --install`

##### Linux
```bash
npm run build:linux
```
Creates:
- Portable directory (`linux-unpacked/`)
- **Автоматически создается архив** (`xexamai-${version}-linux-x64.tar.gz`)

**Note**: 
- Архив готов для распространения - пользователи могут распаковать и запустить
- Для сборки AppImage нужны дополнительные инструменты, которые сложно настроить на Windows

##### Cross-platform Building

**⚠️ Ограничения кроссплатформенной сборки:**

- **Windows**: Может собирать только для Windows и Linux (через WSL)
- **macOS**: Может собирать для всех платформ (Windows, macOS, Linux)
- **Linux**: Может собирать только для Linux и Windows, но не macOS

**Команды для кроссплатформенной сборки:**

```bash
# На Windows - только Windows и Linux
npm run build:all

# На macOS - все платформы
npm run build:all
npm run build:win
npm run build:mac  
npm run build:linux

# На Linux - только Linux и Windows
npm run build:all
```

**Для сборки macOS версии:**
- Используйте macOS машину
- Или используйте GitHub Actions (если настроите CI/CD)

#### Technologies

- **Electron** - cross-platform desktop application
- **TypeScript** - typed JavaScript
- **Tailwind CSS** - utility-first CSS framework
- **OpenAI API** - AI integration

---

<div align="center">
  <p>Made with ❤️ for successful interviews and exams</p>
</div>

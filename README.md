<div align="center">
  <img src="brand/logo.png" alt="xexamai Logo" width="200" height="200">
  <h1>XEXAMAI</h1>
  <h3><strong>Your smart free assistant for interviews and exams</strong></h3>
  <h3>⭐ <strong>Star this repository if it helped you!</strong> ⭐</h3>
</div>
<div align="center">
  <a href="https://github.com/Artasov/xexamai/releases/latest">
    <img src="https://img.shields.io/badge/Download-Latest%20Release-blue?style=for-the-badge&logo=github" alt="Download Latest Release">
  </a>
</div>

## Table of Contents

- [Key Features](#-key-features)
- [How to Use](#-how-to-use)
- [How to Use Locally FREE](#how-to-use-locally)
  - [Local LLM Processing](#local-llm-processing)
  - [Local Speech Recognition](#local-speech-recognition)
- [Important Notes](#important-notes)
- [For Developers](#-for-developers)

## 🚀 Key Features

- **Complete invisibility** - stays hidden during screen sharing in Zoom, Google Meet, Teams and other platforms
- **Adjustable transparency** - customize the interface to your needs
- **Advanced AI models** - uses cutting-edge speech recognition and AI generation
- **Local AI models** - use freely for free
- **Privacy & Security** - all data processed locally, audio is not stored
- **Flexible audio settings** - choose between system sound and microphone
- **Cross-platform** - works on Windows, macOS and Linux
- **Simple interface** - intuitive and easy to use
- **Customizable transcription** - choose from multiple AI models and customize prompts

### If you have any issues using the app, please open an [issue](https://github.com/Artasov/xexamai/issues)

## 🎯 How to Use

### 1. Setup

1. Open `xexamai` application
2. Go to `Settings` tab
3. Enter your `OpenAI API key` (get it from [platform.openai.com](https://platform.openai.com))
4. Choose **audio input device**:
    - `System Audio` - for recording sound from applications (Zoom, Teams, etc.)
    - `Microphone` - for recording your voice
5. **Configure transcription settings**:
    - **Transcription Model** - choose from:
        - `Whisper-1` (Default) - balanced speed and accuracy
        - `GPT-4o Transcribe` (High Quality) - maximum accuracy for complex audio
        - `GPT-4o Mini Transcribe` (Fast) - optimized for speed and efficiency
    - **Transcription Prompt** - customize how AI should process your audio:
        - Default prompt optimized for technical interviews in Russian
        - Preserves English technical terms (Redis, Postgres, API, etc.)
        - Can be customized for different languages and contexts

### 2. Usage

1. Switch to `Main` tab
2. Click `Start Audio Loop` - the app will start recording audio in the background
3. When needed, click `Send Last X Seconds` to get an AI response
4. Get instant answers to help you during interviews or exams

### 3. Usage Tips

- `For interviews`: use system audio to record interviewer's questions
- `For exams`: configure microphone to record your questions
- Adjust transparency for maximum stealth
- Practice before important events

## How to Use Locally
The examples below are implemented and tested on `Windows 11`. Steps may differ on other systems.

The assistant works in two stages:
1. Audio transcription
2. Getting an answer from the LLM

Each stage can be run locally.


1. #### Install CUDA
   https://developer.nvidia.com/cuda-12-1-0-download-archive?target_os=Windows&target_arch=x86_64&target_version=11&target_type=exe_local

2. #### cuDNN 9.13.1
   https://developer.nvidia.com/cudnn-downloads?target_os=Windows&target_arch=x86_64&target_version=11&target_type=exe_local

3. #### Add to Windows PATH environment variable
   `C:\Program Files\NVIDIA\CUDNN\v9.13\bin\12.9`
   > Or the path where cuDNN was installed

4. #### Restart the PC
   > If you will use local speech recognition, then install python from the step below, if you don't have it yet.


### Local LLM Processing

Minimum recommended configuration:
- CPU - 4 cores / 8 threads
- GPU - 6 GB VRAM
- RAM - 16 GB

1. 
   * In `xexamai` Settings choose `Transcription Mode` = `Local`
   * In `xexamai` Settings choose a `LLM Model` from the available models:
     * `gpt-oss:120b` `gpt-oss:20b` `gemma3:27b` `gemma3:12b` `gemma3:4b` `gemma3:1b` `deepseek-r1:8b` `qwen3-coder:30b` `qwen3:30b` `qwen3:8b` `qwen3:4b`
       > Choose a smaller model if your PC is low-spec

2. #### Install Ollama
   https://ollama.com/

3. #### (Optional) Change the default models location
   * Remove the original models directory
     `Remove-Item -Recurse -Force "C:\\Users\\xl\\.ollama\\models"`
   * Then create a junction
     `New-Item -ItemType Junction -Path "C:\\Users\\xl\\.ollama\\models" -Target "F:\\ollama_models\\models"`
4. #### Download the model chosen earlier
   ```shell
   ollama pull qwen3:4b
   ```
5. #### Start Ollama
   ```sh 
   ollama serve
   ```


### Local Speech Recognition
1. In `xexamai` settings select an `Transcription Mode` = `Local`.

2. Same choose one of `Local Whisper Model`

3. In Settings choose `Local Device`: `GPU` (Graphics/NVIDIA) or `CPU` (Processor)

4. ### Install and run [fast-fast-whisper](https://github.com/Artasov/fast-fast-whisper)
   It does not auto-start with Windows; you need to launch it manually so the local speech recognition server is running


## Important Notes

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
git clone https://github.com/Artasov/xexamai.git
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
- `npm run build:mac` - create portable macOS executable (macOS only)
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
- **Archive is automatically created** (`xexamai-${version}-linux-x64.tar.gz`)

**Note**:

- Archive is ready for distribution - users can extract and run
- Building AppImage requires additional tools that are difficult to configure on Windows

##### Cross-platform Building

**⚠️ Cross-platform build limitations:**

- **Windows**: Can only build for Windows and Linux (via WSL)
- **macOS**: Can build for all platforms (Windows, macOS, Linux)
- **Linux**: Can only build for Linux and Windows, but not macOS

**Cross-platform build commands:**

```bash
# On Windows - only Windows and Linux
npm run build:all

# On macOS - all platforms
npm run build:all
npm run build:win
npm run build:mac  
npm run build:linux

# On Linux - only Linux and Windows
npm run build:all
```

**To build macOS version:**

- Use a macOS machine
- Or use GitHub Actions (if you set up CI/CD)

#### Technologies

- **Electron** - cross-platform desktop application
- **TypeScript** - typed JavaScript
- **Tailwind CSS** - utility-first CSS framework
- **OpenAI API** - AI integration

---

<div align="center">
  <p>Made with ❤️ for successful interviews and exams</p>
</div>

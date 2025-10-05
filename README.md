<div align="center">
  <img src="brand/logo.png" alt="xexamai Logo" width="200" height="200">
  <h1>XEXAMAI</h1>
  <h3><strong>Your smart assistant for interviews and exams</strong></h3>
  <h3>⭐ <strong>Star this repository if it helped you!</strong> ⭐</h3>
</div>
<div align="center">
  <a href="https://github.com/Artasov/xexamai/releases/latest">
    <img src="https://img.shields.io/badge/Download-Latest%20Release-blue?style=for-the-badge&logo=github" alt="Download Latest Release">
  </a>
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
- **🎛️ Customizable transcription** - choose from multiple AI models and customize prompts
- **🌍 Multi-language support** - optimized prompts for different languages and contexts

### Если у вас есть проблемы с использованием открывайте [issue](https://github.com/Artasov/xexamai/issues)

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
Примеры ниже реализованы и протестированы для `Windows 11` для других систем процесс может отличаться.

Работа ассистента происходит в два этапа
1. Распознавание звука
2. Получение ответа от LLM

Каждый этап можно перевести на локальное использование. 

### Локальная LLM обработка

Минимально рекомендуемая конфигурация:
- CPU - 4 ядра 8 потоков 
- GPU - 6 VRAM
- RAM - 16 GB

1. 
   * Выберите в настройках `Transcription Mode` = `Local`
   * Выберите в настройках `Local Whisper Model` одну из доступных моделей
     * `gpt-oss:120b` `gpt-oss:20b` `gemma3:27b` `gemma3:12b` `gemma3:4b` `gemma3:1b` `deepseek-r1:8b` `qwen3-coder:30b` `qwen3:30b` `qwen3:8b` `qwen3:4b` 
       > Выберите слабую если у вас слабый пк
   * Выберите в настройках `Local Device`: `GPU`(Видеокарта/NVIDIA) или `CPU`(Процессор)

2. #### Скачать Ollama
   https://ollama.com/

3. #### Можно поменять дефолт расположение моделей (не обязательно)
   * Удалить оригинальный каталог models
     `Remove-Item -Recurse -Force "C:\Users\xl\.ollama\models"`
   * Затем создаёшь ссылку
     `New-Item -ItemType Junction -Path "C:\Users\xl\.ollama\models" -Target "F:\ollama_models\models"`
4. #### Скачивание модели которую мы выбрали ранее
   ```shell
   ollama pull qwen3:8b
   ```
5. #### Запуск Ollama на
   ```sh 
   ollama serve
   ```


### Локальное распознавание звука
1. Выберите в `xexamai` в настройках `LLM Model` одну из моделей.

2. ### Установить Cuda
   https://developer.nvidia.com/cuda-12-1-0-download-archive?target_os=Windows&target_arch=x86_64&target_version=11&target_type=exe_local

3. ### cuDNN 9.13.1
   https://developer.nvidia.com/cudnn-downloads?target_os=Windows&target_arch=x86_64&target_version=11&target_type=exe_local

4. ### В переменную path окружения windows вставить
   `C:\Program Files\NVIDIA\CUDNN\v9.13\bin\12.9` 

5. ### Установить [Python 3.12.5](https://www.python.org/downloads/release/python-3125/)
 
6. ### Перезапуск пк

7. ### Установить и запустить [fast-fast-whisper](https://github.com/Artasov/fast-fast-whisper)
   Само оно при запуске системы запускаться не будет, поэтому его нужно включать руками чтобы сервер локального распознавания звука работал


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

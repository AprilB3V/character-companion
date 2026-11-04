# Copy to local.ps1 (gitignored) and adjust; start.ps1 dot-sources it before resolving defaults.
# Every value can also be set as a normal environment variable instead.

# CharacterLife data folder: holds .env.video.local (model credentials) and data/jingjing-video/characterlife.db.
# $env:CHARACTERLIFE_DIR = 'D:\path\to\CharacterLife'

# Video cohost checkout; defaults to the vendor/CharacterLife-VideoCohost submodule.
# $env:JINGJING_COHOST_DIR = 'D:\path\to\CharacterLife-VideoCohost'

# Python environment with the speech dependencies from requirements-speech.txt, and the SenseVoice model folder.
# $env:JINGJING_ASR_PYTHON = 'D:\path\to\venv\Scripts\python.exe'
# $env:JINGJING_ASR_MODEL_DIR = 'D:\path\to\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'

# Game reader output, when Probably Stolen is not in the default Steam library.
# $env:JINGJING_GAME_STATE_PATH = 'D:\SteamLibrary\steamapps\common\Probably Stolen\Mods\JingjingWorldBridge\state.json'

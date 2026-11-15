# Run HeatMatch NYC

The repo includes the NYC demo data. You can run the demo without rebuilding the dataset or configuring either provider.

Install Python 3.12 or newer. To build or develop the website, install Node.js 22 or newer with npm. Open a terminal in the HeatMatch folder, the one containing `api`, `web`, and this guide.

## 1. Start the API

On Windows in PowerShell, create a virtual environment and install the API dependencies.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install fastapi uvicorn python-dotenv "anthropic>=0.86.0" httpx pandas openpyxl
if (!(Test-Path .env)) { Copy-Item .env.example .env }
.\.venv\Scripts\python.exe -m uvicorn api.main:app --port 8000 --env-file .env
```

On macOS or Linux, use these commands in the first terminal.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install fastapi uvicorn python-dotenv "anthropic>=0.86.0" httpx pandas openpyxl
test -f .env || cp .env.example .env
.venv/bin/python -m uvicorn api.main:app --port 8000 --env-file .env
```

Set `ANTHROPIC_API_KEY` in the root `.env` for Claude-powered search, bill extraction, and proposal drafting. Set `ANTHROPIC_WORKSPACE_ID` if your key requires a workspace header. With an empty key, HeatMatch uses keyword search, CSV import, and proposal templates. Restart the API after edits.

Set `HEATMATCH_DEMO_PASSWORD` in the same file with a strong, unique password and restart the API. In HeatMatch, click **Demo login** and enter that password to unlock the paid AI features for eight hours. Share the demo password with the people running the demo. Changing the password and restarting the API invalidates prior sessions. Public deployments should serve the site and its API on the same HTTPS origin.

## 2. Open the website

If `web/dist/index.html` already exists, open [HeatMatch at localhost:8000](http://127.0.0.1:8000). The API serves that build and handles the assistant on the same port.

If you are working on the website or have no build yet, open a second terminal in the HeatMatch folder, run the following, and open [HeatMatch at localhost:5173](http://localhost:5173).

```sh
cd web
npm ci
npm run dev
```

Run `npm run build` from `web` to create or refresh `web/dist`. Restart the API once the build is ready. If the provider features fail, check [the API health endpoint](http://127.0.0.1:8000/api/health).

Click **Demo estimates** or add `?demo=1` to the page URL for the higher-efficiency scenario. It assumes a heat-pump COP of 5 and 78.4% waste-heat capture at the same modeled heat delivery. The baseline uses COP 3.5 and 70% capture.

## Deploy on Render

Create a Render Web Service from this repo using the root `Dockerfile`, or connect `render.yaml` as a Blueprint. The service hosts the website and API on the same HTTPS origin. In the service's **Environment** settings set `HEATMATCH_DEMO_PASSWORD`, `ANTHROPIC_API_KEY`, and `ELEVENLABS_API_KEY`. Add `ANTHROPIC_WORKSPACE_ID` or `ELEVENLABS_VOICE_ID` if your keys require them.

Verify the service's temporary URL before attaching the custom domain. Check that `/api/health` returns HTTP 200, a signed-out request to `/api/assistant` returns HTTP 401, and demo sign-in unlocks a sample search. [Render Docker deployment](https://render.com/docs/docker) · [Render environments](https://render.com/docs/configure-environment-variables)

## 3. Enable ElevenLabs voice replies

1. Sign in to ElevenLabs. Open **Developers → API Keys**, create a restricted key, and enable **Text to Speech**. You can set a credit limit when creating the key. [ElevenLabs API key instructions](https://elevenlabs.io/docs/help-center/technical/how-do-i-authorize-myself-using-an-api-key)
2. Edit `.env` in the HeatMatch folder and set `ELEVENLABS_API_KEY` to the new key. Leave `ELEVENLABS_VOICE_ID` empty to use the built-in voice. For another voice, copy its voice ID from **My Voices** and set it there. Keep both provider keys in `.env`, which Git ignores.
3. Restart the API. Open **Ask** in HeatMatch and click **Read answers aloud** (the speaker button). Then type “Which data centers could heat Fulton Houses?” The reply appears in chat. Use the audio player if the browser blocks autoplay.

Voice playback is off when HeatMatch opens. When you enable it, HeatMatch sends reply text to ElevenLabs for audio, so even keyword-based replies can be spoken. If text appears but speech fails, check the key’s Text to Speech permission and available credits. If you set a custom voice, confirm the voice ID is available to your account. [ElevenLabs error guide](https://elevenlabs.io/docs/help-center/technical/api-error-code-400-or-401)

For a walkthrough with judges, a consistent voice can be worth enabling. For everyday map and proposal use, start with text. It avoids the extra provider request and the associated latency and credit use. Check ElevenLabs’ current plan terms if you publish the demo or use generated speech commercially. [ElevenLabs pricing](https://elevenlabs.io/pricing)

## 4. Enable local microphone input

Install Faster Whisper and download the English model once. From the HeatMatch folder on Windows, run:

```powershell
.\.venv\Scripts\python.exe -m pip install faster-whisper
.\.venv\Scripts\python.exe -c "from faster_whisper.utils import download_model; download_model('base.en', output_dir='.models/base.en')"
```

On macOS or Linux, use `.venv/bin/python` in both commands. Restart the API. Open **Ask**, click the microphone, allow access, and speak. Click the microphone again to stop. Review the transcript and click **Ask** to submit it. Audio is transcribed on your device. The submitted text goes to Claude when an Anthropic key is configured.

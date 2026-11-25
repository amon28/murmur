# Murmur

A small always-on-top window for talking, chatting and note taking. Everything runs on your own PC: no account, no
cloud (except web search, which uses Microsoft Edge).

## Install (for someone new)
1. Download **Murmur-Setup-x.y.z.exe** from [Releases](https://github.com/amon28/murmur/releases/latest) and run it. It installs for your user only (no admin needed) and adds a Desktop shortcut.
   Windows may show "Windows protected your PC" because the installer isn't signed: click **More info → Run anyway**.
2. On first start Murmur shows **Set up Murmur**. Click **Download**: about 6 GB of AI models. You can pause, and it
   resumes where it stopped. The memory model (330 MB) downloads by itself.
3. When the three dots in the title bar are green, it's ready.

**Needs:** Windows 10/11 64-bit, Microsoft Edge (already on every Windows PC), about 8 GB free disk. A graphics card
with ~6 GB video memory makes it fast (AMD, NVIDIA or Intel, through Vulkan); without one it still works, but slowly.

## Update
From 0.8.0 on, Murmur updates itself when an update address is set (see *Publishing an update*): a new version
downloads quietly and Murmur offers to restart. From 0.7.x: quit Murmur and run the new **Murmur Setup** over the old
one. It replaces the app in place, keeps the shortcut, and leaves notes, chats and settings untouched (they live in
`%APPDATA%\Murmur`, not in the app folder). After an update, Murmur shows what changed (also under ⓘ › What's new).

## Use
- 🎤 **Talk**: click, speak, pause → it is sent as a message.
- 📄 **Dictate** (`Ctrl+Alt+N`): keeps listening while you talk; *Save note* turns what you said into a written note:
  same ideas and details, filler words gone, grouped by topic. Your exact words stay under it (🎙 What you said).
- 📎 **Attach**: images (it can see them), PDFs, Word files, text and code. You can also drag files in or paste a screenshot.
- 🌐 **Web**: searches the web for that message. It also searches by itself when a question needs current information.
  Sources show as 🌐 links under the answer.
- Just talk: Murmur works out what you mean. "The gate code is 4417, I'll need it next week", a shopping list, or
  "save that" after a reply become notes (or are added to a note on the same topic); "ping me at 4 to…" sets a
  reminder; small talk and questions are left alone. "Get my tapsilog note"
  shows that note's content in the chat. Notes are recalled when they matter (📎 chips under the reply).
- Murmur remembers past conversations too: when something you say relates to an earlier talk ("my laptop is
  overheating again"), it brings that back (💬 chips, click to open that chat). "What did we talk about yesterday?" works.
- **Under each message:** copy, ✎ edit (sends it again as a new branch), ↻ regenerate a reply, 🔊 read aloud, save as
  note, 👍/👎, and the time. ‹ 2/3 › switches between versions. Every saved note has **Undo**.
- **Replies** can hold tables, lists, links, code (with Copy) and Mermaid diagrams; an HTML page gets **Preview**, opened
  in its own offline, sandboxed window. The ring by the status dots shows how full the conversation is.
- **/ commands:** type `/` for the list (`/new`, `/web`, `/note`, `/remind`, `/regen`, `/edit`, `/read`, `/think`, `/help`…).
  **Snippets** are your own prompts as `/name`: `{{text}}` is what follows the name (or the clipboard). Settings › Snippets.
- ☰ **Chats**: every conversation is kept; open, search, rename or delete old ones. `+` starts a new one.
- "Remind me tomorrow at 9 to call the plumber" sets a reminder: a Windows notification pops up at that time.
- ☰ **Notes**: search by meaning; filter by 📌 pinned, ⏰ reminders, #tags (write `#errands` in a note) or 🗑 Trash.
  In a note: `- [ ]` lines become tick boxes, 📌 pins it, ⏰ sets a reminder, ✨ adds a summary or a to-do list, and
  every change saves by itself. Deleted notes stay in Trash for 30 days; a copy of all notes is kept each day for the
  last 14 days in `backups`. Import .md, .txt, PDF or Word files; export everything as Markdown.
- ☰ **You**: Murmur learns as you talk. Every few messages, in a quiet moment, it notes facts about you (name, work,
  likes, how you like answers) and grows its own personality with you. 👍/👎 under a reply tell it what you like.
  You can read, edit, add or remove all of it, turn learning off, or start over. It never leaves your PC.
- ☰ **Settings**: models, mic, web search, hotkeys, Downloads. **Think before answering** lets Gemma reason first
  (💭 above the reply, click to read it): better on tricky questions, a second or two slower.
- 📷 **Ask about the screen** (`Ctrl+Alt+S`): drag a box around part of the screen; it is attached to your next message.
- **Type what I say** (`Ctrl+Alt+T`): talk, and each phrase is typed into the app in front. A red badge shows while it listens.
- **Tray:** closing the window keeps Murmur in the tray so reminders still come; right-click the icon to quit.
  Settings › Window › *Start with Windows* starts it hidden in the tray.
- `Ctrl+Alt+M` shows or hides the window. ⓘ in the menu shows the version, who made Murmur and how to reach them.

Your data (notes, chats, settings, models): `%APPDATA%\Murmur` (Settings › Open data folder). Uninstalling keeps it.

## What's inside
- Chat: llama.cpp `llama-server` (Vulkan build b9608) + Gemma 4 E4B QAT, MTP draft model and vision part. Any other GGUF,
  or any OpenAI-compatible server (LM Studio, Ollama, an online API), can be set in Settings.
- Speech: whisper.cpp `whisper-server` (Vulkan, built for any x64 CPU) + Whisper large-v3 turbo; Silero VAD v5
  (`bin\vad`, through onnxruntime-node) tells speech from noise. Whisper rests after 10 idle minutes to free video memory.
- Memory: EmbeddingGemma 2 (q8, text part only) through transformers.js.
- Web: Bing, Brave and Google through headless Edge (playwright-core), the top pages are read for the answer.

Models already on the PC (LM Studio, OBS LocalVocal) are used instead of downloading. Other folders can be named in
`%APPDATA%\Murmur\local-paths.json`: `{ "llamaDir": "…", "gemmaDir": "…", "whisperBuild": "…", "embedDir": "…" }`.

## Build
```
npm install
npm start          # run from source (first copies the chat's formatting libraries into renderer\vendor)
npm test           # unit tests (lib.js, vecstore.js)
npm run eval:intent -- --cpu   # scores the intent check on 60 labelled messages (starts its own model server)
npm run dist       # makes dist\Murmur-Setup-<version>.exe, latest.yml and the .blockmap
```
Before a release: bump `version` in package.json and add a `## <version> — <date>` section at the top of
CHANGELOG.md (the test checks that they match; the app shows that section after the update).

## Publishing an update
Set `updateUrl` in package.json to a folder on the web that will hold the release files, for example a GitHub
repository's `https://github.com/<owner>/<repo>/releases/latest/download/`. Build, then upload
`Murmur-Setup-<version>.exe`, its `.blockmap` and `latest.yml` from `dist` to that place (for GitHub: a new release with
those three files; `scripts\release.ps1` does that with the GitHub sign-in git already has). Installed copies check every 6 hours. Without `updateUrl` nothing is checked.
`bin\llama` and `bin\whisper` hold the bundled servers and the Microsoft C++ runtime they need; they are not in git.
Put the files of a llama.cpp Windows Vulkan x64 release (b9608) in `bin\llama` and a whisper.cpp Vulkan build of
`whisper-server` in `bin\whisper`, each with `msvcp140.dll`, `vcruntime140.dll` and `vcruntime140_1.dll`.
`bin\vad\silero_vad.onnx` (Silero VAD v5, MIT) is in git.

## License
MIT, see [LICENSE](LICENSE). The models and programs Murmur downloads or bundles keep their own licenses (listed in the app's About tab).

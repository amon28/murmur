# Changelog

## 0.8.1 — 2026-11-25
**New**
- **Settings in tabs:** Chat, Listening, Memory and App, instead of one long page. Save still saves all of them.

**Fixed**
- **Microphone:** if the mic picked in Settings is unplugged or Windows gave it a new ID, Murmur now uses the default mic and says so, instead of failing with "OverconstrainedError".
- The Microphone box in Settings shows "System default" instead of a blank when the saved mic is missing.
- Microphone problems are explained in plain words (no permission, no mic found, mic busy in another app), with what to do.

## 0.8.0 — 2026-11-25
**New**
- **Lives in the tray.** Closing the window keeps Murmur running, so reminders still come. Right-click the tray icon for Dictate, Ask about the screen, Type what I say, Start with Windows, and Quit.
- **Ask about the screen** (Ctrl+Alt+S or the 📷 button): drag a box around anything on screen and ask about it.
- **Type what I say** (Ctrl+Alt+T): talk, and your words are typed into whatever app is in front.
- **Better listening:** a small speech detector (Silero) tells your voice from fans, typing and music, and Whisper is told the names in your notes so it spells them right.
- **Automatic updates:** new versions download by themselves; you choose when to restart.
- **This window:** after each update it shows what changed. Open it any time from ⓘ › What's new.

**Faster and steadier**
- Replies start sooner: Murmur works out what a message is for and searches your notes at the same time.
- Long conversations stay fast: the history is trimmed in steps, not one message at a time.
- Files can no longer overflow the model: long ones are cut, and Murmur says how much it reads.
- The chat model and Whisper free their video memory when idle, and start again when needed.

**Fixed**
- Changing a model or its settings now really restarts it.
- Stop works right away, even before the reply has started.
- A stopped or failed reply is kept as far as it got, and never confuses the next one.
- Learning about you no longer skips messages.
- Chats and your profile are backed up every day too (not only notes), and a damaged file is restored from the newest backup.
- Downloads are checked against the published file hash.
- Web search can no longer be redirected to pages on your own network.
- The local chat server needs a password only Murmur knows, so other programs and web pages can't use it.

## 0.7.2 — 2026-11-25
- Faster replies: the chat model reuses what it already read instead of reading the whole conversation again.
- Side jobs (titles, learning) wait until a reply is done and never slow it down.
- A damaged notes file is set aside and restored from the newest backup instead of being lost.
- The memory index is smaller and saves faster.
- Deleting a chat deletes its attachments.
- "Remind me…" without a time now asks when, instead of guessing.
- A save makes one note, not extra ones nobody asked for.

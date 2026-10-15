# Kokoro Reader

Turn a PDF or EPUB into an audiobook with a natural-sounding voice, and listen on your phone or laptop.

1. **Add a book.** It's split into chapters and sentences and saved to your library.
2. **Prepare it.** Pick a voice (tap "Hear it" for a sample). The whole book is turned into audio **on the server**: you can close the app, and it keeps going. You can pause and continue it.
3. **Listen** on any device: play/pause, skip by sentence, seek, speed 0.8×–2×, lock-screen controls, and the sentence being read is highlighted. Where you stopped, and which books are finished, follows you between devices.

## How it works

Everything runs on GitHub, for free:

- **The app** is a static site on GitHub Pages (this repository).
- **The library** is a private repository, `audiobook-data`:
  - `library.json`: every book's status, position and finished state
  - `books/<id>.json`: each book's text, split into sentences
  - `audio/<id>/<part>` branches: one MP3 per chapter, plus the start time of each sentence
- **Preparing** runs the [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) voice model on GitHub Actions (`.github/workflows/prepare.yml`, `server/`). A book's chapters are split across up to 20 machines at once. Each machine makes audio about 2× faster than real time, so a 10-hour book takes roughly 20–30 minutes. Actions minutes are free for public repositories. The book's text and audio only ever live in the private library; the logs here show chapter numbers and timings, never titles or text.

**Background music** follows the story as it's read, and is mixed into the narration so it plays wherever the voice does:

- The server reads every sentence with an emotion model ([GoEmotions](https://huggingface.co/Cohee/distilbert-base-uncased-go-emotions-onnx), MIT), places it on the valence/arousal map music psychology uses, and marks where the mood changes: calm, reflective, melancholy, uplifting, tender, mysterious, suspense, dark or epic. A new mood has to hold for a few sentences, so the music follows scenes (`server/moods.mjs`).
- For each mood the book has, [MusicGen](https://huggingface.co/Xenova/musicgen-small) composes two 30-second pieces, made to loop seamlessly (`server/music.mjs`). MusicGen's weights are CC BY-NC 4.0: fine for personal listening, not for selling the music.
- Each chapter is then mixed (`server/mix.mjs`): the mood's music under the voice, dipping while the narrator speaks, rising in pauses and crossfading at mood changes, at five levels the listener picks from (Faint, Soft, Medium, Strong, Full; about 24 to 5 dB under the voice). Each level is its own file next to the plain narration.
- Books without server music get ambient music composed live in the browser (`src/music.js`).

The app talks to both repositories with one fine-grained access token, the "library key".

## One-time setup

1. Create a **private** repository named `audiobook-data` (tick "Add a README file").
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   - Repository access → Only select repositories → `audiobook-data` and this app's repository
   - Permissions → **Contents**: Read and write, **Actions**: Read and write
3. In this repository: Settings → Secrets and variables → Actions → New repository secret, named `LIBRARY_KEY`, containing the token.
4. Open the site and paste the token as your library key. On other devices, use ⚙︎ → "Copy link for another device".

## Develop

    npm install
    npm run dev                      # the app, at http://localhost:5173
    MOCK_VOICE=1 node server/prepare.mjs plan   # the server side (see the comments in server/prepare.mjs)

Locally the app can't guess the repositories from its address, so fill them in under "Advanced" on the connect screen.

## Credits

- Voice: [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0) via [kokoro-js](https://github.com/hexgrad/kokoro).
- `public/words-en.txt`, used to put spaces back into words some PDFs run together: the English word-frequency list from [wordninja](https://github.com/keredson/wordninja) / [wordsninja](https://github.com/parsakafi/wordsninja) (MIT).

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

**Background music** (♫ in the player) follows the mood of each chapter:

- While a book is prepared, the server reads every chapter with an emotion model ([GoEmotions](https://huggingface.co/Cohee/distilbert-base-uncased-go-emotions-onnx), MIT), places it on the valence/arousal map music psychology uses, and picks one of nine moods: calm, reflective, melancholy, uplifting, tender, mysterious, suspense, dark, epic (`server/moods.mjs`).
- For each mood the book has, [MusicGen](https://huggingface.co/Xenova/musicgen-small) composes a 30-second piece on its own machine, made to loop seamlessly (`server/music.mjs`). MusicGen's weights are CC BY-NC 4.0: fine for personal listening, not for selling the music.
- Until (or unless) a book has composed music, the app composes ambient music live in the browser with the Web Audio API (`src/music.js`), with moods guessed from the chapter's words (`src/mood.js`). Books prepared before music existed get a "Compose music for this book" button.

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

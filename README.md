# Kokoro Reader

Turn a PDF or EPUB into an audiobook with a natural-sounding voice, then listen to it on your phone or laptop.

1. **Add a book.** The text is split into chapters and sentences.
2. **Prepare it.** Choose a voice (you can hear a sample first), then the whole book is turned into audio with [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), an open-source voice model that runs in your browser. You can pause and continue any time, even after closing the page.
3. **Listen.** Once it's ready it plays like an audiobook: play/pause, skip by sentence, a seek bar, speed from 0.8× to 2×, and lock-screen controls. Each sentence is highlighted as it's read; tap any sentence to jump to it.

## Where things are kept

- **The app** is a static site hosted free on GitHub Pages. The voice model is published with the site (downloaded at build time by `scripts/fetch-model.mjs`), so it loads from your own site rather than Hugging Face. The browser keeps it after the first load.
- **Books and audio** are stored in the browser on each device (IndexedDB). About 86 MB per hour of listening.
- **Sync (optional).** To see the same library on every device (which books you have, how far you've got, which are finished, and how far each device has got preparing them), connect a private GitHub repository under "Sync your library between devices". The app saves `library.json` and each book's text there with a fine-grained token you create. Audio isn't synced because it's too big for git.
- **Moving audio between devices.** In the player's ⋯ menu, "Save audiobook file" downloads a `.audiobook` file. Open it with "Add a book" on another device and it's ready to play straight away. This is handy for preparing on a fast laptop and listening on a phone.

## How long preparing takes

It depends on the device. A laptop on "Graphics card" is usually many times faster than real time. A phone on CPU may take about as long as the book itself, and the page has to stay open (the app keeps the screen on while it works).

GPU mode uses the full-precision model, which isn't bundled by default (it's ~330 MB). It's fetched from Hugging Face the first time, or you can bundle it with `node scripts/fetch-model.mjs --gpu`.

## Develop

    npm install
    npm run dev          # http://localhost:5173
    npm run build        # static site in dist/

Add `?mock` to the URL to use a test tone instead of the real voice, for trying the app without the model.

## Deploy

Pushing to `main` builds and deploys to GitHub Pages (`.github/workflows/pages.yml`; set Settings → Pages → Source to "GitHub Actions"). The site appears at `https://<user>.github.io/<repo>/`.

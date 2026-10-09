# Book Reader

Open a PDF or EPUB in the browser and listen to it like an audiobook.

- Voice: [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), an open-source TTS model that runs entirely in the browser (WebGPU when available, otherwise WebAssembly). The model downloads once and is cached. The browser's built-in voices are the fallback.
- Books and reading position are stored on the device (IndexedDB / localStorage). Nothing is uploaded.
- No server: the build is a static site, so it can be hosted free on Cloudflare Pages or GitHub Pages.

## Develop

    npm install
    npm run dev

## Deploy

- Cloudflare Pages: `npm run build`, then upload the `dist` folder (Workers & Pages → Create → Pages → Upload assets), or connect the repo with build command `npm run build` and output `dist`.
- GitHub Pages: push to `main`; `.github/workflows/pages.yml` builds and deploys (set Pages source to "GitHub Actions").

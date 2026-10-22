# Ilm

Download every file from a Google Classroom class in one click. Original formats, no zip, saved to your device.

Chrome, Edge, Brave, Opera and Firefox, on Windows, macOS and Linux.

## Install

1. Download `ilm.zip` from the [latest release](https://github.com/Muqeeth47/classroom-extension/releases/latest) and unzip it.
2. **Chrome / Edge / Brave / Opera:** open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, pick the unzipped folder.
3. **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, pick `manifest.json`, then press **Allow access** in the popup.

## Use

Open a class in Google Classroom, go to **Classwork**, click Ilm, press **Find files in this class**, then **Download**. Files land in `Downloads/Classroom/<class>/`.

- Uploaded files are saved exactly as they are. Google Docs, Slides and Sheets are exported as PDF or Word / PowerPoint / Excel (your choice).
- Drive folders attached to posts are opened too.
- Files with downloading disabled by their owner are skipped, not bypassed.
- It runs in your browser with your own login and collects nothing.

## Develop

TypeScript + esbuild + Vitest.

```
npm install
npm run check     # typecheck, tests, build, manifest lint
npm run build     # src/ -> dist/ (load dist/ as the unpacked extension)
npm run package   # web-ext-artifacts/ilm.zip
```

Pushing a version tag makes GitHub Actions build the zip and attach it to a release. The website is plain HTML/CSS in `docs/`.

## Contact

Want to contribute or reach out? Get in touch:

muqeethshaikabdul@gmail.com, 9014249493

MIT licence. Not affiliated with or endorsed by Google. Website set in [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (SIL OFL).

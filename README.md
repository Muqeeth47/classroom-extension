# Ilm

Download every file from a Google Classroom class in one click. Original formats, no zip, saved to your device.

Chrome, Edge, Brave, Opera and Firefox, on Windows, macOS and Linux.

## Install

1. Download `ilm.zip` from the [latest release](https://github.com/Muqeeth47/classroom-extension/releases/latest) and unzip it.
2. **Chrome / Edge / Brave / Opera:** open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, pick the unzipped folder.
3. **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, pick `manifest.json`, then press **Allow access** in the popup.

## Use

Open the announcement or post whose files you want, click Ilm, press **Get files from this post**, then **Download**. Files land in `Downloads/Classroom/<name>/`.

To save everything posted in a class (announcements, assignments and materials), open the class on its Stream or Classwork tab and press **Get files from this class**. It only ever reads that one class.

- Uploaded files are saved exactly as they are. Google Docs, Slides and Sheets are exported as PDF or Word / PowerPoint / Excel (your choice).
- Drive folders attached to posts are opened too.
- Files with downloading disabled by their owner are skipped, not bypassed.
- It runs in your browser with your own login and collects nothing. See the [privacy page](https://getilm.vercel.app/privacy.html).

## Develop

TypeScript + esbuild + Vitest.

```
npm install
npm run check     # typecheck, tests, build, manifest lint
npm run build     # src/ -> dist/ (load dist/ as the unpacked extension)
npm run package   # web-ext-artifacts/ilm.zip
```

Pushing a version tag makes GitHub Actions build the zip and attach it to a release. The website is plain HTML/CSS in `docs/`.

## Debug

- **Popup:** right-click the Ilm icon, then **Inspect popup**. The popup also has an **Activity log**.
- **Background worker:** `chrome://extensions` > Ilm > **service worker** (Firefox: `about:debugging` > Inspect). In its console, `await chrome.storage.session.get('state')` shows the current state.
- **Scanner:** open DevTools on the Classroom tab; its logs are in that tab's console.
- After editing, run `npm run build` (or `npm run build -- --watch`) and click the reload icon on the extension's card. Installed copies do not update by themselves; download the new zip or reload the unpacked folder.

## Contact

Want to contribute or reach out? Get in touch:

muqeethshaikabdul@gmail.com, 9014249493

MIT licence. Not affiliated with or endorsed by Google. Website set in [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (SIL OFL).

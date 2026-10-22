# Classroom Bulk Downloader

Download every file attached to a Google Classroom class in one click, in its original format. No zip files.

- Saves to your computer's `Downloads/Classroom/<class>/<topic>/` folder, not to Google Drive.
- Works on Chrome, Edge, Brave, Opera and Firefox, on Windows, macOS and Linux.
- Uploaded PDFs, Word, PowerPoint, Excel, images and other files are saved exactly as they are. Google Docs, Slides and Sheets are exported as PDF or Word / PowerPoint / Excel (your choice).
- Opens Drive folders attached to posts and downloads what's inside.
- No account, no API key, no tracking. It runs in your browser with your own Google login.

Website and manual: https://muqeeth47.github.io/classroom-extension/

## Install

1. Download this repository as a ZIP and unzip it.
2. **Chrome / Edge / Brave / Opera:** open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and choose the folder that contains `manifest.json`.
3. **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and choose `manifest.json`. Press **Allow access** in the popup. Firefox removes temporary add-ons on restart.

## Use

1. Open a class in Google Classroom and go to its **Classwork** tab.
2. Click the extension, then **Find files in this class**.
3. Untick anything you don't want, then **Download**.

## Limits

- If a file's owner disabled downloading, or you have no access, it is reported as failed. It is not bypassed.
- Classroom's page layout is not a public interface. If Google changes it, scanning may break; the popup's activity log helps diagnose it.
- School admins can block extensions or Drive downloads.
- Safari is not supported yet (it needs a Mac and Xcode to convert).
- Topic folders are best-effort. Turn off "Sort into topic folders" if they come out wrong.

## Develop

```
npm test        # unit + end-to-end tests (no dependencies)
```

- `manifest.json`: one Manifest V3 file for all browsers
- `content.js`: runs on Classroom, scrolls and lists the posts
- `background.js`: reads each post, expands Drive folders, runs downloads
- `lib.js`: link detection, URLs and file naming
- `popup.*`: the UI
- `docs/`: the website (GitHub Pages)
- `tests/ui-harness.html`: view the popup against a fake browser API at any width

After editing, reload the extension on `chrome://extensions`.

## Contact

muqeethshaikabdul@gmail.com, 9014249493

## Licence

MIT. Not affiliated with or endorsed by Google.

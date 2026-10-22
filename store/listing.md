# Store listings (Chrome Web Store, Edge Add-ons, Firefox Add-ons)

Copy these into the store forms. Keep them in sync with `public/manifest.json`.

## Name (max 45)
Ilm - Classroom File Downloader

## Summary (max 132)
Download all PDFs, documents and attachments from a Google Classroom post or class in one click. Original formats, no zip.

## Category
Education (Chrome / Edge) - Firefox: Other / Education

## Detailed description
Download every file attached to a Google Classroom announcement, assignment or material in one click, in its original format. No zip files, no account, no tracking.

HOW IT WORKS
1. Open the announcement or post whose files you want in Google Classroom.
2. Click Ilm and press "Get files from this post".
3. Untick anything you don't want, then press Download.
Your files are saved to your Downloads folder under Classroom/. To save a whole class at once, open its Classwork tab instead.

WHAT YOU GET
- Original files: PDFs, Word, PowerPoint, Excel, images and more are saved exactly as they were uploaded.
- Google Docs, Slides and Sheets are exported as PDF or as Word / PowerPoint / Excel, your choice.
- Drive folders attached to a post are opened and their files downloaded too.
- Neat folders: sorted by class, and by topic when you download a whole class.
- Works with a second Google account (the one Classroom is open under).
- Files whose owner turned off downloading are listed as skipped. They are never bypassed.

PRIVATE BY DESIGN
Ilm runs in your browser with your own Google login. It collects nothing, has no server, and sends nothing anywhere except to Google to fetch your own files. Free and open source.

Works on desktop Chrome, Edge, Brave, Opera and Firefox (Windows, macOS, Linux).

Not affiliated with or endorsed by Google. Google Classroom and Google Drive are trademarks of Google LLC.

Source: https://github.com/Muqeeth47/classroom-extension
Privacy: https://ilm-xi.vercel.app/privacy.html
Contact: muqeethshaikabdul@gmail.com

## Single purpose (Chrome Web Store)
Download the files attached to a Google Classroom post or class to the user's device.

## Permission justifications
- `downloads`: saves the files the user selects into their Downloads folder.
- `scripting`: reads the attachment links on the Classroom page the user has open (and opens posts in a background tab when a whole class is scanned).
- `storage`: keeps progress while the popup is closed, and the user's choices (PDF or Office export, topic folders).
- Host access to `classroom.google.com`: to read the open class or post.
- Host access to `*.google.com` and `*.googleusercontent.com`: to fetch the user's own files from Google Drive and Docs, including their redirects (sign-in checks, download hosts).
- No remote code. No analytics. No data leaves the browser.

## Data usage disclosure (Chrome Web Store privacy tab)
- Collects no user data. Reads page content on classroom.google.com locally only to find attachments.
- Does not sell data, use it for unrelated purposes, or use it for creditworthiness or lending.
- Privacy policy URL: https://ilm-xi.vercel.app/privacy.html

## Firefox Add-ons notes
- Data collection permissions: none required (declared in the manifest).
- The code is bundled by esbuild, so AMO asks for the source: upload the repository zip and the build steps are `npm install` then `npm run package`.

## Assets needed
- Icon 128x128: `public/icons/icon128.png`
- Screenshots 1280x800 (up to 5): the popup on a post, the file list, the finished screen. Take them from a real Classroom page (blur names if needed).
- Small promo tile 440x280 (optional): the same black "ilm." card as `docs/og.png`.

## Getting found in store search
Store search ranks mainly on the name and summary text, then installs, ratings and how many people keep it. Ilm's name and summary already contain the phrases people search for ("Classroom", "File Downloader", "PDFs", "attachments", "download all"). Beyond that, rank comes from real use: ask classmates to install it and leave an honest rating. No one can guarantee first place.

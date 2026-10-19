# Label Broadcast for WhatsApp

Send one personalized message, file, or forwarded message to a whole WhatsApp contact group (list/label) without picking people one by one.

There are two ways to run it:

- **Browser extension (recommended)** — runs inside your own WhatsApp Web tab. Your session stays in your browser, survives refresh, and there is no server to host.
- **Local server** — a small Node app that drives its own headless Chrome and shows a web UI on `127.0.0.1:3210`.

> ⚠️ Mass/automated messaging is against WhatsApp's Terms of Service and can get your number banned. Use small batches, long delays, and only message people who expect it. Use at your own risk.

## Browser extension

Requirements: Chrome/Edge 111+.

1. Build the bundled assets (only needed after a fresh clone or editing `extension/panel.css`):

   ```bash
   npm install
   npm run build:extension
   ```

2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
3. Open `https://web.whatsapp.com` and refresh the page. Log in as usual.
4. Click the green **LB** button in the bottom-right corner.

Notes:

- The **Groups** tab lists your WhatsApp lists/labels that actually have members. If you have none, use **Contacts** or **Numbers**.
- **Compose** sends text and/or one file (image, video, audio, or document) with the text as caption.
- **Forward a message** lets you pick a chat and one recent message to forward to every selected recipient.
- Files are sent directly from your browser; nothing is uploaded anywhere.
- The panel only appears on `web.whatsapp.com`, and only after the tab is (re)loaded after installing the extension.

## Local server

Requirements: Node 18+ and a Chrome/Edge install.

```bash
npm install
npm start
```

Then open `http://127.0.0.1:3210` and scan the QR code with your phone. Set `HEADLESS=false` to watch the browser, or `PORT`/`CHROME_PATH` to override defaults. The linked session is stored in `data/session` and campaign history in `data/history.log`.

## Project layout

```
extension/        Chrome extension (manifest.json, app.js, panel.css, bundled wa-js)
public/           Local server web UI
server.js         Local server (Express + playwright-core + wa-js)
scripts/          build-extension.js
```

## How it works

Both modes talk to WhatsApp Web through [`@wppconnect/wa-js`], which is injected into the page and reuses WhatsApp's own webpack modules. The extension injects it in the page's main world as content scripts; the server injects it into a Playwright-controlled Chrome.

## Attribution

Bundles the Apache-2.0 licensed `@wppconnect/wa-js` distribution.

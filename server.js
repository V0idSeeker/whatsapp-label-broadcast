const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { chromium } = require('playwright-core');

const PORT = Number(process.env.PORT) || 3210;
const HOST = '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'session');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const HISTORY_FILE = path.join(DATA_DIR, 'history.log');
const WAJS_PATH = require.resolve('@wppconnect/wa-js');

const WHATSAPP_URL = 'https://web.whatsapp.com/';
const MAX_RECIPIENTS = 300;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_CAPTION_LENGTH = 1024;
const MAX_FILE_SIZE = 64 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploads = new Map();

function kindForMime(mime) {
  if (/^image\//i.test(mime)) return 'image';
  if (/^video\//i.test(mime)) return 'video';
  if (/^audio\//i.test(mime)) return 'audio';
  return 'document';
}

function cleanupUpload(token) {
  const item = uploads.get(token);
  if (!item) return;
  uploads.delete(token);
  fs.unlink(item.path, () => {});
}

function cleanupStaleUploads() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [token, item] of uploads) {
    if (item.createdAt < cutoff) cleanupUpload(token);
  }
}

setInterval(cleanupStaleUploads, 60 * 60 * 1000).unref();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let context = null;
let page = null;
let state = 'starting';
let qrDataUrl = null;
let lastError = null;
let starting = false;
let statusTimer = null;

const jobs = new Map();

function isReady() {
  return state === 'ready' && page;
}

async function evaluate(fn, arg) {
  return page.evaluate(fn, arg);
}

async function injectWaJs() {
  const status = await page
    .evaluate(() => ({ has: Boolean(window.WPP), ready: Boolean(window.WPP && window.WPP.isReady) }))
    .catch(() => ({ has: false, ready: false }));
  if (status.ready) return true;
  if (!status.has) {
    await page.addScriptTag({ path: WAJS_PATH }).catch(() => {});
  }
  return false;
}

async function waitForWaJs(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await injectWaJs()) return true;
    } catch (_) {
      /* page may be navigating */
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for WhatsApp Web to load.');
}

function renderMessage(template, name, spin) {
  let out = String(template).replace(/\{\{\s*name\s*\}\}/gi, name || 'there');
  if (spin) {
    out = out.replace(/\{([^{}]+)\}/g, (_match, group) => {
      const options = group.split('|').map((s) => s.trim()).filter(Boolean);
      if (!options.length) return _match;
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return out;
}

function isDirectChatId(id) {
  return typeof id === 'string' && /@(c\.us|lid)$/.test(id);
}

function normalizeNumber(raw) {
  return String(raw || '').replace(/[^\d]/g, '');
}

async function readStatus() {
  if (!page) return { ready: false, authenticated: false, userId: '', injected: false };
  return evaluate(() => {
    const W = window.WPP;
    if (!W || !W.isReady) return { ready: false, authenticated: false, userId: '', injected: Boolean(W) };
    let authenticated = false;
    let userId = '';
    try {
      authenticated = Boolean(W.conn.isAuthenticated());
      userId = String(W.conn.getMyUserId() || '');
    } catch (_) {
      /* conn not booted yet */
    }
    return { ready: authenticated && Boolean(userId), authenticated, userId, injected: true };
  }).catch(() => ({ ready: false, authenticated: false, userId: '', injected: false }));
}

async function getAuthCode() {
  if (!page) return null;
  try {
    return await evaluate(async () => {
      const W = window.WPP;
      if (!W || !W.isReady) return null;
      const code = await W.conn.getAuthCode();
      return code && code.fullCode ? code.fullCode : null;
    });
  } catch (_) {
    return null;
  }
}

let lastQrCode = null;

async function pollStatus() {
  if (!page) {
    state = 'starting';
    return;
  }
  try {
    const status = await readStatus();

    if (status.ready) {
      const wasReady = state === 'ready';
      state = 'ready';
      qrDataUrl = null;
      lastQrCode = null;
      lastError = null;
      if (!wasReady) await loadMe();
      return;
    }

    if (!status.injected) {
      state = 'starting';
      await injectWaJs();
      return;
    }

    if (status.authenticated) {
      state = 'authenticated';
      qrDataUrl = null;
      lastQrCode = null;
      return;
    }

    const code = await getAuthCode();
    if (code) {
      if (code !== lastQrCode) {
        lastQrCode = code;
        qrDataUrl = await QRCode.toDataURL(code, { margin: 1, width: 340, errorCorrectionLevel: 'L' });
      }
      state = 'qr';
    } else {
      state = 'starting';
    }
  } catch (err) {
    lastError = err?.message || String(err);
  }
}

async function launch() {
  const executablePath = findBrowser();
  const launchOptions = {
    headless: process.env.HEADLESS !== 'false',
    bypassCSP: true,
    viewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  context = await chromium.launchPersistentContext(SESSION_DIR, launchOptions);
  context.on('close', () => {
    if (state !== 'stopping') {
      state = 'disconnected';
      lastError = 'Browser window closed. Click Restart to reconnect.';
    }
  });

  const pages = context.pages();
  page = pages.length ? pages[0] : await context.newPage();

  page.on('close', () => {
    if (state !== 'stopping' && context) {
      state = 'disconnected';
      lastError = 'WhatsApp tab was closed. Click Restart to reconnect.';
    }
  });

  page.on('crash', () => {
    state = 'error';
    lastError = 'The WhatsApp tab crashed. Click Restart to reconnect.';
  });

  page.on('load', () => {
    injectWaJs().catch(() => {});
  });

  await page.goto(WHATSAPP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitForWaJs();

  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    pollStatus().catch(() => {});
  }, 2000);
  await pollStatus();
  console.log('[whatsapp] browser started');
}

async function startClient() {
  if (starting) return;
  starting = true;
  state = 'starting';
  lastError = null;
  qrDataUrl = null;
  lastQrCode = null;
  try {
    await launch();
  } catch (err) {
    state = 'error';
    lastError = err?.message || String(err);
    console.error('[whatsapp] launch failed:', lastError);
  } finally {
    starting = false;
  }
}

async function stopClient() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  const ctx = context;
  context = null;
  page = null;
  if (ctx) {
    try {
      await ctx.close();
    } catch (_) {
      /* ignore */
    }
  }
}

async function restartClient() {
  await stopClient();
  await startClient();
}

function requireReady(res) {
  if (!isReady()) {
    res.status(409).json({ error: 'WhatsApp is not connected yet. Scan the QR code first.' });
    return false;
  }
  return true;
}

function requireLocalRequest(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-app-request'] !== '1') {
    return res.status(403).json({ error: 'Missing app request header.' });
  }
  next();
}

app.use('/api', requireLocalRequest);

app.get('/api/status', (_req, res) => {
  res.json({
    state,
    qr: state === 'qr' ? qrDataUrl : null,
    error: lastError,
    me: state === 'ready' && page ? me : null,
  });
});

let me = null;

async function loadMe() {
  try {
    me = await evaluate(() => {
      const W = window.WPP;
      const wid = W.conn.getMyUserId();
      const contact = wid ? W.contact.get(wid) : null;
      return {
        name: (contact && (contact.name || contact.pushname)) || '',
        number: wid ? String(wid.user || '') : '',
      };
    });
  } catch (_) {
    me = null;
  }
}

app.post('/api/restart', (_req, res) => {
  res.json({ ok: true });
  restartClient();
});

app.post('/api/logout', async (_req, res) => {
  if (!page) return res.status(409).json({ error: 'No active session.' });
  try {
    await evaluate(async () => {
      await window.WPP.conn.logout();
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  me = null;
  await restartClient();
  res.json({ ok: true });
});

async function listGroups() {
  return evaluate(async () => {
    const W = window.WPP;
    const out = [];
    const seen = new Set();

    let lists = [];
    try {
      lists = W.lists.list() || [];
    } catch (_) {
      lists = [];
    }

    for (const list of lists) {
      let chats = [];
      try {
        chats = await W.chat.list({ withLabels: [String(list.id)], onlyUsers: true });
      } catch (_) {
        chats = [];
      }
      const id = String(list.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: list.name || 'Unnamed list',
        kind: 'list',
        color: list.hexColor || null,
        count: chats.length,
      });
    }

    let labels = [];
    try {
      labels = (await W.labels.getAllLabels()) || [];
    } catch (_) {
      labels = [];
    }

    for (const label of labels) {
      const id = String(label.id);
      if (seen.has(id)) continue;
      let chats = [];
      try {
        chats = await W.chat.list({ withLabels: [id], onlyUsers: true });
      } catch (_) {
        chats = [];
      }
      seen.add(id);
      out.push({
        id,
        name: label.name || 'Unnamed label',
        kind: 'label',
        color: label.hexColor || null,
        count: chats.length,
      });
    }

    out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { groups: out };
  });
}

app.get('/api/labels', async (_req, res, next) => {
  if (!requireReady(res)) return;
  try {
    const { groups } = await listGroups();
    res.json({ labels: groups, groups });
  } catch (err) {
    next(err);
  }
});

async function loadContactsForGroup(groupId) {
  return evaluate(async (id) => {
    const W = window.WPP;
    const meWid = W.conn.getMyUserId();
    const meStr = meWid ? String(meWid._serialized || meWid) : '';

    let chats = [];
    try {
      chats = await W.chat.list({ withLabels: [String(id)], onlyUsers: true });
    } catch (_) {
      chats = [];
    }

    const seen = new Set();
    const out = [];
    for (const chat of chats) {
      const cid = String((chat.id && (chat.id._serialized || chat.id)) || '');
      if (!cid || cid === meStr || seen.has(cid)) continue;
      seen.add(cid);
      const contact = chat.contact || {};
      const name =
        chat.name ||
        chat.formattedTitle ||
        contact.name ||
        contact.pushname ||
        contact.shortName ||
        (chat.id && chat.id.user) ||
        cid;
      out.push({ id: cid, name: String(name), number: String((chat.id && chat.id.user) || '') });
    }

    if (!out.length) {
      const contacts = await W.contact.list({ withLabels: [String(id)], onlyMyContacts: false }).catch(() => []);
      for (const contact of contacts) {
        const cid = String((contact.id && (contact.id._serialized || contact.id)) || '');
        if (!cid || cid === meStr || seen.has(cid) || !/@(c\.us|lid)$/.test(cid)) continue;
        seen.add(cid);
        out.push({
          id: cid,
          name: String(contact.name || contact.pushname || contact.shortName || (contact.id && contact.id.user) || cid),
          number: String((contact.id && contact.id.user) || ''),
        });
      }
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, groupId);
}

app.get('/api/labels/:id/contacts', async (req, res, next) => {
  if (!requireReady(res)) return;
  try {
    const contacts = await loadContactsForGroup(req.params.id);
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

app.get('/api/contacts', async (_req, res, next) => {
  if (!requireReady(res)) return;
  try {
    const contacts = await evaluate(async () => {
      const W = window.WPP;
      const meWid = W.conn.getMyUserId();
      const meStr = meWid ? String(meWid._serialized || meWid) : '';
      const list = await W.contact.list({ onlyMyContacts: true });
      const seen = new Set();
      const out = [];
      for (const contact of list) {
        const id = String((contact.id && (contact.id._serialized || contact.id)) || '');
        if (!id || id === meStr || seen.has(id) || !/@(c\.us|lid)$/.test(id)) continue;
        seen.add(id);
        out.push({
          id,
          name: String(contact.name || contact.pushname || contact.shortName || (contact.id && contact.id.user) || id),
          number: String((contact.id && contact.id.user) || ''),
        });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    });
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_FILE_SIZE },
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `File is too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB).`
          : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const mimetype = req.file.mimetype || 'application/octet-stream';
    const token = crypto.randomUUID();
    uploads.set(token, {
      path: req.file.path,
      name: req.file.originalname || 'file',
      mime: mimetype,
      size: req.file.size,
      kind: kindForMime(mimetype),
      createdAt: Date.now(),
    });

    res.json({
      token,
      name: req.file.originalname || 'file',
      size: req.file.size,
      mime: mimetype,
      kind: kindForMime(mimetype),
    });
  });
});

app.delete('/api/upload/:token', (req, res) => {
  if (!uploads.has(req.params.token)) return res.status(404).json({ error: 'Upload not found.' });
  cleanupUpload(req.params.token);
  res.json({ ok: true });
});

async function listForwardChats(search) {
  return evaluate(async (query) => {
    const W = window.WPP;
    const chats = await W.chat.list({ count: 100 });
    const q = String(query || '').trim().toLowerCase();
    const seen = new Set();
    const out = [];

    for (const chat of chats) {
      const id = String((chat.id && (chat.id._serialized || chat.id)) || '');
      if (!id || seen.has(id) || !/@(c\.us|lid|g\.us)$/.test(id)) continue;
      const name = String(
        chat.name ||
          chat.formattedTitle ||
          (chat.contact && (chat.contact.name || chat.contact.pushname)) ||
          (chat.id && chat.id.user) ||
          id
      );
      if (q && !name.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) continue;
      seen.add(id);
      out.push({
        id,
        name,
        isGroup: id.endsWith('@g.us'),
        number: String((chat.id && chat.id.user) || ''),
      });
      if (out.length >= 80) break;
    }
    return out;
  }, search || '');
}

app.get('/api/chats', async (req, res, next) => {
  if (!requireReady(res)) return;
  try {
    const chats = await listForwardChats(req.query.search);
    res.json({ chats });
  } catch (err) {
    next(err);
  }
});

app.get('/api/chats/:id/messages', async (req, res, next) => {
  if (!requireReady(res)) return;
  try {
    const messages = await evaluate(async (chatId) => {
      const W = window.WPP;
      const raw = await W.chat.getMessages(chatId, { count: 30 });
      const out = [];
      for (const msg of raw) {
        const id = String((msg.id && (msg.id._serialized || msg.id)) || '');
        if (!id) continue;
        const type = String(msg.type || '');
        const body = String(msg.caption || msg.body || '').replace(/\s+/g, ' ').trim();
        const filename = msg.filename ? String(msg.filename) : '';
        out.push({
          id,
          type,
          text: body.slice(0, 400) || (msg.isMedia ? `[${type || 'media'}]` : ''),
          filename,
          mimetype: msg.mimetype ? String(msg.mimetype) : '',
          fromMe: Boolean(msg.id && msg.id.fromMe),
          timestamp: Number(msg.t || 0),
          isMedia: Boolean(msg.isMedia),
        });
      }
      out.sort((a, b) => b.timestamp - a.timestamp);
      return out;
    }, req.params.id);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

app.post('/api/resolve', async (req, res, next) => {
  if (!requireReady(res)) return;
  const raw = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
  if (!raw.length) return res.status(400).json({ error: 'No numbers provided.' });
  if (raw.length > MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Too many numbers. Limit is ${MAX_RECIPIENTS} per batch.` });
  }

  try {
    const result = await evaluate(async (entries) => {
      const W = window.WPP;
      const resolved = [];
      const failed = [];
      for (const entry of entries) {
        const line = String(entry || '').trim();
        if (!line) continue;
        const match = line.match(/\+?\d[\d\s().-]{5,}/);
        const number = String(match ? match[0] : line).replace(/[^\d]/g, '');
        if (!number || number.length < 7) {
          failed.push({ input: line, reason: 'Not a valid phone number' });
          continue;
        }
        try {
          const info = await W.contact.queryWidExists(`${number}@c.us`);
          if (!info || !info.wid) {
            failed.push({ input: line, reason: 'Not registered on WhatsApp (include country code)' });
            continue;
          }
          const wid = info.wid;
          const id = String(wid._serialized || wid);
          const contact = await W.contact.get(wid).catch(() => null);
          const label = match ? line.replace(match[0], '').replace(/[,;|\t]+/g, ' ').trim() : '';
          resolved.push({
            id,
            name: label || (contact && (contact.name || contact.pushname || contact.shortName)) || `+${number}`,
            number: String(wid.user || number),
          });
        } catch (err) {
          failed.push({ input: line, reason: err?.message || String(err) });
        }
      }
      return { resolved, failed };
    }, raw);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    total: job.total,
    done: job.done,
    sent: job.sent,
    simulated: job.simulated,
    failed: job.failed,
    skipped: job.skipped,
    dryRun: job.dryRun,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    results: job.results,
  };
}

async function cancellableSleep(ms, job) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (job && job.cancelled) return false;
    await sleep(Math.min(400, end - Date.now()));
  }
  return true;
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();

  for (let i = 0; i < job.targets.length; i += 1) {
    if (job.cancelled) break;
    const target = job.targets[i];
    const entry = job.results[i];
    entry.status = 'sending';

    try {
      if (!job.dryRun && job.mode !== 'forward') {
        try {
          await evaluate((id) => window.WPP.chat.markIsComposing(id, 6000), target.id);
        } catch (_) {
          /* typing indicator is best effort */
        }
        const typingTime = 1400 + Math.random() * 2200;
        const typingOk = await cancellableSleep(typingTime, job);
        if (!typingOk) {
          entry.status = 'skipped';
          job.skipped += 1;
          break;
        }
        try {
          await evaluate((id) => window.WPP.chat.markIsPaused(id), target.id);
        } catch (_) {
          /* ignore */
        }
      }

      const text =
        job.mode === 'text' || job.mode === 'file'
          ? renderMessage(job.message, target.name, job.spin)
          : '';

      if (job.dryRun) {
        entry.status = 'simulated';
        entry.preview =
          job.mode === 'forward'
            ? `Forward: ${job.forwardPreview || 'selected message'}`
            : job.mode === 'file'
              ? `${job.attachment.name}${text ? ` — ${text}` : ''}`
              : text;
        job.simulated += 1;
        await cancellableSleep(120, job);
      } else {
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            if (job.mode === 'forward') {
              const failed = await evaluate(
                ({ id, msgId }) => window.WPP.chat.forwardMessages(id, [msgId]),
                { id: target.id, msgId: job.forwardMessageId }
              );
              if (Array.isArray(failed) && failed.length) {
                throw new Error('WhatsApp could not forward this message.');
              }
              entry.messageId = job.forwardMessageId;
            } else if (job.mode === 'file') {
              const result = await evaluate(
                async ({ id, dataUrl, kind, caption, filename, mimetype }) => {
                  const options = { type: kind, caption, filename, mimetype };
                  if (kind === 'audio') options.isPtt = false;
                  const sent = await window.WPP.chat.sendFileMessage(id, dataUrl, options);
                  return { id: String(sent && sent.id ? sent.id : '') };
                },
                {
                  id: target.id,
                  dataUrl: job.dataUrl,
                  kind: job.attachment.kind,
                  caption: text,
                  filename: job.attachment.name,
                  mimetype: job.attachment.mime,
                }
              );
              entry.messageId = result.id || null;
            } else {
              const result = await evaluate(
                async ({ id, text }) => {
                  const sent = await window.WPP.chat.sendTextMessage(id, text);
                  return { id: String(sent && sent.id ? sent.id : '') };
                },
                { id: target.id, text }
              );
              entry.messageId = result.id || null;
            }
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt === 0) await cancellableSleep(2000 + Math.random() * 1500, job);
          }
        }
        if (lastErr) throw lastErr;
        entry.status = 'sent';
        entry.sentAt = Date.now();
        job.sent += 1;
      }
    } catch (err) {
      entry.status = 'failed';
      entry.error = err?.message || String(err);
      job.failed += 1;
    }

    job.done = i + 1;

    if (job.cancelled) break;
    if (i < job.targets.length - 1) {
      const delay = job.dryRun
        ? 120
        : job.delayMin * 1000 + Math.random() * (job.delayMax - job.delayMin) * 1000;
      const ok = await cancellableSleep(delay, job);
      if (!ok) break;
    }
  }

  for (const entry of job.results) {
    if (entry.status === 'pending' || entry.status === 'sending') {
      entry.status = 'skipped';
      job.skipped += 1;
    }
  }

  job.status = job.cancelled ? 'cancelled' : 'finished';
  job.finishedAt = Date.now();
  if (job.attachment) cleanupUpload(job.attachment.token);

  try {
    fs.appendFileSync(
      HISTORY_FILE,
      `${JSON.stringify({
        at: new Date(job.finishedAt).toISOString(),
        mode: job.mode,
        dryRun: job.dryRun,
        attachment: job.attachment ? job.attachment.name : null,
        forwardMessageId: job.forwardMessageId || null,
        total: job.total,
        sent: job.sent,
        failed: job.failed,
        skipped: job.skipped,
        results: job.results.map((r) => ({
          name: r.name,
          id: r.id,
          status: r.status,
          error: r.error || null,
        })),
      })}\n`
    );
  } catch (_) {
    /* history is best effort */
  }

  const finished = [...jobs.values()].filter((j) => j.status !== 'running');
  if (finished.length > 20) {
    finished
      .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0))
      .slice(0, finished.length - 20)
      .forEach((j) => jobs.delete(j.id));
  }
}

app.post('/api/send', (req, res) => {
  if (!requireReady(res)) return;

  const active = [...jobs.values()].find((job) => job.status === 'running');
  if (active) {
    return res.status(409).json({ error: 'A broadcast is already running. Wait for it to finish or cancel it.' });
  }

  const message = String(req.body?.message || '');
  const attachmentToken = String(req.body?.attachmentToken || '');
  const forwardMessageId = String(req.body?.forwardMessageId || '');
  const isForward = Boolean(forwardMessageId);
  const isFile = !isForward && Boolean(attachmentToken);

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }

  let attachment = null;
  let dataUrl = null;

  if (isForward) {
    if (!/^[A-Za-z0-9_@.:-]{6,500}$/.test(forwardMessageId)) {
      return res.status(400).json({ error: 'Invalid message to forward.' });
    }
  } else if (isFile) {
    if (!uploads.has(attachmentToken)) {
      return res.status(400).json({ error: 'That attachment expired. Attach the file again.' });
    }
    if (message.length > MAX_CAPTION_LENGTH) {
      return res
        .status(400)
        .json({ error: `Captions are limited to ${MAX_CAPTION_LENGTH} characters when a file is attached.` });
    }
    const item = uploads.get(attachmentToken);
    attachment = {
      token: attachmentToken,
      name: item.name,
      mime: item.mime,
      size: item.size,
      kind: item.kind,
    };
    try {
      dataUrl = `data:${item.mime};base64,${fs.readFileSync(item.path).toString('base64')}`;
    } catch (_) {
      return res.status(400).json({ error: 'Could not read the attached file. Attach it again.' });
    }
  } else if (!message.trim()) {
    return res.status(400).json({ error: 'Message is empty.' });
  }

  const rawTargets = Array.isArray(req.body?.targets) ? req.body.targets : [];
  const seen = new Set();
  const targets = [];
  for (const item of rawTargets) {
    const id = String(item?.id || '');
    if (!isDirectChatId(id) || seen.has(id)) continue;
    seen.add(id);
    targets.push({ id, name: String(item?.name || '').slice(0, 200) });
  }

  if (!targets.length) return res.status(400).json({ error: 'No valid recipients selected.' });
  if (targets.length > MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Too many recipients. Limit is ${MAX_RECIPIENTS} per broadcast.` });
  }

  const delayMin = Math.min(300, Math.max(3, Number(req.body?.delayMin) || 12));
  const delayMax = Math.min(600, Math.max(delayMin, Number(req.body?.delayMax) || 25));

  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    mode: isForward ? 'forward' : isFile ? 'file' : 'text',
    total: targets.length,
    done: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    skipped: 0,
    cancelled: false,
    dryRun: Boolean(req.body?.dryRun),
    spin: req.body?.spin !== false,
    message,
    attachment,
    dataUrl,
    forwardMessageId: isForward ? forwardMessageId : null,
    forwardPreview: isForward ? String(req.body?.forwardPreview || '').slice(0, 300) : null,
    targets,
    results: targets.map((t) => ({
      id: t.id,
      name: t.name,
      status: 'pending',
      error: null,
      sentAt: null,
    })),
    delayMin,
    delayMax,
    startedAt: null,
    finishedAt: null,
  };

  jobs.set(job.id, job);
  runJob(job).catch((err) => {
    job.status = 'finished';
    job.error = err?.message || String(err);
    job.finishedAt = Date.now();
    console.error('[job] crashed:', job.error);
  });

  res.json({ job: publicJob(job) });
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({ job: publicJob(job) });
});

app.post('/api/job/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'running') return res.status(409).json({ error: 'Job is not running.' });
  job.cancelled = true;
  res.json({ ok: true });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: err?.message || 'Internal server error.' });
});

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Label Broadcast is running');
  console.log(`  Open http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  startClient();
});

setInterval(() => {
  if (state === 'ready' && page) loadMe().catch(() => {});
}, 30000);

async function shutdown() {
  console.log('\n[app] shutting down...');
  state = 'stopping';
  await stopClient();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

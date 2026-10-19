(function () {
  'use strict';

  if (window.__lbLoaded) return;
  window.__lbLoaded = true;

  const MAX_RECIPIENTS = 300;
  const MAX_MESSAGE_LENGTH = 10000;
  const MAX_CAPTION_LENGTH = 1024;
  const MAX_FILE_SIZE = 64 * 1024 * 1024;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const state = {
    conn: 'loading',
    ready: false,
    recipients: new Map(),
    activeLabelId: null,
    filter: '',
    mode: 'compose',
    attachment: null,
    forward: null,
    sourceChats: [],
    sourceChatId: null,
    job: null,
    lastPreviewKey: '',
    booted: false,
  };

  let W = null;
  let wrap = null;
  let els = {};
  let toastTimer = null;

  const MARKUP = `
    <button id="lbFab" class="lb-fab" type="button" title="Label Broadcast">LB</button>

    <div id="lbBackdrop" class="lb-backdrop">
      <div class="lb-shell">
        <div class="lb-head">
          <div class="brand">
            <span class="brand-mark">LB</span>
            <div>
              <h1>Label Broadcast</h1>
              <p>Send one DM to a whole contact group</p>
            </div>
          </div>
          <div class="topbar-right">
            <div id="conn" class="conn conn--starting">
              <span class="dot"></span>
              <span id="connText">Connecting…</span>
            </div>
            <button id="closeBtn" class="btn btn-ghost btn-sm" type="button">Close</button>
          </div>
        </div>

        <div class="lb-body">
          <div id="banner" class="banner hidden"></div>

          <main class="layout">
            <section class="panel recipients">
              <div class="panel-head">
                <h2>1 · Recipients</h2>
                <button id="clearBtn" class="btn btn-ghost btn-sm" type="button">Clear</button>
              </div>

              <div class="tabs" role="tablist">
                <button class="tab is-active" data-tab="labels" role="tab" type="button">Labels</button>
                <button class="tab" data-tab="contacts" role="tab" type="button">Contacts</button>
                <button class="tab" data-tab="numbers" role="tab" type="button">Numbers</button>
              </div>

              <div id="tab-labels" class="tab-pane">
                <div class="tab-tools">
                  <p class="hint">Your WhatsApp lists and labels. Click one to select everyone in it.</p>
                  <button id="refreshLabelsBtn" class="btn btn-ghost btn-sm" type="button">Refresh</button>
                </div>
                <div id="labelList" class="label-grid">
                  <div class="empty">Loading labels…</div>
                </div>
              </div>

              <div id="tab-contacts" class="tab-pane hidden">
                <p class="hint">All contacts saved in your phone book.</p>
                <button id="loadContactsBtn" class="btn btn-secondary btn-block" type="button">Load my contacts</button>
              </div>

              <div id="tab-numbers" class="tab-pane hidden">
                <p class="hint">Paste numbers with country code, one per line. Names are optional: <code>+1 555 010 9999, Jane</code></p>
                <textarea id="numbersInput" class="textarea textarea-sm" rows="5" placeholder="+15550109999, Jane&#10;+447700900123, Sam"></textarea>
                <button id="addNumbersBtn" class="btn btn-secondary btn-block" type="button">Add numbers</button>
                <div id="numbersFeedback" class="feedback hidden"></div>
              </div>

              <div class="list-tools">
                <input id="search" class="input" type="search" placeholder="Search recipients…" />
                <label class="checkline">
                  <input type="checkbox" id="selectAll" />
                  <span>Select all shown</span>
                </label>
              </div>

              <ul id="contactList" class="contact-list"></ul>

              <div class="list-foot">
                <span id="selectedCount">0 selected</span>
                <span id="sourceNote" class="muted"></span>
              </div>
            </section>

            <section class="panel composer">
              <div class="panel-head">
                <h2>2 · Message</h2>
                <span id="charCount" class="muted">0 characters</span>
              </div>

              <div class="mode-tabs" id="modeTabs" role="tablist">
                <button class="mode-tab is-active" data-mode="compose" role="tab" type="button">Compose</button>
                <button class="mode-tab" data-mode="forward" role="tab" type="button">Forward a message</button>
              </div>

              <div id="composePanel">
                <textarea id="message" class="textarea" rows="9" placeholder="Hi {{name}}, quick update…"></textarea>

                <div class="attach-row">
                  <button id="attachBtn" class="btn btn-ghost btn-sm" type="button">Attach a file</button>
                  <input id="fileInput" type="file" hidden />
                  <div id="fileChip" class="file-chip hidden">
                    <span id="fileChipName" class="file-chip-name"></span>
                    <span id="fileChipMeta" class="muted"></span>
                    <button id="fileRemove" class="chip-x" type="button" aria-label="Remove attachment">×</button>
                  </div>
                </div>

                <div class="tokens">
                  <button class="token" data-token="{{name}}" title="Replaced with each contact's name" type="button">+ Name</button>
                  <button class="token" data-token="{Hi|Hey|Hello}" title="Randomly picks one option per recipient" type="button">+ Random variant</button>
                </div>
                <p class="hint">
                  <code>{{name}}</code> becomes the recipient's name. <code>{a|b|c}</code> picks a random variant per person,
                  so messages don't look identical. Files are sent with your text as the caption.
                </p>
              </div>

              <div id="forwardPanel" class="hidden">
                <p class="hint">Pick a chat, then pick the message to forward to every selected recipient.</p>
                <input id="sourceSearch" class="input" type="search" placeholder="Search chats…" />
                <ul id="sourceList" class="source-list">
                  <li class="empty">Open this tab to load your chats.</li>
                </ul>
                <div id="sourceMessages" class="source-messages hidden">
                  <div class="source-head">
                    <strong id="sourceChatName"></strong>
                    <button id="backToChats" class="btn btn-ghost btn-sm" type="button">Change chat</button>
                  </div>
                  <ul id="messageList" class="message-list"></ul>
                </div>
              </div>

              <div class="preview">
                <div class="preview-head">
                  <span>Preview</span>
                  <span id="previewWho" class="muted">first recipient</span>
                </div>
                <div id="previewBody" class="preview-body">Your message will appear here.</div>
              </div>

              <div class="options">
                <label class="field">
                  <span>Min delay (s)</span>
                  <input id="delayMin" class="input" type="number" min="3" max="300" value="12" />
                </label>
                <label class="field">
                  <span>Max delay (s)</span>
                  <input id="delayMax" class="input" type="number" min="3" max="600" value="25" />
                </label>
                <label class="checkline checkline--boxed">
                  <input type="checkbox" id="spin" checked />
                  <span>Randomize variants</span>
                </label>
                <label class="checkline checkline--boxed">
                  <input type="checkbox" id="dryRun" />
                  <span>Dry run (don't send)</span>
                </label>
              </div>

              <button id="sendBtn" class="btn btn-primary btn-lg btn-block" type="button" disabled>Send to 0 people</button>
              <p class="hint warn">
                Auto-sending is against WhatsApp's Terms and can get your number banned. Use small batches,
                long delays, and only message people who expect it.
              </p>

              <div id="progress" class="progress hidden">
                <div class="progress-head">
                  <span id="progressTitle">Sending…</span>
                  <button id="cancelBtn" class="btn btn-ghost btn-sm" type="button">Cancel</button>
                </div>
                <div class="bar"><div id="barFill" class="bar-fill"></div></div>
                <div id="progressStats" class="muted"></div>
                <ul id="progressList" class="progress-list"></ul>
              </div>
            </section>
          </main>

          <p class="hint center lb-foot">
            This runs inside your own WhatsApp Web tab. Reloading the page does not unlink your device.
          </p>
        </div>
      </div>
    </div>

    <div id="toast" class="toast hidden"></div>
  `;

  function mount() {
    if (document.getElementById('lb-whatsapp-root')) return;

    const host = document.createElement('div');
    host.id = 'lb-whatsapp-root';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    (document.body || document.documentElement).appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = window.__LB_CSS || '';
    shadow.appendChild(style);

    wrap = document.createElement('div');
    wrap.className = 'lb-root';
    wrap.innerHTML = MARKUP;
    shadow.appendChild(wrap);

    cacheElements();
    wireEvents();
    updateCharCount();
    renderContacts();
    updatePreview();
    tickConnection();
  }

  function $(selector) {
    return wrap.querySelector(selector.startsWith('#') ? selector : `#${selector}`);
  }

  function cacheElements() {
    els = {
      fab: $('#lbFab'),
      backdrop: $('#lbBackdrop'),
      closeBtn: $('#closeBtn'),
      conn: $('#conn'),
      connText: $('#connText'),
      banner: $('#banner'),
      labelList: $('#labelList'),
      refreshLabelsBtn: $('#refreshLabelsBtn'),
      contactList: $('#contactList'),
      selectedCount: $('#selectedCount'),
      sourceNote: $('#sourceNote'),
      search: $('#search'),
      selectAll: $('#selectAll'),
      clearBtn: $('#clearBtn'),
      message: $('#message'),
      charCount: $('#charCount'),
      previewBody: $('#previewBody'),
      previewWho: $('#previewWho'),
      delayMin: $('#delayMin'),
      delayMax: $('#delayMax'),
      spin: $('#spin'),
      dryRun: $('#dryRun'),
      sendBtn: $('#sendBtn'),
      progress: $('#progress'),
      progressTitle: $('#progressTitle'),
      progressStats: $('#progressStats'),
      progressList: $('#progressList'),
      barFill: $('#barFill'),
      cancelBtn: $('#cancelBtn'),
      toast: $('#toast'),
      numbersInput: $('#numbersInput'),
      addNumbersBtn: $('#addNumbersBtn'),
      numbersFeedback: $('#numbersFeedback'),
      loadContactsBtn: $('#loadContactsBtn'),
      modeTabs: $('#modeTabs'),
      composePanel: $('#composePanel'),
      forwardPanel: $('#forwardPanel'),
      attachBtn: $('#attachBtn'),
      fileInput: $('#fileInput'),
      fileChip: $('#fileChip'),
      fileChipName: $('#fileChipName'),
      fileChipMeta: $('#fileChipMeta'),
      fileRemove: $('#fileRemove'),
      sourceSearch: $('#sourceSearch'),
      sourceList: $('#sourceList'),
      sourceMessages: $('#sourceMessages'),
      sourceChatName: $('#sourceChatName'),
      backToChats: $('#backToChats'),
      messageList: $('#messageList'),
    };
  }

  function openPanel(open) {
    els.backdrop.classList.toggle('is-open', open);
  }

  function toast(message, isError) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', Boolean(isError));
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3400);
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part[0] || '').join('').toUpperCase() || '?';
  }

  function formatNumber(number) {
    return number ? `+${number}` : '';
  }

  function formatSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  /* ---------------- connection ---------------- */

  function setConn(kind, text, banner) {
    els.conn.className = `conn conn--${kind}`;
    els.connText.textContent = text;
    if (banner) {
      els.banner.textContent = banner;
      els.banner.classList.remove('hidden');
    } else {
      els.banner.classList.add('hidden');
    }
  }

  async function loadMe() {
    try {
      const wid = W.conn.getMyUserId();
      const contact = wid ? W.contact.get(wid) : null;
      const name = (contact && (contact.name || contact.pushname)) || '';
      toast(name ? `Connected as ${name}` : 'WhatsApp connected');
    } catch (_) {
      toast('WhatsApp connected');
    }
  }

  async function tickConnection() {
    let status = 'loading';
    W = window.WPP && window.WPP.isReady ? window.WPP : null;

    if (W) {
      try {
        const authenticated = W.conn.isAuthenticated();
        const userId = String(W.conn.getMyUserId() || '');
        if (authenticated && userId) status = 'ready';
        else if (authenticated) status = 'linking';
        else status = 'loggedout';
      } catch (_) {
        status = 'loading';
      }
    }

    if (status !== state.conn) {
      state.conn = status;

      if (status === 'ready') {
        setConn('ready', 'Connected');
        if (!state.booted) {
          state.booted = true;
          loadMe();
          loadLabels();
        }
      } else if (status === 'loggedout') {
        state.booted = false;
        setConn(
          'qr',
          'Waiting for login',
          'Log in to WhatsApp Web with the QR code on the page. This panel connects automatically once you are in.'
        );
      } else if (status === 'linking') {
        setConn('starting', 'Finishing login…');
      } else {
        setConn('starting', 'Connecting…');
      }
    }

    state.ready = status === 'ready';
    updateCounts();

    setTimeout(tickConnection, 2000);
  }

  /* ---------------- recipients ---------------- */

  function selectedTargets() {
    return [...state.recipients.values()].filter((recipient) => recipient.selected);
  }

  function addRecipients(list, select) {
    let added = 0;
    for (const item of list) {
      if (!item || !item.id) continue;
      if (!state.recipients.has(item.id)) {
        state.recipients.set(item.id, {
          id: item.id,
          name: item.name || formatNumber(item.number) || 'Unknown',
          number: item.number || '',
          selected: Boolean(select),
        });
        added += 1;
      } else if (select) {
        state.recipients.get(item.id).selected = true;
      }
    }
    renderContacts();
    return added;
  }

  function visibleRecipients() {
    const query = state.filter.trim().toLowerCase();
    const all = [...state.recipients.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!query) return all;
    return all.filter(
      (recipient) =>
        recipient.name.toLowerCase().includes(query) ||
        String(recipient.number || '').includes(query) ||
        String(recipient.id).toLowerCase().includes(query)
    );
  }

  function renderContacts() {
    if (!els.contactList) return;
    const list = visibleRecipients();
    els.contactList.textContent = '';

    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = state.recipients.size
        ? 'No recipients match your search.'
        : 'No recipients yet. Pick a group, load contacts, or add numbers.';
      els.contactList.appendChild(li);
    }

    for (const recipient of list) {
      const li = document.createElement('li');
      li.className = `contact-row${recipient.selected ? ' is-selected' : ''}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = recipient.selected;
      checkbox.addEventListener('change', () => {
        recipient.selected = checkbox.checked;
        li.classList.toggle('is-selected', checkbox.checked);
        updateCounts();
      });

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = initials(recipient.name);

      const meta = document.createElement('div');
      meta.className = 'contact-meta';
      const name = document.createElement('div');
      name.className = 'contact-name';
      name.textContent = recipient.name;
      const number = document.createElement('div');
      number.className = 'contact-num';
      number.textContent = formatNumber(recipient.number);
      meta.append(name, number);

      li.append(checkbox, avatar, meta);
      li.addEventListener('click', (event) => {
        if (event.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
      });
      els.contactList.appendChild(li);
    }

    updateCounts();
    updatePreview();
  }

  function canSend() {
    if (!state.ready) return false;
    if (state.job && state.job.status === 'running') return false;
    if (!selectedTargets().length) return false;
    if (state.mode === 'forward') return Boolean(state.forward);
    return Boolean(els.message.value.trim() || state.attachment);
  }

  function updateCounts() {
    if (!els.sendBtn) return;
    const total = state.recipients.size;
    const selected = selectedTargets().length;
    els.selectedCount.textContent = `${selected} selected${total ? ` of ${total}` : ''}`;

    const visible = visibleRecipients();
    const visibleSelected = visible.filter((recipient) => recipient.selected).length;
    els.selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
    els.selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
    els.selectAll.disabled = visible.length === 0;

    els.sourceNote.textContent = state.activeLabelId ? els.sourceNote.dataset.label || '' : '';

    els.sendBtn.disabled = !canSend();
    const people = `${selected} ${selected === 1 ? 'person' : 'people'}`;
    els.sendBtn.textContent = els.dryRun.checked
      ? `Simulate for ${people}`
      : state.mode === 'forward'
        ? `Forward to ${people}`
        : `Send to ${people}`;
  }

  function updateCharCount() {
    const limit = state.attachment ? MAX_CAPTION_LENGTH : MAX_MESSAGE_LENGTH;
    const length = els.message.value.length;
    els.charCount.textContent = state.attachment ? `${length} / ${limit} caption` : `${length} characters`;
    els.charCount.classList.toggle('over', length > limit);
  }

  function renderMessage(template, name, randomize) {
    let out = String(template).replace(/\{\{\s*name\s*\}\}/gi, name || 'there');
    if (randomize) {
      out = out.replace(/\{([^{}]+)\}/g, (match, group) => {
        const options = group.split('|').map((part) => part.trim()).filter(Boolean);
        if (!options.length) return match;
        return options[Math.floor(Math.random() * options.length)];
      });
    }
    return out;
  }

  function updatePreview() {
    if (!els.previewBody) return;
    const selected = selectedTargets();
    const first = selected[0] || visibleRecipients()[0];

    if (state.mode === 'forward') {
      els.previewWho.textContent = first ? first.name : 'selected recipients';
      if (!state.forward) {
        els.previewBody.textContent = 'Pick a message to forward.';
        return;
      }
      const body =
        state.forward.isMedia && state.forward.filename
          ? `[${state.forward.type || 'media'}] ${state.forward.filename}`
          : state.forward.text;
      els.previewBody.textContent = `Forwarded message\n\n${body || 'Media message'}`;
      return;
    }

    const text = els.message.value;
    if (!text.trim() && !state.attachment) {
      els.previewBody.textContent = 'Your message will appear here.';
      els.previewWho.textContent = 'first recipient';
      return;
    }

    const key = `${text}|${first ? first.id : ''}|${els.spin.checked}|${state.attachment ? state.attachment.name : ''}`;
    if (key === state.lastPreviewKey) return;
    state.lastPreviewKey = key;

    let body = text.trim() ? renderMessage(text, first ? first.name : 'there', els.spin.checked) : '';
    if (state.attachment) body = `${body ? `${body}\n\n` : ''}Attachment: ${state.attachment.name}`;
    els.previewBody.textContent = body;
    els.previewWho.textContent = first ? first.name : 'first recipient';
  }

  /* ---------------- groups and contacts ---------------- */

  function contactFromChat(chat) {
    const id = String((chat.id && (chat.id._serialized || chat.id)) || '');
    if (!id) return null;
    const contact = chat.contact || {};
    const name =
      chat.name ||
      chat.formattedTitle ||
      contact.name ||
      contact.pushname ||
      contact.shortName ||
      (chat.id && chat.id.user) ||
      id;
    return { id, name: String(name), number: String((chat.id && chat.id.user) || '') };
  }

  async function countForLabel(id, meId) {
    let chats = [];
    try {
      chats = await W.chat.list({ withLabels: [String(id)], onlyUsers: true });
    } catch (_) {
      chats = [];
    }
    let count = chats.filter((chat) => String((chat.id && (chat.id._serialized || chat.id)) || '') !== meId).length;
    if (count) return count;

    try {
      const contacts = await W.contact.list({ withLabels: [String(id)], onlyMyContacts: false });
      count = contacts.filter((contact) => {
        const cid = String((contact.id && (contact.id._serialized || contact.id)) || '');
        return cid && cid !== meId && /@(c\.us|lid)$/.test(cid);
      }).length;
    } catch (_) {
      /* ignore */
    }
    return count;
  }

  async function loadLabels(attempt = 0) {
    if (!W) return;
    els.labelList.textContent = '';

    const loading = document.createElement('div');
    loading.className = 'empty';
    loading.textContent = 'Loading groups…';
    els.labelList.appendChild(loading);

    try {
      const me = W.conn.getMyUserId();
      const meId = me ? String(me._serialized || me) : '';
      const groups = [];
      const seen = new Set();

      let lists = [];
      try {
        lists = W.lists.list() || [];
      } catch (_) {
        lists = [];
      }

      for (const list of lists) {
        const id = String(list.id);
        if (seen.has(id)) continue;
        seen.add(id);
        groups.push({
          id,
          name: list.name || 'Unnamed list',
          kind: 'list',
          color: list.hexColor || null,
          count: await countForLabel(id, meId),
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
        seen.add(id);
        groups.push({
          id,
          name: label.name || 'Unnamed label',
          kind: 'label',
          color: label.hexColor || null,
          count: await countForLabel(id, meId),
        });
      }

      const visibleGroups = groups.filter((group) => group.count > 0);
      visibleGroups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      els.labelList.textContent = '';

      if (!visibleGroups.length) {
        if (!lists.length && attempt < 12) {
          const waiting = document.createElement('div');
          waiting.className = 'empty';
          waiting.textContent = 'Looking for your labels…';
          els.labelList.appendChild(waiting);
          setTimeout(() => loadLabels(attempt + 1), 4000);
          return;
        }
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent =
          'No labels with members found. Create a list in WhatsApp Web (Chats → Lists), then press Refresh.';
        els.labelList.appendChild(empty);
        return;
      }

      for (const group of visibleGroups) {
        const button = document.createElement('button');
        button.className = 'label-btn';
        button.type = 'button';
        button.title = group.kind === 'list' ? 'WhatsApp list' : 'WhatsApp label';

        const swatch = document.createElement('span');
        swatch.className = 'label-swatch';
        if (group.color) swatch.style.background = `#${String(group.color).replace('#', '')}`;

        const name = document.createElement('span');
        name.className = 'label-name';
        name.textContent = group.name;

        const count = document.createElement('span');
        count.className = 'label-count';
        count.textContent = `${group.count} ${group.count === 1 ? 'chat' : 'chats'}`;

        button.append(swatch, name, count);
        button.addEventListener('click', () => selectLabel(group, button));
        els.labelList.appendChild(button);
      }
    } catch (err) {
      els.labelList.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `Could not load groups: ${err.message || err}`;
      els.labelList.appendChild(empty);
    }
  }

  async function selectLabel(group, button) {
    document.querySelectorAll('.label-btn').forEach((el) => el.classList.remove('is-active'));
    button.classList.add('is-active');
    state.activeLabelId = group.id;
    els.sourceNote.dataset.label = group.name;

    button.disabled = true;
    const countEl = button.querySelector('.label-count');
    const original = countEl.textContent;
    countEl.textContent = 'loading…';

    try {
      const me = W.conn.getMyUserId();
      const meId = me ? String(me._serialized || me) : '';
      let chats = [];
      try {
        chats = await W.chat.list({ withLabels: [String(group.id)], onlyUsers: true });
      } catch (_) {
        chats = [];
      }

      const seen = new Set();
      const contacts = [];
      for (const chat of chats) {
        const contact = contactFromChat(chat);
        if (!contact || contact.id === meId || seen.has(contact.id)) continue;
        seen.add(contact.id);
        contacts.push(contact);
      }

      if (!contacts.length) {
        const fallback = await W.contact
          .list({ withLabels: [String(group.id)], onlyMyContacts: false })
          .catch(() => []);
        for (const contact of fallback) {
          const id = String((contact.id && (contact.id._serialized || contact.id)) || '');
          if (!id || id === meId || seen.has(id) || !/@(c\.us|lid)$/.test(id)) continue;
          seen.add(id);
          contacts.push({
            id,
            name: String(
              contact.name || contact.pushname || contact.shortName || (contact.id && contact.id.user) || id
            ),
            number: String((contact.id && contact.id.user) || ''),
          });
        }
      }

      contacts.sort((a, b) => a.name.localeCompare(b.name));
      const added = addRecipients(contacts, true);

      if (!contacts.length) toast(`"${group.name}" has no individual chats.`, true);
      else toast(`"${group.name}": ${contacts.length} contacts, ${added} new, all selected.`);
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      button.disabled = false;
      countEl.textContent = original;
    }
  }

  async function loadContacts() {
    els.loadContactsBtn.disabled = true;
    els.loadContactsBtn.textContent = 'Loading…';
    try {
      const me = W.conn.getMyUserId();
      const meId = me ? String(me._serialized || me) : '';
      const list = await W.contact.list({ onlyMyContacts: true });
      const seen = new Set();
      const contacts = [];

      for (const contact of list) {
        const id = String((contact.id && (contact.id._serialized || contact.id)) || '');
        if (!id || id === meId || seen.has(id) || !/@(c\.us|lid)$/.test(id)) continue;
        seen.add(id);
        contacts.push({
          id,
          name: String(
            contact.name || contact.pushname || contact.shortName || (contact.id && contact.id.user) || id
          ),
          number: String((contact.id && contact.id.user) || ''),
        });
      }

      contacts.sort((a, b) => a.name.localeCompare(b.name));
      const added = addRecipients(contacts, false);
      toast(`Loaded ${contacts.length} contacts (${added} new). Tick the ones you want.`);
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      els.loadContactsBtn.disabled = false;
      els.loadContactsBtn.textContent = 'Load my contacts';
    }
  }

  async function addNumbers() {
    const lines = els.numbersInput.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) return toast('Paste at least one number first.', true);
    if (lines.length > MAX_RECIPIENTS) {
      return toast(`Too many numbers. Limit is ${MAX_RECIPIENTS} at a time.`, true);
    }

    els.addNumbersBtn.disabled = true;
    els.addNumbersBtn.textContent = 'Checking…';
    els.numbersFeedback.classList.add('hidden');

    try {
      const resolved = [];
      const failed = [];

      for (const line of lines) {
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
          failed.push({ input: line, reason: err.message || String(err) });
        }
      }

      addRecipients(resolved, true);

      const parts = [];
      if (resolved.length) parts.push(`${resolved.length} added`);
      if (failed.length) parts.push(`${failed.length} failed`);
      els.numbersFeedback.textContent =
        parts.join(' · ') +
        (failed.length ? `\n${failed.map((item) => `• ${item.input}: ${item.reason}`).join('\n')}` : '');
      els.numbersFeedback.classList.toggle('ok', !failed.length);
      els.numbersFeedback.classList.remove('hidden');

      if (resolved.length) {
        els.numbersInput.value = failed.map((item) => item.input).join('\n');
        toast(`${resolved.length} numbers added and selected.`);
      }
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      els.addNumbersBtn.disabled = false;
      els.addNumbersBtn.textContent = 'Add numbers';
    }
  }

  /* ---------------- attachments ---------------- */

  function kindForMime(mime) {
    if (/^image\//i.test(mime)) return 'image';
    if (/^video\//i.test(mime)) return 'video';
    if (/^audio\//i.test(mime)) return 'audio';
    return 'document';
  }

  function renderAttachment() {
    const attachment = state.attachment;
    els.fileChip.classList.toggle('hidden', !attachment);
    if (!attachment) return;
    els.fileChipName.textContent = attachment.name;
    els.fileChipMeta.textContent = `${attachment.kind} · ${formatSize(attachment.size)}`;
  }

  function setAttachment(file) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      toast(`File is too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB).`, true);
      return;
    }
    const mime = file.type || 'application/octet-stream';
    state.attachment = {
      file,
      name: file.name || 'file',
      size: file.size,
      mime,
      kind: kindForMime(mime),
    };
    renderAttachment();
    state.lastPreviewKey = '';
    updateCharCount();
    updatePreview();
    updateCounts();
    toast(`Attached ${state.attachment.name}`);
  }

  function removeAttachment() {
    state.attachment = null;
    renderAttachment();
    state.lastPreviewKey = '';
    updateCharCount();
    updatePreview();
    updateCounts();
  }

  /* ---------------- forward picker ---------------- */

  function setMode(mode) {
    state.mode = mode;
    wrap.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.mode === mode);
    });
    els.composePanel.classList.toggle('hidden', mode !== 'compose');
    els.forwardPanel.classList.toggle('hidden', mode !== 'forward');
    state.lastPreviewKey = '';
    if (mode === 'forward' && !state.sourceChats.length) loadSourceChats();
    updateCharCount();
    updatePreview();
    updateCounts();
  }

  async function loadSourceChats() {
    els.sourceList.textContent = '';
    const loading = document.createElement('li');
    loading.className = 'empty';
    loading.textContent = 'Loading chats…';
    els.sourceList.appendChild(loading);

    try {
      const chats = await W.chat.list({ count: 100 });
      const me = W.conn.getMyUserId();
      const meId = me ? String(me._serialized || me) : '';
      const seen = new Set();
      state.sourceChats = [];

      for (const chat of chats) {
        const id = String((chat.id && (chat.id._serialized || chat.id)) || '');
        if (!id || id === meId || seen.has(id) || !/@(c\.us|lid|g\.us)$/.test(id)) continue;
        const name = String(
          chat.name ||
            chat.formattedTitle ||
            (chat.contact && (chat.contact.name || chat.contact.pushname)) ||
            (chat.id && chat.id.user) ||
            id
        );
        seen.add(id);
        state.sourceChats.push({
          id,
          name,
          isGroup: id.endsWith('@g.us'),
          number: String((chat.id && chat.id.user) || ''),
        });
        if (state.sourceChats.length >= 80) break;
      }

      renderSourceChats();
    } catch (err) {
      els.sourceList.textContent = '';
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = `Could not load chats: ${err.message || err}`;
      els.sourceList.appendChild(empty);
    }
  }

  function renderSourceChats() {
    const query = els.sourceSearch.value.trim().toLowerCase();
    const list = query
      ? state.sourceChats.filter(
          (chat) =>
            chat.name.toLowerCase().includes(query) ||
            String(chat.number || '').includes(query) ||
            String(chat.id).toLowerCase().includes(query)
        )
      : state.sourceChats;

    els.sourceList.textContent = '';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = state.sourceChats.length ? 'No chats match your search.' : 'No chats found.';
      els.sourceList.appendChild(empty);
      return;
    }

    for (const chat of list) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source-chat';

      const name = document.createElement('span');
      name.className = 'source-name';
      name.textContent = chat.name;

      const meta = document.createElement('span');
      meta.className = 'source-meta';
      meta.textContent = chat.isGroup ? 'Group chat' : formatNumber(chat.number);

      button.append(name, meta);
      button.addEventListener('click', () => selectSourceChat(chat));
      li.appendChild(button);
      els.sourceList.appendChild(li);
    }
  }

  async function selectSourceChat(chat) {
    state.sourceChatId = chat.id;
    els.sourceChatName.textContent = chat.name;
    els.sourceList.classList.add('hidden');
    els.sourceMessages.classList.remove('hidden');
    els.messageList.textContent = '';

    const loading = document.createElement('li');
    loading.className = 'empty';
    loading.textContent = 'Loading messages…';
    els.messageList.appendChild(loading);

    try {
      const raw = await W.chat.getMessages(chat.id, { count: 30 });
      const messages = [];

      for (const msg of raw) {
        const id = String((msg.id && (msg.id._serialized || msg.id)) || '');
        if (!id) continue;
        const type = String(msg.type || '');
        const body = String(msg.caption || msg.body || '').replace(/\s+/g, ' ').trim();
        messages.push({
          id,
          type,
          text: body.slice(0, 400) || (msg.isMedia ? `[${type || 'media'}]` : ''),
          filename: msg.filename ? String(msg.filename) : '',
          mimetype: msg.mimetype ? String(msg.mimetype) : '',
          fromMe: Boolean(msg.id && msg.id.fromMe),
          timestamp: Number(msg.t || 0),
          isMedia: Boolean(msg.isMedia),
        });
      }

      messages.sort((a, b) => b.timestamp - a.timestamp);
      renderMessages(messages);
    } catch (err) {
      els.messageList.textContent = '';
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = `Could not load messages: ${err.message || err}`;
      els.messageList.appendChild(empty);
    }
  }

  function renderMessages(messages) {
    els.messageList.textContent = '';
    if (!messages.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No recent messages in this chat.';
      els.messageList.appendChild(empty);
      return;
    }

    for (const msg of messages) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = `message-row${state.forward && state.forward.id === msg.id ? ' is-selected' : ''}`;

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'forward-choice';
      radio.checked = Boolean(state.forward && state.forward.id === msg.id);
      radio.addEventListener('change', () => selectForward(msg, label));

      const body = document.createElement('div');
      body.className = 'message-body';

      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const when = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleString() : '';
      meta.textContent = [msg.type || 'message', msg.fromMe ? 'you' : '', when].filter(Boolean).join(' · ');

      const text = document.createElement('div');
      text.className = 'message-text';
      text.textContent = msg.filename ? `[file] ${msg.filename}` : msg.text || '[media]';

      body.append(meta, text);
      label.append(radio, body);
      li.appendChild(label);
      els.messageList.appendChild(li);
    }
  }

  function selectForward(msg, row) {
    state.forward = msg;
    wrap.querySelectorAll('.message-row').forEach((el) => el.classList.remove('is-selected'));
    row.classList.add('is-selected');
    updatePreview();
    updateCounts();
  }

  /* ---------------- sending ---------------- */

  function cancellableSleep(ms, job) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const tick = () => {
        if (job.cancelled) return resolve(false);
        const left = end - Date.now();
        if (left <= 0) return resolve(true);
        setTimeout(tick, Math.min(400, left));
      };
      tick();
    });
  }

  function renderJob(job) {
    els.progress.classList.remove('hidden');
    const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
    els.barFill.style.width = `${percent}%`;

    els.progressTitle.textContent =
      job.status === 'running'
        ? job.dryRun
          ? 'Simulating…'
          : job.mode === 'forward'
            ? 'Forwarding…'
            : 'Sending…'
        : job.status === 'cancelled'
          ? 'Cancelled'
          : 'Finished';

    els.progressStats.textContent = job.dryRun
      ? `${job.done}/${job.total} · ${job.simulated} simulated · ${job.failed} failed · ${job.skipped} skipped`
      : `${job.done}/${job.total} · ${job.sent} sent · ${job.failed} failed · ${job.skipped} skipped`;

    els.progressList.textContent = '';
    for (const result of job.results) {
      const li = document.createElement('li');
      li.className = 'progress-row';

      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = result.name || result.id;

      const pill = document.createElement('span');
      pill.className = `status-pill ${result.status}`;
      pill.textContent = result.status;

      li.append(name, pill);

      if (result.error) {
        const error = document.createElement('span');
        error.className = 'p-error';
        error.title = result.error;
        error.textContent = result.error;
        li.appendChild(error);
      }

      els.progressList.appendChild(li);
    }
  }

  function setJobUi(active) {
    els.cancelBtn.classList.toggle('hidden', !active);
    if (active) {
      els.sendBtn.disabled = true;
      els.sendBtn.textContent = 'Broadcast in progress…';
    } else {
      updateCounts();
    }
  }

  async function runJob(job) {
    job.status = 'running';
    renderJob(job);

    for (let i = 0; i < job.targets.length; i += 1) {
      if (job.cancelled) break;
      const target = job.targets[i];
      const entry = job.results[i];
      entry.status = 'sending';
      renderJob(job);

      try {
        if (!job.dryRun && job.mode !== 'forward') {
          try {
            W.chat.markIsComposing(target.id, 6000);
          } catch (_) {
            /* best effort */
          }
          const typingOk = await cancellableSleep(1400 + Math.random() * 2200, job);
          if (!typingOk) {
            entry.status = 'skipped';
            job.skipped += 1;
            break;
          }
          try {
            W.chat.markIsPaused(target.id);
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
              ? `Forward: ${job.forward.text || job.forward.filename || 'selected message'}`
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
                const failed = await W.chat.forwardMessages(target.id, [job.forward.id]);
                if (Array.isArray(failed) && failed.length) {
                  throw new Error('WhatsApp could not forward this message.');
                }
                entry.messageId = job.forward.id;
              } else if (job.mode === 'file') {
                const options = {
                  type: job.attachment.kind,
                  caption: text,
                  filename: job.attachment.name,
                  mimetype: job.attachment.mime,
                };
                if (job.attachment.kind === 'audio') options.isPtt = false;
                const sent = await W.chat.sendFileMessage(target.id, job.attachment.file, options);
                entry.messageId = String((sent && sent.id) || '');
              } else {
                const sent = await W.chat.sendTextMessage(target.id, text);
                entry.messageId = String((sent && sent.id) || '');
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
        entry.error = err.message || String(err);
        job.failed += 1;
      }

      job.done = i + 1;
      renderJob(job);

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
    renderJob(job);
    setJobUi(false);

    if (job.cancelled) {
      toast(
        job.dryRun
          ? `Cancelled. ${job.simulated} simulated before stopping.`
          : `Cancelled. ${job.sent} sent before stopping.`
      );
    } else if (job.dryRun) {
      toast(`Done: ${job.simulated} simulated, ${job.failed} failed, ${job.skipped} skipped.`);
    } else {
      toast(`Done: ${job.sent} sent, ${job.failed} failed, ${job.skipped} skipped.`);
    }
  }

  async function startBroadcast() {
    const targets = selectedTargets();
    const forwarding = state.mode === 'forward';

    if (!state.ready) return toast('WhatsApp is not connected yet.', true);
    if (forwarding && !state.forward) return toast('Pick a message to forward first.', true);
    if (!forwarding && !els.message.value.trim() && !state.attachment) {
      return toast('Write a message or attach a file first.', true);
    }
    if (!targets.length) return toast('Select at least one recipient.', true);
    if (targets.length > MAX_RECIPIENTS) {
      return toast(`Too many recipients. Limit is ${MAX_RECIPIENTS} per broadcast.`, true);
    }
    if (state.job && state.job.status === 'running') {
      return toast('A broadcast is already running.', true);
    }

    const message = els.message.value;
    const dryRun = els.dryRun.checked;
    const mode = forwarding ? 'forward' : state.attachment ? 'file' : 'text';

    if (mode === 'file' && message.length > MAX_CAPTION_LENGTH) {
      return toast(`Captions are limited to ${MAX_CAPTION_LENGTH} characters.`, true);
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return toast(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`, true);
    }

    if (!dryRun) {
      const action = forwarding
        ? 'Forward this message'
        : state.attachment
          ? `Send "${state.attachment.name}"`
          : 'Send this message';
      const ok = window.confirm(
        `${action} to ${targets.length} ${targets.length === 1 ? 'person' : 'people'}?\n\nThis cannot be undone.`
      );
      if (!ok) return;
    }

    let delayMin = Number(els.delayMin.value) || 12;
    let delayMax = Number(els.delayMax.value) || 25;
    if (delayMax < delayMin) [delayMin, delayMax] = [delayMax, delayMin];
    delayMin = Math.min(300, Math.max(3, delayMin));
    delayMax = Math.min(600, Math.max(delayMin, delayMax));
    els.delayMin.value = delayMin;
    els.delayMax.value = delayMax;

    const seen = new Set();
    const uniqueTargets = [];
    for (const target of targets) {
      if (!/@(c\.us|lid)$/.test(target.id) || seen.has(target.id)) continue;
      seen.add(target.id);
      uniqueTargets.push({ id: target.id, name: target.name });
    }

    if (!uniqueTargets.length) return toast('No valid recipients selected.', true);

    const job = {
      mode,
      total: uniqueTargets.length,
      done: 0,
      sent: 0,
      simulated: 0,
      failed: 0,
      skipped: 0,
      cancelled: false,
      dryRun,
      spin: els.spin.checked,
      message,
      attachment: state.attachment,
      forward: state.forward,
      targets: uniqueTargets,
      results: uniqueTargets.map((target) => ({
        id: target.id,
        name: target.name,
        status: 'pending',
        error: null,
        sentAt: null,
      })),
      delayMin,
      delayMax,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
    };

    state.job = job;
    els.progress.classList.remove('hidden');
    setJobUi(true);
    renderJob(job);

    if (mode === 'file') {
      state.attachment = null;
      renderAttachment();
      state.lastPreviewKey = '';
      updateCharCount();
      updatePreview();
    }

    runJob(job).catch((err) => {
      job.status = 'finished';
      job.error = err.message || String(err);
      job.finishedAt = Date.now();
      renderJob(job);
      setJobUi(false);
      toast(`Broadcast crashed: ${job.error}`, true);
    });
  }

  function cancelJob() {
    if (!state.job || state.job.status !== 'running') return;
    state.job.cancelled = true;
    toast('Cancelling after the current message…');
  }

  /* ---------------- wiring ---------------- */

  function wireEvents() {
    els.fab.addEventListener('click', () => openPanel(true));
    els.closeBtn.addEventListener('click', () => openPanel(false));
    els.backdrop.addEventListener('click', (event) => {
      if (event.target === els.backdrop) openPanel(false);
    });

    wrap.querySelectorAll('.tab[data-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        wrap.querySelectorAll('.tab[data-tab]').forEach((el) => el.classList.remove('is-active'));
        wrap.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.add('hidden'));
        tab.classList.add('is-active');
        wrap.querySelector(`#tab-${tab.dataset.tab}`).classList.remove('hidden');
        if (tab.dataset.tab === 'labels' && state.ready) loadLabels();
      });
    });

    if (els.refreshLabelsBtn) els.refreshLabelsBtn.addEventListener('click', () => loadLabels());

    els.modeTabs.addEventListener('click', (event) => {
      const tab = event.target.closest('.mode-tab');
      if (tab) setMode(tab.dataset.mode);
    });

    wrap.querySelectorAll('.token').forEach((button) => {
      button.addEventListener('click', () => {
        const token = button.dataset.token;
        const start = els.message.selectionStart == null ? els.message.value.length : els.message.selectionStart;
        const end = els.message.selectionEnd == null ? els.message.value.length : els.message.selectionEnd;
        const value = els.message.value;
        els.message.value = value.slice(0, start) + token + value.slice(end);
        els.message.focus();
        els.message.selectionStart = els.message.selectionEnd = start + token.length;
        updateCharCount();
        updatePreview();
        updateCounts();
      });
    });

    els.message.addEventListener('input', () => {
      updateCharCount();
      updatePreview();
      updateCounts();
    });

    els.spin.addEventListener('change', () => {
      state.lastPreviewKey = '';
      updatePreview();
    });
    els.dryRun.addEventListener('change', updateCounts);

    els.search.addEventListener('input', () => {
      state.filter = els.search.value;
      renderContacts();
    });

    els.selectAll.addEventListener('change', () => {
      const check = els.selectAll.checked;
      for (const recipient of visibleRecipients()) recipient.selected = check;
      renderContacts();
    });

    els.clearBtn.addEventListener('click', () => {
      if (state.recipients.size && !window.confirm('Remove all recipients from the list?')) return;
      state.recipients.clear();
      state.activeLabelId = null;
      els.sourceNote.dataset.label = '';
      wrap.querySelectorAll('.label-btn').forEach((el) => el.classList.remove('is-active'));
      renderContacts();
    });

    els.loadContactsBtn.addEventListener('click', loadContacts);
    els.addNumbersBtn.addEventListener('click', addNumbers);
    els.sendBtn.addEventListener('click', startBroadcast);
    els.cancelBtn.addEventListener('click', cancelJob);

    els.attachBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      if (file) setAttachment(file);
      els.fileInput.value = '';
    });
    els.fileRemove.addEventListener('click', removeAttachment);

    els.sourceSearch.addEventListener('input', renderSourceChats);
    els.backToChats.addEventListener('click', () => {
      els.sourceMessages.classList.add('hidden');
      els.sourceList.classList.remove('hidden');
    });

    els.delayMin.addEventListener('change', () => {
      const min = Number(els.delayMin.value) || 3;
      if (Number(els.delayMax.value) < min) els.delayMax.value = min;
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.backdrop.classList.contains('is-open')) openPanel(false);
    });

    window.addEventListener('beforeunload', (event) => {
      if (state.job && state.job.status === 'running') {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();

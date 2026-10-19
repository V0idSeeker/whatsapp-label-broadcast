(() => {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    ready: false,
    recipients: new Map(),
    activeLabelId: null,
    filter: '',
    jobId: null,
    jobTimer: null,
    lastPreviewKey: '',
    mode: 'compose',
    attachment: null,
    forward: null,
    sourceChats: [],
    sourceChatId: null,
    sourceChatName: '',
    uploading: false,
  };

  const els = {
    conn: $('#conn'),
    connText: $('#connText'),
    restartBtn: $('#restartBtn'),
    logoutBtn: $('#logoutBtn'),
    banner: $('#banner'),
    overlay: $('#overlay'),
    overlayTitle: $('#overlayTitle'),
    overlayText: $('#overlayText'),
    overlayError: $('#overlayError'),
    overlayRestart: $('#overlayRestart'),
    qrImg: $('#qrImg'),
    qrSpinner: $('#qrSpinner'),
    labelList: $('#labelList'),
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

  const api = async (url, options = {}) => {
    const headers = { 'X-App-Request': '1', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...options, headers });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* empty body */
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  };

  let toastTimer = null;
  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', isError);
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
  }

  function formatNumber(number) {
    if (!number) return '';
    return `+${number}`;
  }

  /* ---------------- connection ---------------- */

  function setConn(connState, error) {
    const map = {
      ready: ['Connected', 'conn--ready'],
      qr: ['Scan QR to link', 'conn--qr'],
      starting: ['Connecting…', 'conn--starting'],
      authenticated: ['Finishing link…', 'conn--starting'],
      error: ['Connection error', 'conn--error'],
      disconnected: ['Disconnected', 'conn--disconnected'],
    };
    const [label, cls] = map[connState] || [connState, 'conn--starting'];
    els.connText.textContent = label;
    els.conn.className = `conn ${cls}`;

    if (error) {
      els.banner.textContent = error;
      els.banner.classList.remove('hidden');
    } else {
      els.banner.classList.add('hidden');
    }
  }

  function showOverlay(title, text) {
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text;
    els.overlay.classList.remove('hidden');
  }

  function setQr(qr) {
    if (qr) {
      els.qrImg.src = qr;
      els.qrImg.classList.remove('hidden');
      els.qrSpinner.classList.add('hidden');
      els.overlayError.classList.add('hidden');
    } else {
      els.qrImg.removeAttribute('src');
      els.qrImg.classList.add('hidden');
      els.qrSpinner.classList.remove('hidden');
    }
  }

  let lastReady = false;
  async function pollStatus() {
    try {
      const data = await api('/api/status');
      setConn(data.state, data.error);
      state.ready = data.state === 'ready';

      if (data.state === 'ready') {
        els.overlay.classList.add('hidden');
        if (!lastReady) {
          lastReady = true;
          const who = data.me?.name ? ` as ${data.me.name}` : '';
          toast(`WhatsApp connected${who}`);
          loadLabels();
        }
      } else {
        lastReady = false;
        if (data.state === 'qr') {
          showOverlay(
            'Link your WhatsApp',
            'Open WhatsApp on your phone → Settings → Linked devices → Link a device, then scan this code.'
          );
          setQr(data.qr);
        } else if (data.state === 'starting' || data.state === 'authenticated') {
          showOverlay('Connecting…', 'Starting the WhatsApp session. This can take a few seconds.');
          setQr(null);
        } else if (data.state === 'error' || data.state === 'disconnected') {
          showOverlay(
            'Connection problem',
            data.error || 'Something went wrong. Try restarting the connection.'
          );
          setQr(null);
          els.overlayError.textContent = data.error || '';
          els.overlayError.classList.toggle('hidden', !data.error);
        }
      }

      updateCounts();
    } catch (err) {
      setConn('error', `Cannot reach the local server: ${err.message}`);
    }
  }

  /* ---------------- recipients ---------------- */

  function selectedTargets() {
    return [...state.recipients.values()].filter((r) => r.selected);
  }

  function addRecipients(list, select = true) {
    let added = 0;
    for (const item of list) {
      if (!item || !item.id) continue;
      if (!state.recipients.has(item.id)) {
        state.recipients.set(item.id, {
          id: item.id,
          name: item.name || formatNumber(item.number) || 'Unknown',
          number: item.number || '',
          selected: select,
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
    const q = state.filter.trim().toLowerCase();
    const all = [...state.recipients.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        String(r.number || '').includes(q) ||
        String(r.id).toLowerCase().includes(q)
    );
  }

  function renderContacts() {
    const list = visibleRecipients();
    els.contactList.textContent = '';

    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = state.recipients.size
        ? 'No recipients match your search.'
        : 'No recipients yet. Pick a label, load contacts, or add numbers.';
      els.contactList.appendChild(li);
    }

    for (const recipient of list) {
      const li = document.createElement('li');
      li.className = `contact-row${recipient.selected ? ' is-selected' : ''}`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = recipient.selected;
      cb.addEventListener('change', () => {
        recipient.selected = cb.checked;
        li.classList.toggle('is-selected', cb.checked);
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
      const num = document.createElement('div');
      num.className = 'contact-num';
      num.textContent = formatNumber(recipient.number);
      meta.append(name, num);

      li.append(cb, avatar, meta);
      li.addEventListener('click', (event) => {
        if (event.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      els.contactList.appendChild(li);
    }

    updateCounts();
    updatePreview();
  }

  function updateCounts() {
    const total = state.recipients.size;
    const selected = selectedTargets().length;
    els.selectedCount.textContent = `${selected} selected${total ? ` of ${total}` : ''}`;

    const visible = visibleRecipients();
    const visibleSelected = visible.filter((r) => r.selected).length;
    els.selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
    els.selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
    els.selectAll.disabled = visible.length === 0;

    const labelName = state.activeLabelId
      ? els.sourceNote.dataset.label || ''
      : '';
    els.sourceNote.textContent = labelName;

    els.sendBtn.disabled = !canSend();
    const people = `${selected} ${selected === 1 ? 'person' : 'people'}`;
    els.sendBtn.textContent = els.dryRun.checked
      ? `Simulate for ${people}`
      : state.mode === 'forward'
        ? `Forward to ${people}`
        : `Send to ${people}`;
  }

  function canSend() {
    if (!state.ready || state.jobId) return false;
    if (!selectedTargets().length) return false;
    if (state.mode === 'forward') return Boolean(state.forward);
    return Boolean(els.message.value.trim() || state.attachment);
  }

  function updateCharCount() {
    const limit = state.attachment ? 1024 : 10000;
    const length = els.message.value.length;
    els.charCount.textContent = state.attachment
      ? `${length} / ${limit} caption`
      : `${length} characters`;
    els.charCount.classList.toggle('over', length > limit);
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

  function updatePreview() {
    const selected = selectedTargets();
    const first = selected[0] || visibleRecipients()[0];

    if (state.mode === 'forward') {
      els.previewWho.textContent = first ? first.name : 'selected recipients';
      const forward = state.forward;
      if (!forward) {
        els.previewBody.textContent = 'Pick a message to forward.';
        return;
      }
      const body = forward.isMedia && forward.filename
        ? `[${forward.type || 'media'}] ${forward.filename}`
        : forward.text;
      els.previewBody.textContent = `Forwarded message\n\n${body || 'Media message'}`;
      return;
    }

    const text = els.message.value;
    if (!text.trim() && !state.attachment) {
      els.previewBody.textContent = 'Your message will appear here.';
      els.previewWho.textContent = 'first recipient';
      return;
    }

    const key = `${text}|${first?.id || ''}|${els.spin.checked}|${state.attachment?.token || ''}`;
    if (key === state.lastPreviewKey) return;
    state.lastPreviewKey = key;

    let body = text.trim() ? renderMessage(text, first?.name || 'there', els.spin.checked) : '';
    if (state.attachment) {
      body = `${body ? `${body}\n\n` : ''}Attachment: ${state.attachment.name}`;
    }
    els.previewBody.textContent = body;
    els.previewWho.textContent = first ? first.name : 'first recipient';
  }

  /* ---------------- labels ---------------- */

  async function loadLabels() {
    els.labelList.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'empty';
    loading.textContent = 'Loading labels…';
    els.labelList.appendChild(loading);

    try {
      const { labels } = await api('/api/labels');
      els.labelList.textContent = '';
      if (!labels.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No contact groups found. Create lists or labels on your phone, or use Contacts / Numbers.';
        els.labelList.appendChild(empty);
        return;
      }
      for (const label of labels) {
        const btn = document.createElement('button');
        btn.className = 'label-btn';
        btn.type = 'button';
        btn.dataset.id = label.id;
        btn.title = label.kind === 'list' ? 'WhatsApp list (personal account)' : 'WhatsApp label (business)';

        const swatch = document.createElement('span');
        swatch.className = 'label-swatch';
        if (label.color) swatch.style.background = `#${String(label.color).replace('#', '')}`;

        const name = document.createElement('span');
        name.className = 'label-name';
        name.textContent = label.name;

        const count = document.createElement('span');
        count.className = 'label-count';
        count.textContent = `${label.count} ${label.count === 1 ? 'chat' : 'chats'}`;

        btn.append(swatch, name, count);
        btn.addEventListener('click', () => selectLabel(label, btn));
        els.labelList.appendChild(btn);
      }
    } catch (err) {
      els.labelList.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `Could not load labels: ${err.message}`;
      els.labelList.appendChild(empty);
    }
  }

  async function selectLabel(label, btn) {
    document.querySelectorAll('.label-btn').forEach((el) => el.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.activeLabelId = label.id;
    els.sourceNote.dataset.label = label.name;

    btn.disabled = true;
    const original = btn.querySelector('.label-count').textContent;
    btn.querySelector('.label-count').textContent = 'loading…';
    try {
      const { contacts } = await api(`/api/labels/${encodeURIComponent(label.id)}/contacts`);
      const added = addRecipients(contacts, true);
      if (!contacts.length) {
        toast(`"${label.name}" has no individual chats.`, true);
      } else {
        toast(`"${label.name}": ${contacts.length} contacts, ${added} new, all selected.`);
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.querySelector('.label-count').textContent = original;
    }
  }

  async function loadContacts() {
    els.loadContactsBtn.disabled = true;
    els.loadContactsBtn.textContent = 'Loading…';
    try {
      const { contacts } = await api('/api/contacts');
      const added = addRecipients(contacts, false);
      toast(`Loaded ${contacts.length} contacts (${added} new). Tick the ones you want.`);
    } catch (err) {
      toast(err.message, true);
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
    if (!lines.length) {
      toast('Paste at least one number first.', true);
      return;
    }

    els.addNumbersBtn.disabled = true;
    els.addNumbersBtn.textContent = 'Checking…';
    els.numbersFeedback.classList.add('hidden');

    try {
      const { resolved, failed } = await api('/api/resolve', {
        method: 'POST',
        body: JSON.stringify({ numbers: lines }),
      });
      addRecipients(resolved, true);

      const parts = [];
      if (resolved.length) parts.push(`${resolved.length} added`);
      if (failed.length) parts.push(`${failed.length} failed`);
      els.numbersFeedback.textContent =
        parts.join(' · ') +
        (failed.length
          ? `\n${failed.map((f) => `• ${f.input}: ${f.reason}`).join('\n')}`
          : '');
      els.numbersFeedback.classList.toggle('ok', !failed.length);
      els.numbersFeedback.classList.remove('hidden');

      if (resolved.length) {
        els.numbersInput.value = failed.map((f) => f.input).join('\n');
        toast(`${resolved.length} numbers added and selected.`);
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      els.addNumbersBtn.disabled = false;
      els.addNumbersBtn.textContent = 'Add numbers';
    }
  }

  /* ---------------- modes, attachments, forwarding ---------------- */

  function setMode(mode) {
    state.mode = mode;
    document
      .querySelectorAll('.mode-tab')
      .forEach((tab) => tab.classList.toggle('is-active', tab.dataset.mode === mode));
    els.composePanel.classList.toggle('hidden', mode !== 'compose');
    els.forwardPanel.classList.toggle('hidden', mode !== 'forward');
    state.lastPreviewKey = '';
    if (mode === 'forward' && !state.sourceChats.length) loadSourceChats();
    updateCharCount();
    updatePreview();
    updateCounts();
  }

  function formatSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderAttachment() {
    const att = state.attachment;
    els.fileChip.classList.toggle('hidden', !att);
    if (!att) return;
    els.fileChipName.textContent = att.name;
    els.fileChipMeta.textContent = `${att.kind} · ${formatSize(att.size)}`;
  }

  async function uploadAttachment(file) {
    if (state.uploading) return;
    if (file.size > 64 * 1024 * 1024) {
      toast('File is too large (max 64 MB).', true);
      return;
    }

    state.uploading = true;
    els.attachBtn.disabled = true;
    els.attachBtn.textContent = 'Uploading…';

    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'X-App-Request': '1' },
        body,
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        /* empty body */
      }
      if (!res.ok) throw new Error((data && data.error) || `Upload failed (${res.status})`);

      const previous = state.attachment;
      state.attachment = data;
      renderAttachment();
      if (previous) {
        api(`/api/upload/${encodeURIComponent(previous.token)}`, { method: 'DELETE' }).catch(() => {});
      }
      state.lastPreviewKey = '';
      updateCharCount();
      updatePreview();
      updateCounts();
      toast(`Attached ${data.name}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.uploading = false;
      els.attachBtn.disabled = false;
      els.attachBtn.textContent = 'Attach a file';
      els.fileInput.value = '';
    }
  }

  function removeAttachment() {
    const previous = state.attachment;
    state.attachment = null;
    renderAttachment();
    if (previous) {
      api(`/api/upload/${encodeURIComponent(previous.token)}`, { method: 'DELETE' }).catch(() => {});
    }
    state.lastPreviewKey = '';
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
      const { chats } = await api('/api/chats');
      state.sourceChats = chats;
      renderSourceChats();
    } catch (err) {
      els.sourceList.textContent = '';
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = `Could not load chats: ${err.message}`;
      els.sourceList.appendChild(empty);
    }
  }

  function renderSourceChats() {
    const q = els.sourceSearch.value.trim().toLowerCase();
    const list = q
      ? state.sourceChats.filter(
          (chat) =>
            chat.name.toLowerCase().includes(q) ||
            String(chat.number || '').includes(q) ||
            String(chat.id).toLowerCase().includes(q)
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
    state.sourceChatName = chat.name;
    els.sourceChatName.textContent = chat.name;
    els.sourceList.classList.add('hidden');
    els.sourceMessages.classList.remove('hidden');
    els.messageList.textContent = '';

    const loading = document.createElement('li');
    loading.className = 'empty';
    loading.textContent = 'Loading messages…';
    els.messageList.appendChild(loading);

    try {
      const { messages } = await api(`/api/chats/${encodeURIComponent(chat.id)}/messages`);
      renderMessages(messages);
    } catch (err) {
      els.messageList.textContent = '';
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = `Could not load messages: ${err.message}`;
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
    document.querySelectorAll('.message-row').forEach((el) => el.classList.remove('is-selected'));
    row.classList.add('is-selected');
    updatePreview();
    updateCounts();
  }

  /* ---------------- sending ---------------- */

  function setJobUi(active) {
    els.cancelBtn.classList.toggle('hidden', !active);
    if (active) {
      els.sendBtn.disabled = true;
      els.sendBtn.textContent = 'Broadcast in progress…';
    } else {
      updateCounts();
    }
  }

  function renderJob(job) {
    els.progress.classList.remove('hidden');
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    els.barFill.style.width = `${pct}%`;

    els.progressTitle.textContent =
      job.status === 'running'
        ? job.dryRun
          ? 'Simulating…'
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

  async function pollJob() {
    if (!state.jobId) return;
    try {
      const { job } = await api(`/api/job/${state.jobId}`);
      renderJob(job);
      if (job.status === 'running') {
        state.jobTimer = setTimeout(pollJob, 900);
      } else {
        const id = state.jobId;
        state.jobId = null;
        state.jobTimer = null;
        setJobUi(false);
        updateCounts();
        if (job.status === 'cancelled') {
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
        if (job.failed) {
          const firstFail = job.results.find((r) => r.error);
          if (firstFail) console.warn('First failure:', firstFail);
        }
        void id;
      }
    } catch (err) {
      state.jobTimer = setTimeout(pollJob, 2000);
    }
  }

  async function send() {
    const message = els.message.value;
    const targets = selectedTargets();
    const forwarding = state.mode === 'forward';

    if (forwarding && !state.forward) return toast('Pick a message to forward first.', true);
    if (!forwarding && !message.trim() && !state.attachment) {
      return toast('Write a message or attach a file first.', true);
    }
    if (!targets.length) return toast('Select at least one recipient.', true);

    const dryRun = els.dryRun.checked;
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
    els.delayMin.value = delayMin;
    els.delayMax.value = delayMax;

    els.sendBtn.disabled = true;
    try {
      const { job } = await api('/api/send', {
        method: 'POST',
        body: JSON.stringify({
          message: forwarding ? '' : message,
          attachmentToken: !forwarding && state.attachment ? state.attachment.token : undefined,
          forwardMessageId: forwarding ? state.forward.id : undefined,
          forwardPreview: forwarding ? state.forward.text || state.forward.filename : undefined,
          targets: targets.map((t) => ({ id: t.id, name: t.name })),
          delayMin,
          delayMax,
          spin: els.spin.checked,
          dryRun,
        }),
      });
      if (!forwarding && state.attachment) {
        state.attachment = null;
        renderAttachment();
        state.lastPreviewKey = '';
        updateCharCount();
        updatePreview();
      }
      state.jobId = job.id;
      els.progress.classList.remove('hidden');
      setJobUi(true);
      renderJob(job);
      pollJob();
    } catch (err) {
      toast(err.message, true);
      setJobUi(false);
      updateCounts();
    }
  }

  async function cancelJob() {
    if (!state.jobId) return;
    els.cancelBtn.disabled = true;
    try {
      await api(`/api/job/${state.jobId}/cancel`, { method: 'POST' });
      toast('Cancelling after the current message…');
    } catch (err) {
      toast(err.message, true);
    } finally {
      els.cancelBtn.disabled = false;
    }
  }

  /* ---------------- wiring ---------------- */

  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.remove('is-active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
      tab.classList.add('is-active');
      $(`#tab-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });

  els.modeTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.mode-tab');
    if (tab) setMode(tab.dataset.mode);
  });

  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (file) uploadAttachment(file);
  });
  els.fileRemove.addEventListener('click', removeAttachment);
  els.sourceSearch.addEventListener('input', renderSourceChats);
  els.backToChats.addEventListener('click', () => {
    els.sourceMessages.classList.add('hidden');
    els.sourceList.classList.remove('hidden');
  });

  document.querySelectorAll('.token').forEach((btn) => {
    btn.addEventListener('click', () => {
      const token = btn.dataset.token;
      const start = els.message.selectionStart ?? els.message.value.length;
      const end = els.message.selectionEnd ?? els.message.value.length;
      const value = els.message.value;
      els.message.value = value.slice(0, start) + token + value.slice(end);
      els.message.focus();
      els.message.selectionStart = els.message.selectionEnd = start + token.length;
      updateCharCount();
      updatePreview();
    });
  });

  els.message.addEventListener('input', () => {
    updateCharCount();
    updatePreview();
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
    document.querySelectorAll('.label-btn').forEach((el) => el.classList.remove('is-active'));
    renderContacts();
  });

  els.loadContactsBtn.addEventListener('click', loadContacts);
  els.addNumbersBtn.addEventListener('click', addNumbers);
  els.sendBtn.addEventListener('click', send);
  els.cancelBtn.addEventListener('click', cancelJob);
  els.overlayRestart.addEventListener('click', restart);
  els.restartBtn.addEventListener('click', restart);
  els.logoutBtn.addEventListener('click', logout);

  async function logout() {
    if (state.jobId) return toast('Stop the current broadcast first.', true);
    if (!window.confirm('Unlink this device? You will need to scan the QR code again.')) return;
    els.logoutBtn.disabled = true;
    try {
      await api('/api/logout', { method: 'POST' });
      state.recipients.clear();
      state.activeLabelId = null;
      els.sourceNote.dataset.label = '';
      renderContacts();
      toast('Unlinked. Scan the QR code to reconnect.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      setTimeout(() => {
        els.logoutBtn.disabled = false;
      }, 2000);
    }
  }

  async function restart() {
    els.overlayRestart.disabled = true;
    try {
      await api('/api/restart', { method: 'POST' });
      toast('Restarting connection…');
    } catch (err) {
      toast(err.message, true);
    } finally {
      setTimeout(() => {
        els.overlayRestart.disabled = false;
      }, 2500);
    }
  }

  els.delayMin.addEventListener('change', () => {
    const min = Number(els.delayMin.value) || 3;
    if (Number(els.delayMax.value) < min) els.delayMax.value = min;
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.jobId) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  updateCharCount();
  renderContacts();
  updatePreview();
  pollStatus();
  setInterval(pollStatus, 2500);
})();

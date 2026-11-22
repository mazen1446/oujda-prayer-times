(() => {
  'use strict';

  const TIME_ZONE = 'Africa/Casablanca';
  const STORAGE_API = 'oujdaPrayerApiUrlV2';
  const STORAGE_SETTINGS = 'oujdaPrayerSettingsV2';
  const ALERT_PREFIX = 'oujdaPrayerAlertV2:';
  const PRAYERS = [
    { key: 'fajr', label: 'الصبح', symbol: '☀' },
    { key: 'dhuhr', label: 'الظهر', symbol: '◉' },
    { key: 'asr', label: 'العصر', symbol: '◷' },
    { key: 'maghrib', label: 'المغرب', symbol: '▣' },
    { key: 'isha', label: 'العشاء', symbol: '☾' }
  ];
  const DEFAULTS = {
    leadMinutes: 10,
    browserEnabled: true,
    inAppEnabled: true,
    soundEnabled: true,
    soundType: 'chime',
    customSoundUrl: '',
    volume: 0.65,
    perPrayer: { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true }
  };

  const $ = id => document.getElementById(id);
  let apiUrl = '';
  let appData = null;
  let settings = loadSettings();
  let swRegistration = null;
  let audioContext = null;
  let customAudio = null;
  let ticking = false;
  let installPrompt = null;
  let toastTimer = null;

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || '{}');
      return { ...DEFAULTS, ...stored, perPrayer: { ...DEFAULTS.perPrayer, ...(stored.perPrayer || {}) } };
    } catch (_) {
      return structuredClone(DEFAULTS);
    }
  }

  function saveSettings(showMessage = true) {
    settings = {
      leadMinutes: clamp(Number($('leadMinutes').value) || 0, 0, 180),
      browserEnabled: $('browserEnabled').checked,
      inAppEnabled: $('inAppEnabled').checked,
      soundEnabled: $('soundEnabled').checked,
      soundType: $('soundType').value,
      customSoundUrl: $('customSoundUrl').value.trim(),
      volume: clamp(Number($('volume').value) / 100, 0, 1),
      perPrayer: Object.fromEntries(PRAYERS.map(p => [p.key, document.querySelector(`[data-prayer="${p.key}"]`).checked]))
    };
    if (settings.customSoundUrl && !/^https:\/\//i.test(settings.customSoundUrl)) {
      toast('رابط الصوت المخصص يجب أن يبدأ بـ https://');
      return;
    }
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
    $('leadInfo').textContent = `التذكير قبل الأذان: ${settings.leadMinutes} دقيقة`;
    if (showMessage) toast('تم حفظ إعدادات التنبيه على هذا الجهاز.');
  }

  function applySettings() {
    $('leadMinutes').value = settings.leadMinutes;
    $('browserEnabled').checked = settings.browserEnabled;
    $('inAppEnabled').checked = settings.inAppEnabled;
    $('soundEnabled').checked = settings.soundEnabled;
    $('soundType').value = settings.soundType;
    $('customSoundUrl').value = settings.customSoundUrl;
    $('volume').value = Math.round(settings.volume * 100);
    $('volumeValue').textContent = `${Math.round(settings.volume * 100)}%`;
    PRAYERS.forEach(p => { document.querySelector(`[data-prayer="${p.key}"]`).checked = settings.perPrayer[p.key] !== false; });
    $('leadInfo').textContent = `التذكير قبل الأذان: ${settings.leadMinutes} دقيقة`;
  }

  function toast(message, duration = 5500) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  function setApiStatus(message, error = false) {
    $('apiStatus').textContent = message;
    $('apiStatus').classList.toggle('error', error);
  }

  function normalizeApiUrl(value) {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') throw new Error('يجب أن يكون الرابط HTTPS.');
    if (!/script\.google\.com$/.test(url.hostname) || !url.pathname.includes('/macros/s/')) {
      throw new Error('الرابط غير صحيح. استخدم رابط نشر Apps Script الذي ينتهي بـ /exec.');
    }
    if (!url.pathname.endsWith('/exec')) throw new Error('استخدم رابط /exec وليس /dev.');
    return url.toString().replace(/\?$/, '');
  }

  function jsonp(url, timeoutMs = 18000) {
    return new Promise((resolve, reject) => {
      const callback = `__oujdaPrayer_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const script = document.createElement('script');
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        delete window[callback];
        script.remove();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('انتهت مهلة الاتصال بخدمة Google Apps Script. تحقق من نشرها وإتاحتها لأي شخص.')), timeoutMs);
      window[callback] = payload => finish(resolve, payload);
      script.onerror = () => finish(reject, new Error('تعذر تحميل رد Google Apps Script. تحقق من رابط /exec وإعدادات النشر.'));
      const separator = url.includes('?') ? '&' : '?';
      script.src = `${url}${separator}callback=${encodeURIComponent(callback)}&t=${Date.now()}`;
      document.head.appendChild(script);
    });
  }

  async function connectToSheet() {
    try {
      const value = $('apiUrl').value.trim() || localStorage.getItem(STORAGE_API) || '';
      apiUrl = normalizeApiUrl(value);
      localStorage.setItem(STORAGE_API, apiUrl);
      setApiStatus('جارٍ الاتصال بورقة وجدة…');
      $('connectBtn').disabled = true;
      await refreshData(true);
    } catch (error) {
      setApiStatus(error.message || String(error), true);
      $('connectionBadge').classList.remove('connected');
      $('connectionBadge').innerHTML = '<i></i> تعذر الاتصال';
    } finally {
      $('connectBtn').disabled = false;
    }
  }

  async function refreshData(showToast = false) {
    if (!apiUrl) {
      setApiStatus('أدخل رابط /exec المنشور من Apps Script للاتصال بورقة وجدة.');
      return;
    }
    $('refreshBtn').disabled = true;
    try {
      const payload = await jsonp(apiUrl);
      if (!payload || payload.ok !== true) throw new Error(payload && payload.error ? payload.error : 'رد غير صالح من خدمة البيانات.');
      if (payload.apiVersion !== 2) throw new Error('نسخة خدمة البيانات قديمة. استبدل Code.gs بالنسخة المرفقة ثم أعد نشر التطبيق.');
      appData = payload;
      localStorage.setItem('oujdaPrayerLastDataV2', JSON.stringify(payload));
      renderAll();
      $('connectionBadge').classList.add('connected');
      $('connectionBadge').innerHTML = '<i></i> متصل بورقة وجدة';
      setApiStatus(`تم الاتصال بنجاح. عدد الأيام المتاحة في الورقة: ${(payload.days || []).length}.`);
      if (showToast) toast('تم الاتصال وتحديث المواقيت من ورقة وجدة.');
    } catch (error) {
      $('connectionBadge').classList.remove('connected');
      $('connectionBadge').innerHTML = '<i></i> تعذر الاتصال';
      setApiStatus(error.message || String(error), true);
      const cached = localStorage.getItem('oujdaPrayerLastDataV2');
      if (cached && !appData) {
        try {
          appData = JSON.parse(cached);
          renderAll();
          setApiStatus('تعذر الاتصال حالياً؛ المعروض نسخة مخزنة سابقاً وقد لا تكون محدثة. ' + (error.message || ''), true);
        } catch (_) { /* Ignore corrupt cache. */ }
      }
    } finally {
      $('refreshBtn').disabled = false;
    }
  }

  function renderAll() {
    if (!appData) return;
    const today = (appData.days || []).find(d => d.dateKey === appData.todayKey);
    $('hijriDate').textContent = today && today.hijri ? `التاريخ الهجري: ${today.hijri}` : 'التاريخ الهجري غير متوفر في الورقة لهذا اليوم';
    $('lastSync').textContent = appData.lastSyncAt ? formatTimestamp(appData.lastSyncAt) : 'لم تتم بعد';
    $('sourceStatus').textContent = appData.lastSyncStatus === 'success' ? 'آخر تحديث ناجح' : appData.lastSyncStatus === 'error' ? 'تعذر آخر تحديث' : 'غير محدد';
    if (appData.lastSyncMessage) $('sourceStatus').title = appData.lastSyncMessage;
    renderPrayerCards(today);
    renderWeek();
    updateClock();
    updateNextPrayer();
  }

  function renderPrayerCards(today) {
    const holder = $('prayerCards');
    if (!today) {
      holder.innerHTML = PRAYERS.map(p => `<article class="prayer-card"><span>${p.symbol}</span><b>${p.label}</b><strong>—</strong></article>`).join('');
      return;
    }
    holder.innerHTML = PRAYERS.map(p => {
      const item = (today.prayers || []).find(x => x.key === p.key);
      const time = item && item.time ? item.time : '—';
      return `<article class="prayer-card" id="card-${p.key}"><span>${p.symbol}</span><b>${p.label}</b><strong>${escapeHtml(time)}</strong></article>`;
    }).join('');
  }

  function renderWeek() {
    const rows = (appData.days || []).slice(0, 7);
    if (!rows.length) {
      $('weekBody').innerHTML = '<tr><td colspan="6" class="empty">لا توجد مواقيت مدخلة للتواريخ القادمة في الورقة.</td></tr>';
      return;
    }
    $('weekBody').innerHTML = rows.map(day => {
      const prayerCells = PRAYERS.map(p => {
        const x = (day.prayers || []).find(y => y.key === p.key);
        return `<td>${escapeHtml(x && x.time ? x.time : '—')}</td>`;
      }).join('');
      const dayLabel = day.weekday || dateWeekday(day.dateKey);
      return `<tr><td class="date-cell"><b>${escapeHtml(dayLabel)}</b><small>${escapeHtml(formatDateKey(day.dateKey))}</small></td>${prayerCells}</tr>`;
    }).join('');
  }

  function getUpcoming() {
    if (!appData) return [];
    const now = Date.now();
    return (appData.days || []).flatMap(day => (day.prayers || []).map(prayer => ({ day, prayer })))
      .filter(x => Number.isFinite(Number(x.prayer.epoch)) && Number(x.prayer.epoch) >= now)
      .sort((a, b) => Number(a.prayer.epoch) - Number(b.prayer.epoch));
  }

  function updateNextPrayer() {
    if (!appData) return;
    document.querySelectorAll('.prayer-card').forEach(el => el.classList.remove('next'));
    const next = getUpcoming()[0];
    if (!next) {
      $('nextName').textContent = 'لا توجد صلاة قادمة مسجلة';
      $('nextTime').textContent = 'أدخل المواقيت في ورقة وجدة أو تحقق من مصدر البيانات';
      $('countdown').textContent = '--:--:--';
      return;
    }
    const diff = Math.max(0, Number(next.prayer.epoch) - Date.now());
    $('nextName').textContent = next.prayer.label;
    $('nextTime').textContent = `${next.day.dateKey === appData.todayKey ? 'اليوم' : formatDateKey(next.day.dateKey)} · ${next.prayer.time}`;
    $('countdown').textContent = formatDuration(diff);
    if (next.day.dateKey === appData.todayKey) {
      const card = $(`card-${next.prayer.key}`);
      if (card) card.classList.add('next');
    }
  }

  function tick() {
    updateClock();
    updateNextPrayer();
    checkAlerts();
  }

  function updateClock() {
    const now = new Date();
    $('clock').textContent = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(now);
    $('gregorianDate').textContent = new Intl.DateTimeFormat('ar-MA', {
      timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }).format(now);
  }

  function checkAlerts() {
    if (!appData) return;
    const leadMs = clamp(Number(settings.leadMinutes) || 0, 0, 180) * 60000;
    const now = Date.now();
    (appData.days || []).forEach(day => (day.prayers || []).forEach(prayer => {
      if (!prayer.epoch || settings.perPrayer[prayer.key] === false) return;
      const prayerEpoch = Number(prayer.epoch);
      const alertAt = prayerEpoch - leadMs;
      const isDue = leadMs === 0 ? (now >= prayerEpoch && now < prayerEpoch + 60000) : (now >= alertAt && now < prayerEpoch);
      if (isDue) {
        const key = `${ALERT_PREFIX}${day.dateKey}:${prayer.key}:${leadMs}`;
        if (localStorage.getItem(key) === '1') return;
        localStorage.setItem(key, '1');
        const message = `اقترب وقت صلاة ${prayer.label}، موعد الأذان ${prayer.time}.`;
        if (settings.inAppEnabled) toast(message, 9000);
        if (settings.browserEnabled && 'Notification' in window && Notification.permission === 'granted') {
          sendNotification(`تذكير بمواقيت الصلاة · وجدة`, message, key);
        }
        if (settings.soundEnabled) playSound();
      }
    }));
  }

  async function sendNotification(title, body, tag) {
    try {
      const options = { body, tag, renotify: false, icon: './icon.svg', badge: './icon.svg', data: { url: location.href } };
      if (swRegistration && swRegistration.showNotification) await swRegistration.showNotification(title, options);
      else new Notification(title, options);
    } catch (error) {
      console.warn('Notification failed', error);
      toast('تعذر عرض إشعار النظام. تحقق من إذن الموقع وإعدادات نظام التشغيل.');
    }
  }

  async function enableNotifications() {
    if (!('Notification' in window)) {
      $('notificationStatus').textContent = 'هذا المتصفح لا يدعم إشعارات الويب. استخدم الرسائل داخل التطبيق والصوت.';
      return;
    }
    if (!window.isSecureContext) {
      $('notificationStatus').textContent = 'يجب فتح التطبيق من رابط HTTPS حتى تعمل الإشعارات.';
      return;
    }
    try {
      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission === 'granted') {
        settings.browserEnabled = true;
        $('browserEnabled').checked = true;
        localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
        $('notificationStatus').textContent = 'الإذن ممنوح لهذا الموقع. تم إرسال إشعار تجريبي.';
        await sendNotification('تم تفعيل التنبيهات · وجدة', 'سيتم تذكيرك قبل الأذان حسب المدة التي اخترتها.', 'oujda-test-notification');
      } else if (permission === 'denied') {
        $('notificationStatus').textContent = 'الإذن مرفوض لهذا الموقع. افتح إعدادات الموقع في Chrome واجعل الإشعارات «سماح»، ثم أعد تحميل التطبيق.';
      } else {
        $('notificationStatus').textContent = 'لم يتم اتخاذ قرار بشأن الإذن. اضغط الزر مرة أخرى واختر السماح.';
      }
    } catch (error) {
      $('notificationStatus').textContent = `تعذر طلب الإذن: ${error.message || error}`;
    }
    updateNotificationState();
  }

  function updateNotificationState() {
    if (!('Notification' in window)) {
      $('notificationStatus').textContent = 'إشعارات النظام غير مدعومة في هذا المتصفح.';
      $('browserEnabled').disabled = true;
      return;
    }
    $('browserEnabled').disabled = Notification.permission !== 'granted';
    if (Notification.permission === 'granted') {
      $('notificationStatus').textContent = 'إذن الإشعارات ممنوح لهذا الموقع. فعّل خيار إشعار المتصفح عند الحاجة.';
      $('browserEnabled').checked = settings.browserEnabled;
    } else if (Notification.permission === 'denied') {
      $('notificationStatus').textContent = 'إذن الإشعارات مرفوض لهذا الموقع. غيّره من إعدادات هذا الموقع في المتصفح.';
      $('browserEnabled').checked = false;
    } else {
      $('notificationStatus').textContent = 'لم يُطلب الإذن بعد. استخدم زر «تفعيل إشعارات المتصفح» من هذه الصفحة المستقلة.';
      $('browserEnabled').checked = false;
    }
  }

  function playSound() {
    if (!settings.soundEnabled || settings.soundType === 'none') return;
    const volume = clamp(Number(settings.volume) || 0.65, 0, 1);
    if (settings.soundType === 'custom' && settings.customSoundUrl) {
      try {
        if (!customAudio || customAudio.src !== settings.customSoundUrl) customAudio = new Audio(settings.customSoundUrl);
        customAudio.volume = volume;
        customAudio.currentTime = 0;
        customAudio.play().catch(() => toast('تعذر تشغيل ملف الصوت؛ تحقق من الرابط المباشر.'));
      } catch (_) { toast('تعذر تشغيل رابط الصوت المخصص.'); }
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioContext = audioContext || new AudioCtx();
      if (audioContext.state === 'suspended') audioContext.resume();
      const patterns = {
        chime: [[660, 0], [880, .18], [1175, .38]],
        bell: [[880, 0], [1320, .12], [1760, .24]],
        soft: [[523, 0], [659, .24], [784, .48]],
        beep: [[880, 0], [880, .30]]
      };
      (patterns[settings.soundType] || patterns.chime).forEach(([freq, delay]) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const start = audioContext.currentTime + delay;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(volume * .2, start + .025);
        gain.gain.exponentialRampToValueAtTime(.001, start + .45);
        osc.connect(gain); gain.connect(audioContext.destination);
        osc.start(start); osc.stop(start + .46);
      });
    } catch (error) { console.warn('Audio error', error); }
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  }

  function formatDateKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('ar-MA', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  }

  function dateWeekday(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('ar-MA', { timeZone: TIME_ZONE, weekday: 'long' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  }

  function formatTimestamp(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'غير معروف';
    return new Intl.DateTimeFormat('ar-MA', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try { swRegistration = await navigator.serviceWorker.register('./sw.js'); }
    catch (error) { console.warn('Service worker registration failed', error); }
  }

  function initializeInstallPrompt() {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      installPrompt = event;
      $('installBtn').hidden = false;
    });
    $('installBtn').addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      $('installBtn').hidden = true;
    });
  }

  function bindEvents() {
    $('connectBtn').addEventListener('click', connectToSheet);
    $('refreshBtn').addEventListener('click', () => refreshData(true));
    $('enableNotificationsBtn').addEventListener('click', enableNotifications);
    $('saveSettingsBtn').addEventListener('click', () => saveSettings(true));
    $('testSoundBtn').addEventListener('click', () => { saveSettings(false); playSound(); toast('تم إرسال أمر اختبار الصوت.'); });
    $('volume').addEventListener('input', () => { $('volumeValue').textContent = `${$('volume').value}%`; });
    $('browserEnabled').addEventListener('change', () => {
      if (Notification.permission !== 'granted' && $('browserEnabled').checked) {
        $('browserEnabled').checked = false;
        toast('فعّل إذن المتصفح أولاً باستخدام الزر أدناه.');
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && apiUrl) refreshData(false); });
  }

  async function init() {
    applySettings();
    bindEvents();
    updateClock();
    updateNotificationState();
    await registerServiceWorker();
    initializeInstallPrompt();
    apiUrl = localStorage.getItem(STORAGE_API) || '';
    if (apiUrl) {
      $('apiUrl').value = apiUrl;
      await refreshData(false);
    }
    setInterval(tick, 1000);
    setInterval(() => { if (apiUrl) refreshData(false); }, 5 * 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

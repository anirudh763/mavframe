const INSTALL_DISMISSED = 'mavframe_pwa_install_dismissed_v1';
const LEGACY_INSTALL_DISMISSED = 'mavframe:pwa:install-dismissed:v1';
const UPDATE_CHANNEL = 'mavframe:pwa-update:v1';
let installPrompt = null;
let registration = null;
let updatePending = false;
let updateChannel = null;
let isBusy = () => false;
let updateNotice = () => {};
let offlineNotice = () => {};
let installOpener = null;
const appBase = new URL('../', import.meta.url);
const workerURL = new URL('../sw.js', import.meta.url);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const dismissed = () => { try { const value = localStorage.getItem(INSTALL_DISMISSED) || localStorage.getItem(LEGACY_INSTALL_DISMISSED); if (value === '1' && !localStorage.getItem(INSTALL_DISMISSED)) localStorage.setItem(INSTALL_DISMISSED, '1'); return value === '1'; } catch { return false; } };
function hideInstallControls() {
  for (const button of document.querySelectorAll('.pwa-install,.pwa-help')) button.hidden = true;
}
function updateInstallControls() {
  hideInstallControls();
  if (standalone() || dismissed()) return;
  if (installPrompt) for (const button of document.querySelectorAll('.pwa-install')) button.hidden = false;
  else if (isIOS()) for (const button of document.querySelectorAll('.pwa-help')) button.hidden = false;
}
function showOffline(text, isError = false) {
  const node = document.getElementById('offline-status');
  if (node) { node.textContent = text; node.setAttribute('aria-label', text); node.dataset.state = isError ? 'error' : 'ready'; }
  const publicNode = document.getElementById('pwa-status-public');
  if (publicNode) { publicNode.textContent = text; publicNode.dataset.state = isError ? 'error' : 'ready'; }
  offlineNotice(text, isError);
}
function requestStatus(worker) {
  if (!worker || !('MessageChannel' in window)) return Promise.resolve(null);
  return new Promise(resolve => {
    const channel = new MessageChannel(); const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 3000);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
    worker.postMessage({ type: 'GET_OFFLINE_STATUS' }, [channel.port2]);
  });
}
async function checkOffline() {
  if (!('serviceWorker' in navigator)) {
    showOffline('Offline caching is unavailable in this browser. Keep this tab open while working.', true); return false;
  }
  if (!navigator.serviceWorker.controller) {
    showOffline(navigator.onLine ? 'Offline preparation is finishing. Keep this tab online, then reload once.' : 'This app has not been prepared for offline use. Reconnect and open it once.', true);
    return false;
  }
  try {
    const status = await requestStatus(navigator.serviceWorker.controller);
    if (!status?.ready) throw new Error('Required offline assets are incomplete.');
    showOffline('Offline assets verified on this device. First use requires one complete online visit; the browser may later evict cached files.');
    return true;
  } catch {
    showOffline('Offline cache could not be verified. Reconnect and reload to prepare it again.', true); return false;
  }
}
function hasBusyPeer(token) {
  if (!updateChannel) return Promise.resolve(false);
  return new Promise(resolve => {
    let busy = false;
    const listener = ({ data }) => { if (data?.type === 'busy-state' && data.token === token && data.busy) busy = true; };
    updateChannel.addEventListener('message', listener);
    updateChannel.postMessage({ type: 'check-busy', token });
    setTimeout(() => { updateChannel.removeEventListener('message', listener); resolve(busy); }, 220);
  });
}
function wireUpdateChannel() {
  if (!('BroadcastChannel' in window)) return;
  updateChannel = new BroadcastChannel(UPDATE_CHANNEL);
  updateChannel.addEventListener('message', ({ data }) => {
    if (data?.type === 'check-busy') updateChannel.postMessage({ type: 'busy-state', token: data.token, busy: Boolean(isBusy()) });
    if (data?.type === 'arm-update') updatePending = true;
  });
}
function watchRegistration(reg) {
  registration = reg;
  const showWaiting = () => { if (registration.waiting && navigator.serviceWorker.controller) updateNotice(true); };
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) showWaiting(); });
  });
  showWaiting();
}
export function initPwa({ busy = () => false, onUpdateAvailable = () => {}, onOfflineStatus = () => {} } = {}) {
  isBusy = busy; updateNotice = onUpdateAvailable; offlineNotice = onOfflineStatus;
  wireUpdateChannel(); updateInstallControls();
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event; updateInstallControls();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; updateInstallControls(); });
  for (const button of document.querySelectorAll('.pwa-install')) button.addEventListener('click', async () => {
    const prompt = installPrompt;
    if (!prompt) { updateInstallControls(); return; }
    installPrompt = null; updateInstallControls();
    try {
      await prompt.prompt(); const choice = await prompt.userChoice;
      if (choice?.outcome === 'dismissed') {
        try { localStorage.setItem(INSTALL_DISMISSED, '1'); } catch { /* Current-page dismissal still applies. */ }
        showOffline('Install was dismissed. You can still use Mavframe in this browser.');
      }
    } catch { showOffline('The browser could not open its install prompt. Use the browser menu if installation is available.', true); }
  });
  for (const button of document.querySelectorAll('.pwa-help')) button.addEventListener('click', () => { installOpener = button; document.getElementById('install-dialog')?.showModal(); });
  for (const id of ['dismiss-install', 'close-install']) document.getElementById(id)?.addEventListener('click', () => document.getElementById('install-dialog')?.close());
  document.getElementById('dismiss-install')?.addEventListener('click', () => {
    try { localStorage.setItem(INSTALL_DISMISSED, '1'); } catch { /* Dismiss locally for this page. */ }
    hideInstallControls();
  });
  document.getElementById('install-dialog')?.addEventListener('close', () => { const opener = installOpener; installOpener = null; opener?.focus(); });

  if (!('serviceWorker' in navigator)) { checkOffline(); return { checkOffline, acceptUpdate, get registration() { return registration; } }; }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    checkOffline();
    if (!updatePending) return;
    if (isBusy()) { updateNotice(true, 'The update is active. This tab has work open; use the reload action when it is safe.'); return; }
    updatePending = false; location.reload();
  });
  navigator.serviceWorker.register(workerURL, { scope: appBase.pathname, updateViaCache: 'none' })
    .then(reg => { watchRegistration(reg); return navigator.serviceWorker.ready; })
    .then(async reg => { watchRegistration(reg); await checkOffline(); })
    .catch(() => showOffline('Offline cache is unavailable. Reconnect before reloading or opening the sample.', true));
  return { checkOffline, acceptUpdate, get registration() { return registration; } };
}

export async function acceptUpdate() {
  if (!registration?.waiting) return { ok: false, reason: 'missing' };
  if (isBusy()) return { ok: false, reason: 'busy' };
  if (!updateChannel) return { ok: false, reason: 'coordination-unavailable' };
  const token = crypto.randomUUID?.() || String(Date.now());
  if (await hasBusyPeer(token)) return { ok: false, reason: 'peer-busy' };
  if (isBusy()) return { ok: false, reason: 'busy' };
  updatePending = true;
  updateChannel?.postMessage({ type: 'arm-update' });
  registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  return { ok: true };
}

export async function shareTextOrFile({ title, text, file }) {
  if (typeof navigator.share === 'function') {
    try {
      if (file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ title, files: [file] });
      } else {
        await navigator.share({ title, text });
      }
      return { method: 'native', delivered: false };
    } catch (error) {
      if (error?.name === 'AbortError') return { method: 'cancelled', delivered: false };
      // A native-share error falls through to the explicit clipboard fallback.
    }
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable.');
    await navigator.clipboard.writeText(text);
    return { method: 'clipboard', delivered: false };
  } catch { return { method: 'unavailable', delivered: false }; }
}

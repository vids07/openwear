const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') document.documentElement.classList.add('keyboard-navigation');
});
document.addEventListener('pointerdown', () => {
  document.documentElement.classList.remove('keyboard-navigation');
});

const tryonSheet = $('#tryon-sheet');
const signupSheet = $('#signup-sheet');
const signupForm = $('#signup-form');
const signupError = $('#signup-error');
const signupGoogle = $('#signup-google');
const signupDev = $('#signup-dev');
const signupOr = $('#signup-or');
const signupSubtitle = $('#signup-subtitle');

const stage = $('#tryon-stage');
const video = $('#tryon-video');
const garmentShot = $('#tryon-garment');
const cameraButton = $('#camera-demo');
const tryonIcon = $('#tryon-icon');
const tryonTitle = $('#tryon-title');
const tryonCopy = $('#tryon-copy');
const tryonNote = $('#tryon-note');
const tryonTimer = $('#tryon-timer');

const signupNote = $('#signup-note');
const demoSection = $('#demo');
const demoPrompt = $('#demo-prompt');

const CONTACT_URL = 'https://cal.com/indiclabs-m02a0z/30min';
const SESSION_CACHE_KEY = 'lookon.session';

// ── Session state (server is the source of truth; localStorage is a hint) ──
let session = readCachedSession() || { signedIn: false, eligible: false, trialSeconds: 60, googleEnabled: false, devLoginEnabled: true, liveTryOn: false };
let pendingGarment = null;

// The in-flight trial.
let activeSessionId = null;
let activeGarment = null;
let liveActive = false;       // true once transformed frames are showing
let expectDisconnect = false; // true when WE end the session, so a drop is expected

function readCachedSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_CACHE_KEY) || 'null'); }
  catch { return null; }
}
function cacheSession() {
  try { localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(session)); }
  catch { /* private mode: fine, server still decides */ }
}

async function refreshSession() {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    if (res.ok) {
      session = await res.json();
      cacheSession();
    }
  } catch { /* offline: keep whatever we have */ }
  applySignupOptions();
  return session;
}

function applySignupOptions() {
  if (signupGoogle) signupGoogle.hidden = !session.googleEnabled;
  if (signupDev) signupDev.hidden = !session.devLoginEnabled;
  if (signupOr) signupOr.hidden = !(session.googleEnabled && session.devLoginEnabled);
  if (signupSubtitle && session.googleEnabled) {
    signupSubtitle.textContent = 'Sign in once, then open a free try-on for any garment on this page.';
  }
  if (signupNote) {
    signupNote.textContent = session.liveTryOn
      ? 'One free try-on per account and per device. Your camera streams to the try-on engine to render the garment on you live.'
      : 'One free try-on per account and per device. Your camera stays on your device — nothing is uploaded.';
  }
}

// ── Try-on modal states ─────────────────────────────────────────────
const idle = {
  title: 'Try it on',
  copy: 'Turn on your camera and watch this garment render onto you, live and moving with you.',
  note: 'Your camera runs on your device only — nothing is uploaded, recorded, or sent anywhere.',
};

let stream = null;
let countdownId = null;

function clearCountdown() {
  if (countdownId !== null) { window.clearInterval(countdownId); countdownId = null; }
  if (tryonTimer) tryonTimer.hidden = true;
}

const showReady = () => {
  clearCountdown();
  resetOutputVideo();
  tryonIcon.classList.remove('spinning');
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = idle.title;
  tryonCopy.textContent = idle.copy;
  tryonNote.textContent = session.liveTryOn
    ? 'Your camera streams to the try-on engine and the garment renders on you in real time.'
    : idle.note;
  const secs = session.trialSeconds || 60;
  cameraButton.textContent = `Turn on camera · ${secs}s free try`;
  cameraButton.dataset.role = 'camera';
  cameraButton.hidden = false;
  cameraButton.disabled = false;
};

const showUsed = () => {
  clearCountdown();
  stopStream();
  resetOutputVideo();
  tryonIcon.classList.remove('spinning');
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = 'That’s your free try-on';
  tryonCopy.textContent = 'You’ve used the one free try-on for this account and device. Want it live for every shopper on your store?';
  tryonNote.textContent = '';
  cameraButton.hidden = true;
};

const failWith = (message) => {
  clearCountdown();
  stopRealtime();
  stopStream();
  tryonIcon.classList.remove('spinning');
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = 'Camera didn’t start';
  tryonCopy.textContent = message;
  cameraButton.hidden = false;
  cameraButton.textContent = 'Close';
  cameraButton.disabled = false;
  cameraButton.dataset.role = 'close';
};

const failLive = (message) => {
  liveActive = false;
  clearCountdown();
  stopRealtime();
  stopStream();
  resetOutputVideo();
  tryonIcon.classList.remove('spinning');
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = 'Live try-on didn’t connect';
  tryonCopy.textContent = message;
  tryonNote.textContent = '';
  cameraButton.hidden = false;
  cameraButton.disabled = false;
  cameraButton.textContent = 'Close';
  cameraButton.dataset.role = 'close';
};

// The live stream dropped before the timer ran out (credits exhausted, quota,
// or a network drop). Show a clean end state instead of a frozen frame.
const showEnded = () => {
  if (!liveActive) return; // ignore late/duplicate disconnect events
  liveActive = false;
  clearCountdown();
  stopStream();
  resetOutputVideo();
  tryonIcon.classList.remove('spinning');
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = 'Your live try-on ended';
  tryonCopy.textContent = 'The live session stopped. That’s your one free try — want it live for every shopper on your store?';
  tryonNote.textContent = '';
  cameraButton.hidden = false;
  cameraButton.disabled = false;
  cameraButton.textContent = 'Close';
  cameraButton.dataset.role = 'close';
  endTrial(activeSessionId);
};

function stopStream() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

// The <video> may hold the transformed WebRTC stream; drop it before reuse.
function resetOutputVideo() {
  video.srcObject = null;
  video.classList.remove('is-result');
}

function formatTime(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── The gated try-on session ─────────────────────────────────────────
async function beginTrial() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    failWith('Browsers only allow camera access over HTTPS or on localhost. Open this page on a secure address and try again.');
    return;
  }

  cameraButton.disabled = true;
  cameraButton.textContent = 'Starting…';

  // 1) Consume the one free trial, server-side.
  let start;
  try {
    const res = await fetch('/api/trial/start', { method: 'POST', credentials: 'same-origin' });
    start = { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    failWith('Could not reach the try-on service. Please try again.');
    return;
  }

  if (start.status === 401) { tryonSheet.close(); openSignup(pendingGarment); return; }
  if (start.status === 403) { session.eligible = false; cacheSession(); showUsed(); return; }
  if (start.status !== 200) { failWith('Something went wrong starting your try-on. Please try again.'); return; }

  // The trial is now spent regardless of what happens next.
  session.eligible = false;
  cacheSession();
  activeSessionId = start.body.sessionId;
  activeGarment = garmentShot?.src || null;

  // 2) Open the camera (shown as a mirrored preview while we connect).
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
    resetOutputVideo();
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    if (error.name === 'NotAllowedError') failWith('Camera permission was blocked, and this was your one free try. Allow the camera and reach out to see it on your store.');
    else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') failWith('No camera was found on this device.');
    else if (error.name === 'NotReadableError') failWith('Another app is already using the camera. Close it and try again.');
    else failWith('Something stopped the camera from starting.');
    endTrial(activeSessionId);
    return;
  }

  stage.hidden = false;
  tryonIcon.hidden = true;
  cameraButton.hidden = true;

  // 3) Connect the realtime try-on (or a plain preview if no key is set).
  const deadline = start.body.expiresAt ? start.body.expiresAt * 1000 : Date.now() + (start.body.expiresIn || 60) * 1000;
  await startRealtime(activeSessionId, activeGarment, deadline);
}

// ── Realtime try-on (WebRTC via the bundled Decart SDK) ──────────────
function showConnecting(message) {
  stage.hidden = false;
  tryonIcon.hidden = true;
  tryonTitle.textContent = 'Connecting…';
  tryonCopy.textContent = message;
  tryonNote.textContent = '';
  cameraButton.hidden = true;
}

async function fetchGarment(src) {
  if (!src) return null;
  try {
    const res = await fetch(src);
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}

async function startRealtime(sessionId, garmentSrc, deadline) {
  showConnecting('Starting your live try-on…');

  // 1) Ephemeral token (the server mints it from the secret key).
  let tok;
  try {
    const res = await fetch(`/api/tryon/token?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', credentials: 'same-origin' });
    tok = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(tok.error || 'token_failed');
  } catch {
    failLive('We couldn’t start the live try-on. Please try again on your store.');
    endTrial(sessionId);
    return;
  }

  // No key on the server → plain camera preview so the flow is still testable.
  if (tok.mode === 'stub') { stubPreview(deadline); return; }

  if (!window.LookOnRealtime) {
    failLive('The try-on engine failed to load. Please refresh and try again.');
    endTrial(sessionId);
    return;
  }

  // 2) Open the WebRTC session and swap the preview for the transformed stream.
  const image = await fetchGarment(garmentSrc);
  let connected = false;
  expectDisconnect = false;
  try {
    await window.LookOnRealtime.connect({
      token: tok.token,
      stream,
      model: tok.model,
      image,
      prompt: 'Dress the person in the garment shown in the reference image.',
      onRemoteStream: (transformed) => {
        connected = true;
        video.srcObject = transformed;
        video.classList.add('is-result'); // SDK handles mirroring
        video.play?.().catch(() => {});
        liveOn(deadline);
      },
      onConnectionChange: (state) => {
        // A drop we didn't cause, after we were live, means the session ended early.
        if (state === 'disconnected' && connected && !expectDisconnect) showEnded();
      },
      onError: () => {
        if (!connected) { failLive('The live try-on couldn’t connect. Please try again on your store.'); endTrial(sessionId); }
        else showEnded();
      },
    });
  } catch {
    failLive('The live try-on couldn’t connect. Please try again on your store.');
    endTrial(sessionId);
    return;
  }

  // Safety net: if no frames arrive within 25s, surface an error.
  window.setTimeout(() => {
    if (!connected) { failLive('The try-on engine didn’t respond in time. Please try again.'); endTrial(sessionId); }
  }, 25000);
}

function liveOn(deadline) {
  liveActive = true;
  clearCountdown();
  tryonTitle.textContent = 'You’re wearing it';
  tryonCopy.textContent = 'Move around — the garment tracks you live. This is exactly what your shoppers get.';
  tryonNote.textContent = 'Live from the try-on engine. Ends when the timer runs out.';
  cameraButton.hidden = true;
  runCountdown(deadline);
}

function stubPreview(deadline) {
  clearCountdown();
  tryonTitle.textContent = 'Camera preview';
  tryonCopy.textContent = 'The try-on engine isn’t connected (no API key), so this is just your camera.';
  tryonNote.textContent = 'Add DECART_API_KEY on the server to render the garment live.';
  cameraButton.hidden = true;
  runCountdown(deadline);
}

function runCountdown(deadline) {
  if (tryonTimer) tryonTimer.hidden = false;
  const tick = () => {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (tryonTimer) tryonTimer.textContent = formatTime(left);
    if (left <= 0) { endTrial(activeSessionId); showUsed(); }
  };
  tick();
  countdownId = window.setInterval(tick, 250);
}

function stopRealtime() {
  try { window.LookOnRealtime?.stop?.(); } catch { /* nothing live */ }
}

function endTrial(sessionId) {
  expectDisconnect = true; // we're ending on purpose; ignore the resulting drop
  liveActive = false;
  clearCountdown();
  stopRealtime();
  stopStream();
  if (sessionId) {
    fetch('/api/trial/end', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }
}

// ── Opening flows ────────────────────────────────────────────────────
function setGarment(garmentSrc) {
  const src = garmentSrc || $('.garment img')?.src;
  if (src) { garmentShot.src = src; garmentShot.hidden = false; }
  else garmentShot.hidden = true;
}

function openTryon(garmentSrc) {
  setGarment(garmentSrc);
  cameraButton.dataset.role = 'camera';
  if (session.eligible) showReady(); else showUsed();
  tryonSheet.showModal();
}

function openSignup(garmentSrc) {
  pendingGarment = garmentSrc;
  signupError.hidden = true;
  signupForm?.reset();
  applySignupOptions();
  signupSheet.showModal();
}

async function requestTryon(garmentSrc) {
  await refreshSession();
  if (!session.signedIn) openSignup(garmentSrc);
  else openTryon(garmentSrc);
}

const showSignupError = (message) => { signupError.textContent = message; signupError.hidden = false; };

// Google: full-page redirect to the OAuth flow.
signupGoogle?.addEventListener('click', () => { window.location.href = '/auth/google'; });

// Dev fallback: name + email (unverified) when Google isn't configured.
signupForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = signupForm.elements.name.value.trim();
  const email = signupForm.elements.email.value.trim();
  if (!name) return showSignupError('Please enter your name.');
  if (!/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(email)) return showSignupError('Please enter a valid email address.');

  try {
    const res = await fetch('/auth/dev', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    if (!res.ok) return showSignupError('Could not create your account. Please try again.');
  } catch {
    return showSignupError('Could not reach the server. Please try again.');
  }

  signupSheet.close();
  await refreshSession();
  openTryon(pendingGarment);
  pendingGarment = null;
});

signupSheet.addEventListener('close', () => { pendingGarment = null; });

// Generic "Try it on" CTAs nudge shoppers to the garment grid; only a garment
// tile actually opens the try-on.
let demoPromptTimeout;
let demoPromptObserver;
function hideDemoPrompt() {
  clearTimeout(demoPromptTimeout);
  demoPromptObserver?.disconnect();
  demoPromptObserver = null;
  if (demoPrompt) demoPrompt.hidden = true;
  demoSection?.classList.remove('is-choosing');
}

function showGarmentChoices() {
  hideDemoPrompt();
  demoSection?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
  const firstGarment = $('.garment');
  if (!firstGarment || !demoPrompt) return;
  demoPromptObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    demoPrompt.hidden = false;
    demoSection?.classList.add('is-choosing');
    demoPromptObserver?.disconnect();
    demoPromptObserver = null;
    demoPromptTimeout = setTimeout(hideDemoPrompt, 6000);
  }, { threshold: .1 });
  demoPromptObserver.observe(firstGarment);
}

$$('.open-tryon').forEach((button) =>
  button.addEventListener('click', () => {
    if (!button.classList.contains('garment')) return showGarmentChoices();
    hideDemoPrompt();
    requestTryon(button.querySelector('img')?.src);
  }),
);

// The action button: start the trial, or close/finish.
cameraButton.addEventListener('click', () => {
  if (cameraButton.dataset.role === 'close') { tryonSheet.close(); return; }
  beginTrial();
});

tryonSheet.addEventListener('close', () => { endTrial(activeSessionId); activeSessionId = null; resetOutputVideo(); });

$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
});

// Prime session state on load (updates the signup sheet + used/ready state).
refreshSession();

// ── Scroll reveal ────────────────────────────────────────────────────
// Every section below the hero fades up block by block as it scrolls in.
// Blocks entering together are staggered; once shown, the reveal classes
// come off so hover transforms on cards keep working.
(function setupScrollReveal() {
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const blocks = [
    '.eyebrow', 'h2', '.section-intro', '.steps-intro', '.caption-wide',
    '.garment', '.store-marquees', '.why-media', '.metric', '.step-card',
    '.platform', '.accordion details',
  ].map((sel) => `main > section:not(.hero) ${sel}`).join(',');
  const targets = $$(blocks);
  if (!targets.length) return;

  document.documentElement.classList.add('reveal-on');
  targets.forEach((el) => el.classList.add('reveal'));

  const finish = (el) => {
    el.classList.remove('reveal', 'is-visible');
    el.style.removeProperty('--reveal-delay');
  };

  const observer = new IntersectionObserver((entries) => {
    let order = 0;
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      observer.unobserve(el);
      const delay = Math.min(order++ * 90, 540);
      el.style.setProperty('--reveal-delay', `${delay}ms`);
      el.classList.add('is-visible');
      window.setTimeout(() => finish(el), delay + 900);
    });
  }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });

  targets.forEach((el) => observer.observe(el));
})();

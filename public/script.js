const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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

const CONTACT_URL = 'https://cal.com/indiclabs-m02a0z/30min';
const SESSION_CACHE_KEY = 'openwear.session';

// ── Session state (server is the source of truth; localStorage is a hint) ──
let session = readCachedSession() || { signedIn: false, eligible: false, trialSeconds: 60, googleEnabled: false, devLoginEnabled: true };
let pendingGarment = null;

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
}

// ── Try-on modal states ─────────────────────────────────────────────
const idle = {
  title: 'Try it on',
  copy: 'This is exactly what your shopper sees: camera on, your garment on them, moving in real time.',
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
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = idle.title;
  tryonCopy.textContent = idle.copy;
  tryonNote.textContent = idle.note;
  const secs = session.trialSeconds || 60;
  cameraButton.textContent = `Turn on camera · ${secs}s free try`;
  cameraButton.hidden = false;
  cameraButton.disabled = false;
};

const showUsed = () => {
  clearCountdown();
  stopStream();
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = 'That’s your free try-on';
  tryonCopy.textContent = 'You’ve used the one free try-on for this account and device. Want it live for every shopper on your store?';
  tryonNote.textContent = '';
  cameraButton.hidden = true;
};

const failWith = (message) => {
  clearCountdown();
  stopStream();
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = 'Camera didn’t start';
  tryonCopy.textContent = message;
  cameraButton.hidden = false;
  cameraButton.textContent = 'Close';
  cameraButton.disabled = false;
  cameraButton.dataset.role = 'close';
};

function stopStream() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
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

  // 2) Open the camera.
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    if (error.name === 'NotAllowedError') failWith('Camera permission was blocked, and this was your one free try. Allow the camera and reach out to see it on your store.');
    else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') failWith('No camera was found on this device.');
    else if (error.name === 'NotReadableError') failWith('Another app is already using the camera. Close it and try again.');
    else failWith('Something stopped the camera from starting.');
    endTrial(start.body.sessionId);
    return;
  }

  // 3) Live, with the hard countdown anchored to the server’s expiry.
  stage.hidden = false;
  tryonIcon.hidden = true;
  tryonTitle.textContent = 'Camera is live';
  tryonCopy.textContent = start.body.mode === 'stub'
    ? 'Move around. Once the Decart try-on is connected, your garment renders onto this feed in real time.'
    : 'Move around — your garment renders onto you in real time.';
  tryonNote.textContent = 'Running on your device. This free try-on ends when the timer runs out.';
  cameraButton.hidden = true;

  const deadline = start.body.expiresAt ? start.body.expiresAt * 1000 : Date.now() + (start.body.expiresIn || 60) * 1000;
  const sessionId = start.body.sessionId;
  if (tryonTimer) {
    tryonTimer.hidden = false;
    tryonTimer.textContent = formatTime(Math.ceil((deadline - Date.now()) / 1000));
  }
  countdownId = window.setInterval(() => {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (tryonTimer) tryonTimer.textContent = formatTime(left);
    if (left <= 0) { endTrial(sessionId); showUsed(); }
  }, 250);
}

function endTrial(sessionId) {
  clearCountdown();
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

$$('.open-tryon').forEach((button) =>
  button.addEventListener('click', () => requestTryon(button.querySelector('img')?.src)),
);

// The action button: start the trial, stop early, or close after an error.
cameraButton.addEventListener('click', () => {
  if (cameraButton.dataset.role === 'close') { tryonSheet.close(); return; }
  if (stream) { endTrial(null); showUsed(); return; }
  beginTrial();
});

tryonSheet.addEventListener('close', () => { endTrial(null); clearCountdown(); });

$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
});

// Prime session state on load (updates the signup sheet + used/ready state).
refreshSession();

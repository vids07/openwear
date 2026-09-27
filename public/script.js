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

const signupNote = $('#signup-note');

const CONTACT_URL = 'https://cal.com/indiclabs-m02a0z/30min';
const SESSION_CACHE_KEY = 'lookon.session';
const RECORD_SECONDS = 6;

// ── Session state (server is the source of truth; localStorage is a hint) ──
let session = readCachedSession() || { signedIn: false, eligible: false, trialSeconds: 60, googleEnabled: false, devLoginEnabled: true, liveTryOn: false };
let pendingGarment = null;

// The in-flight trial (set when the camera goes live).
let activeSessionId = null;
let activeGarment = null;
let activeMode = 'stub';
let jobAborted = false;

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
      ? 'One free try-on per account and per device. You’ll record a few seconds; that clip is sent to the try-on engine to render your garment.'
      : 'One free try-on per account and per device. Your camera stays on your device — nothing is uploaded.';
  }
}

// ── Try-on modal states ─────────────────────────────────────────────
const idle = {
  title: 'Try it on',
  copy: `Turn on your camera, record about ${RECORD_SECONDS} seconds, and see this garment rendered onto you.`,
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
  resetResultVideo();
  tryonIcon.classList.remove('spinning');
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = idle.title;
  tryonCopy.textContent = idle.copy;
  tryonNote.textContent = session.liveTryOn
    ? `You’ll record about ${RECORD_SECONDS}s; that clip is sent to the try-on engine to render this garment onto you.`
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
  resetResultVideo();
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

function stopStream() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

// When the <video> was showing a result clip (src, not the live srcObject),
// release it before reusing the element for the camera.
function resetResultVideo() {
  if (video.src) {
    if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
  video.classList.remove('is-result');
  video.loop = false;
  video.controls = false;
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

  // 3) Live: give them the trial window to hit "Record", then capture a clip.
  activeSessionId = start.body.sessionId;
  activeGarment = garmentShot?.src || null;
  activeMode = start.body.mode; // 'live' when a Decart key is set, else 'stub'
  jobAborted = false;

  stage.hidden = false;
  tryonIcon.hidden = true;
  tryonTitle.textContent = 'Camera is live';
  tryonCopy.textContent = session.liveTryOn
    ? `When you’re ready, record a ${RECORD_SECONDS}s clip. We’ll send just that clip to the try-on engine and show this garment on you.`
    : `Preview only for now — Decart isn’t connected, so recording just plays your clip back. Record ${RECORD_SECONDS}s to see the flow.`;
  tryonNote.textContent = session.liveTryOn
    ? 'To render the garment, your recorded clip is sent to the try-on engine.'
    : 'Nothing leaves your device yet — the try-on engine isn’t connected.';
  cameraButton.hidden = false;
  cameraButton.disabled = false;
  cameraButton.dataset.role = 'record';
  cameraButton.textContent = `Record ${RECORD_SECONDS}s`;

  // A hard window to decide to record, anchored to the server’s expiry.
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

// ── Recording the clip ───────────────────────────────────────────────
function pickMime() {
  const prefs = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const t of prefs) if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  return '';
}

function recordClip(seconds) {
  return new Promise((resolve, reject) => {
    if (!window.MediaRecorder || !stream) return reject(new Error('no_recorder'));
    let recorder;
    try {
      const mime = pickMime();
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (error) {
      return reject(error);
    }
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
    recorder.onerror = (event) => reject(event.error || new Error('record_failed'));
    recorder.start();
    window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, seconds * 1000);
  });
}

async function startRecording() {
  cameraButton.disabled = true;
  cameraButton.textContent = 'Recording…';
  clearCountdown(); // committed — the decide-to-record window no longer applies
  tryonTitle.textContent = 'Recording…';
  tryonCopy.textContent = 'Move a little so the garment can track you.';

  let left = RECORD_SECONDS;
  if (tryonTimer) { tryonTimer.hidden = false; tryonTimer.textContent = `REC ${left}`; }
  const recTick = window.setInterval(() => {
    left -= 1;
    if (tryonTimer) tryonTimer.textContent = `REC ${Math.max(0, left)}`;
    if (left <= 0) window.clearInterval(recTick);
  }, 1000);

  let clip;
  try {
    clip = await recordClip(RECORD_SECONDS);
  } catch {
    window.clearInterval(recTick);
    if (tryonTimer) tryonTimer.hidden = true;
    failResult('We couldn’t record from your camera. Please try again on your store.');
    endTrial(activeSessionId);
    return;
  }
  window.clearInterval(recTick);
  if (tryonTimer) tryonTimer.hidden = true;
  await processClip(activeSessionId, activeGarment, clip, activeMode);
}

// ── Submit → poll → play ─────────────────────────────────────────────
function showProcessing(message) {
  stopStream();
  resetResultVideo();
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonIcon.classList.add('spinning');
  tryonTitle.textContent = 'Rendering your try-on';
  tryonCopy.textContent = message;
  tryonNote.textContent = '';
  cameraButton.hidden = true;
}

function playResult(src, isStub) {
  clearCountdown();
  stopStream();
  tryonIcon.classList.remove('spinning');
  stage.hidden = false;
  tryonIcon.hidden = true;
  video.srcObject = null;
  video.classList.add('is-result');
  video.src = src;
  video.muted = true;
  video.loop = true;
  video.play?.().catch(() => { video.controls = true; });
  tryonTitle.textContent = isStub ? 'Your clip (preview)' : 'Your try-on';
  tryonCopy.textContent = isStub
    ? 'Decart isn’t connected yet, so this is just your recording. Add a DECART_API_KEY and it renders the garment onto you.'
    : 'Here’s your garment rendered onto your clip — your one free try. Want it live on your store?';
  tryonNote.textContent = '';
  cameraButton.hidden = false;
  cameraButton.disabled = false;
  cameraButton.textContent = 'Done';
  cameraButton.dataset.role = 'close';
}

function failResult(message) {
  clearCountdown();
  stopStream();
  resetResultVideo();
  tryonIcon.classList.remove('spinning');
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = 'Try-on didn’t complete';
  tryonCopy.textContent = message;
  tryonNote.textContent = '';
  cameraButton.hidden = false;
  cameraButton.disabled = false;
  cameraButton.textContent = 'Close';
  cameraButton.dataset.role = 'close';
}

async function processClip(sessionId, garmentSrc, clip, mode) {
  // Stub mode (no Decart key): just play the recording back.
  if (mode === 'stub') { playResult(URL.createObjectURL(clip), true); endTrial(sessionId); return; }

  showProcessing('Uploading your clip…');
  let submit;
  try {
    const res = await fetch(
      `/api/tryon/submit?sessionId=${encodeURIComponent(sessionId)}&garment=${encodeURIComponent(garmentSrc || '')}`,
      { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': clip.type || 'video/webm' }, body: clip },
    );
    submit = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(submit.error || 'submit_failed');
  } catch {
    failResult('We couldn’t start the try-on. Please try again on your store.');
    endTrial(sessionId);
    return;
  }

  // Server may still report stub (e.g. key removed) — play the clip back.
  if (submit.mode === 'stub') { playResult(URL.createObjectURL(clip), true); endTrial(sessionId); return; }

  const jobId = submit.jobId;
  showProcessing('Rendering your try-on… this takes a moment.');
  const startedAt = Date.now();

  const poll = async () => {
    if (jobAborted) { endTrial(sessionId); return; }
    if (Date.now() - startedAt > 180000) {
      failResult('The try-on is taking longer than expected. Please try again later.');
      endTrial(sessionId);
      return;
    }
    let status;
    try {
      const res = await fetch(`/api/tryon/status?id=${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
      status = (await res.json().catch(() => ({}))).status;
    } catch {
      window.setTimeout(poll, 3000);
      return;
    }
    if (status === 'completed') { playResult(`/api/tryon/result?id=${encodeURIComponent(jobId)}`, false); endTrial(sessionId); return; }
    if (status === 'failed') { failResult('The try-on couldn’t be generated for this clip. Try a simpler pose or garment.'); endTrial(sessionId); return; }
    window.setTimeout(poll, 3000);
  };
  poll();
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

// The action button: start the trial, record the clip, or close/finish.
cameraButton.addEventListener('click', () => {
  const role = cameraButton.dataset.role;
  if (role === 'close') { tryonSheet.close(); return; }
  if (role === 'record') { startRecording(); return; }
  beginTrial();
});

tryonSheet.addEventListener('close', () => { jobAborted = true; endTrial(null); clearCountdown(); resetResultVideo(); });

$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
});

// Prime session state on load (updates the signup sheet + used/ready state).
refreshSession();

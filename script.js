const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const tryonSheet = $('#tryon-sheet');
const contactSheet = $('#contact-sheet');
const signupSheet = $('#signup-sheet');
const signupForm = $('#signup-form');
const signupError = $('#signup-error');

const stage = $('#tryon-stage');
const video = $('#tryon-video');
const garmentShot = $('#tryon-garment');
const cameraButton = $('#camera-demo');
const tryonIcon = $('#tryon-icon');
const tryonTitle = $('#tryon-title');
const tryonCopy = $('#tryon-copy');
const tryonNote = $('#tryon-note');

const idle = {
  title: 'Try it on',
  copy: 'This is exactly what your shopper sees: camera on, your garment on them, moving in real time.',
  note: 'Your camera runs on your device only — nothing is uploaded, recorded, or sent anywhere.',
  action: 'Turn on camera'
};

let stream = null;

const showIdle = () => {
  stage.hidden = true;
  tryonIcon.hidden = false;
  tryonTitle.textContent = idle.title;
  tryonCopy.textContent = idle.copy;
  tryonNote.textContent = idle.note;
  cameraButton.textContent = idle.action;
  cameraButton.disabled = false;
};

const stopCamera = () => {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  showIdle();
};

const failWith = (message) => {
  stopCamera();
  tryonTitle.textContent = 'Camera didn’t start';
  tryonCopy.textContent = message;
  cameraButton.textContent = 'Try again';
};

const startCamera = async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    failWith('Browsers only allow camera access over HTTPS or on localhost. Open this page on a secure address and try again.');
    return;
  }

  cameraButton.disabled = true;
  cameraButton.textContent = 'Starting…';

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream;
    await video.play();

    stage.hidden = false;
    tryonIcon.hidden = true;
    tryonTitle.textContent = 'Camera is live';
    tryonCopy.textContent = 'Move around. In the full build the garment renders onto this feed in real time.';
    tryonNote.textContent = 'Running locally in your browser. Closing this window switches the camera off.';
    cameraButton.textContent = 'Stop camera';
    cameraButton.disabled = false;
  } catch (error) {
    if (error.name === 'NotAllowedError') failWith('Camera permission was blocked. Allow it from the icon in your browser’s address bar, then try again.');
    else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') failWith('No camera was found on this device.');
    else if (error.name === 'NotReadableError') failWith('Another app is already using the camera. Close it and try again.');
    else failWith('Something stopped the camera from starting. Try again, or use a different browser.');
  }
};

const openTryon = (garmentSrc) => {
  const fallback = $('.garment img');
  const src = garmentSrc || fallback?.src;
  if (src) {
    garmentShot.src = src;
    garmentShot.hidden = false;
  } else {
    garmentShot.hidden = true;
  }
  showIdle();
  tryonSheet.showModal();
};

// --- signup gate -----------------------------------------------------
// No backend yet, so the account lives in this browser only.
const SIGNUP_KEY = 'openwear.account';

const readAccount = () => {
  try {
    return JSON.parse(localStorage.getItem(SIGNUP_KEY) || 'null');
  } catch {
    return null;
  }
};

const saveAccount = (account) => {
  try {
    localStorage.setItem(SIGNUP_KEY, JSON.stringify(account));
  } catch {
    // private mode or blocked storage: the signup still works for this visit
  }
};

let account = readAccount();
let pendingGarment = null;

const showSignupError = (message) => {
  signupError.textContent = message;
  signupError.hidden = false;
};

const requestTryon = (garmentSrc) => {
  if (account) {
    openTryon(garmentSrc);
    return;
  }
  pendingGarment = garmentSrc;
  signupError.hidden = true;
  signupForm.reset();
  signupSheet.showModal();
};

signupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = signupForm.elements.name.value.trim();
  const email = signupForm.elements.email.value.trim();
  if (!name) return showSignupError('Please enter your name.');
  if (!/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(email)) return showSignupError('Please enter a valid email address.');

  account = { name, email, at: new Date().toISOString() };
  saveAccount(account);
  signupSheet.close();
  openTryon(pendingGarment);
  pendingGarment = null;
});

signupSheet.addEventListener('close', () => {
  pendingGarment = null;
});

$$('.open-tryon').forEach((button) => button.addEventListener('click', () => requestTryon(button.querySelector('img')?.src)));
$$('.open-contact').forEach((button) => button.addEventListener('click', () => contactSheet.showModal()));

cameraButton.addEventListener('click', () => (stream ? stopCamera() : startCamera()));
tryonSheet.addEventListener('close', stopCamera);

$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
});

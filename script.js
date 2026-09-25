const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const previewSheet = $('#preview-sheet');
const installSheet = $('#install-sheet');
const tryonSheet = $('#tryon-sheet');

$$('.open-preview').forEach((button) => button.addEventListener('click', () => previewSheet.showModal()));
$$('.open-install').forEach((button) => button.addEventListener('click', () => installSheet.showModal()));
$$('.open-tryon').forEach((button) => button.addEventListener('click', () => tryonSheet.showModal()));

$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
});

$('#copy-code').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const code = '<script src="https://anywear.decart.ai/widget/latest/anywear.js?domain=yourstore.com" async><\\/script>';
  try { await navigator.clipboard.writeText(code); } catch { /* Clipboard may be unavailable on file:// */ }
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1800);
});

$('#camera-demo').addEventListener('click', (event) => {
  event.currentTarget.textContent = 'Camera demo unavailable locally';
  event.currentTarget.disabled = true;
});

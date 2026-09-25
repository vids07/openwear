const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const tryonSheet = $('#tryon-sheet');
const contactSheet = $('#contact-sheet');

$$('.open-tryon').forEach((button) => button.addEventListener('click', () => tryonSheet.showModal()));
$$('.open-contact').forEach((button) => button.addEventListener('click', () => contactSheet.showModal()));

$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
});

$('#camera-demo').addEventListener('click', (event) => {
  event.currentTarget.textContent = 'Camera flow runs here in the live build';
  event.currentTarget.disabled = true;
});

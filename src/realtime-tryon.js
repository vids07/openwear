// Bundled with esbuild into public/vendor/realtime-tryon.js (global: LookOnRealtime).
// Wraps @decartai/sdk so the plain page script can drive a WebRTC try-on
// without importing the SDK directly. Build: `npm run build`.
import { createDecartClient, models } from '@decartai/sdk';

let active = null;

/**
 * Open a realtime try-on. `token` is the short-lived client token minted by our
 * server (the permanent key never reaches the browser). `stream` is the camera
 * MediaStream; `image` is the garment (Blob/File/URL) to render onto the person.
 */
async function connect({ token, stream, model, image, prompt, onRemoteStream, onConnectionChange, onError }) {
  const client = createDecartClient({ apiKey: token });
  const initialState = {};
  if (prompt) initialState.prompt = { text: prompt, enhance: false };
  if (image) initialState.image = image;

  active = await client.realtime.connect(stream, {
    model: models.realtime(model || 'lucy-vton-3.5'),
    onRemoteStream,
    mirror: 'auto',
    resolution: '720p',
    speed: 'fast', // the vton realtime model only supports "fast"
    ...(prompt || image ? { initialState } : {}),
  });

  if (onConnectionChange) active.on('connectionChange', onConnectionChange);
  if (onError) active.on('error', onError);
  return active;
}

/** Swap the garment mid-session. */
async function setGarment({ image, prompt, enhance = false }) {
  if (active) await active.set({ image, prompt, enhance });
}

/** End the session and release the WebRTC connection. */
function stop() {
  try { active?.disconnect?.(); } catch { /* already gone */ }
  active = null;
}

export { connect, setGarment, stop };

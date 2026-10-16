/** Whether this page runs the camera guessing game: `?mode=play`. */
export function isPlayMode(location = globalThis.location) {
  return new URLSearchParams(location?.search || '').get('mode') === 'play';
}

/** The hosted deployment that runs the game's server routes. */
export const PLAY_HOME_URL =
  'https://gods-eye-view-i9hi.onrender.com/app?mode=play';

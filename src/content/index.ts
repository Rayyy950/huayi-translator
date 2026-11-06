import { ContentController } from './controller';

declare global {
  interface Window {
    __huayiInstalled?: boolean;
  }
}

// Dynamic registration plus executeScript into already-open tabs can both run
// in the same isolated world. Install exactly once per document.
if (!window.__huayiInstalled) {
  window.__huayiInstalled = true;
  const controller = new ContentController();
  controller.start();
}

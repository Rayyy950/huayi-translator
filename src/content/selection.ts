export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type CaptureResult =
  | { ok: true; text: string; rawText: string; rect: AnchorRect }
  | { ok: false; reason: 'empty' | 'editable' | 'inside-panel' | 'no-range' };

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

function elementFromNode(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

export function isInsideEditable(node: Node | null): boolean {
  const element = elementFromNode(node);
  if (!element) return false;
  return element.closest(EDITABLE_SELECTOR) !== null;
}

export function isInsidePanel(node: Node | null, host: Element | null): boolean {
  if (!host || !node) return false;
  const element = elementFromNode(node);
  if (!element) return false;
  // Shadow DOM nodes are not light-DOM descendants of the host, so
  // host.contains() is false for nodes inside the shadow root.
  if (host.contains(element)) return true;
  const shadow = (host as HTMLElement).shadowRoot;
  if (shadow && shadow.contains(element)) return true;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && shadow?.host === root.host && shadow.contains(element);
}

function toAnchorRect(rect: DOMRect): AnchorRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function captureSelection(doc: Document, host: Element | null): CaptureResult {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return { ok: false, reason: 'empty' };
  }
  const range = selection.getRangeAt(0);
  const rawText = selection.toString();
  if (!rawText.trim()) return { ok: false, reason: 'empty' };

  if (
    isInsidePanel(selection.anchorNode, host) ||
    isInsidePanel(selection.focusNode, host) ||
    isInsidePanel(range.commonAncestorContainer, host)
  ) {
    return { ok: false, reason: 'inside-panel' };
  }
  if (
    isInsideEditable(selection.anchorNode) ||
    isInsideEditable(selection.focusNode) ||
    isInsideEditable(range.commonAncestorContainer)
  ) {
    return { ok: false, reason: 'editable' };
  }

  let rect = range.getBoundingClientRect();
  if ((rect.width === 0 || rect.height === 0) && range.getClientRects().length > 0) {
    rect = range.getClientRects()[0] as DOMRect;
  }
  if (rect.width === 0 && rect.height === 0) return { ok: false, reason: 'no-range' };

  return { ok: true, text: rawText.trim(), rawText, rect: toAnchorRect(rect) };
}

export function eventInsidePanel(event: Event, host: Element | null): boolean {
  if (!host) return false;
  const path = event.composedPath();
  return path.includes(host);
}

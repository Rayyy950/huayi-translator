import { createRoot, type Root } from 'react-dom/client';
import { Panel, type PanelActions, type PanelViewState } from './Panel';
import panelCss from './panel.css?inline';
import type { AnchorRect } from '../selection';

const MARGIN = 12;
const GAP = 8;
const MAX_WIDTH = 360;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Owns the shadow root and the fixed-position container. React renders only
 * inside the shadow root, so page CSS cannot leak in or out.
 */
export class PanelMount {
  readonly host: HTMLDivElement;
  private readonly container: HTMLDivElement;
  private readonly root: Root;
  private readonly actions: PanelActions;
  private anchor: AnchorRect | null = null;
  private pinnedPosition: { left: number; top: number } | null = null;
  private visible = false;
  private raf = 0;
  private readonly observer: ResizeObserver;

  constructor(actions: PanelActions) {
    this.actions = actions;
    this.host = document.createElement('div');
    this.host.dataset.huayiHost = 'true';
    this.host.style.cssText =
      'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = panelCss;
    this.container = document.createElement('div');
    this.container.className = 'huayi-container';
    this.container.style.cssText =
      'position: fixed; display: none; width: 360px; left: 0; top: 0; color-scheme: light dark;';
    shadow.append(style, this.container);
    document.documentElement.appendChild(this.host);
    this.root = createRoot(this.container);
    this.observer = new ResizeObserver(() => this.schedulePosition());
    this.observer.observe(this.container);
  }

  render(state: PanelViewState): void {
    this.root.render(<Panel state={state} actions={this.actions} />);
    this.schedulePosition();
  }

  setAnchor(anchor: AnchorRect): void {
    this.anchor = anchor;
    if (!this.pinnedPosition) this.schedulePosition();
  }

  show(): void {
    this.visible = true;
    this.container.style.display = 'block';
    this.schedulePosition();
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
  }

  isPinned(): boolean {
    return this.pinnedPosition !== null;
  }

  pinToCurrent(): void {
    const rect = this.container.getBoundingClientRect();
    this.pinnedPosition = { left: rect.left, top: rect.top };
  }

  unpin(): void {
    this.pinnedPosition = null;
    this.schedulePosition();
  }

  reposition(): void {
    this.schedulePosition();
  }

  destroy(): void {
    this.observer.disconnect();
    cancelAnimationFrame(this.raf);
    this.root.unmount();
    this.host.remove();
  }

  private schedulePosition(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.position());
  }

  private position(): void {
    if (!this.visible || !this.anchor) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(MAX_WIDTH, Math.max(240, vw - MARGIN * 2));
    this.container.style.width = `${width}px`;
    const height = this.container.getBoundingClientRect().height || 140;

    let left: number;
    let top: number;
    if (this.pinnedPosition) {
      left = this.pinnedPosition.left;
      top = this.pinnedPosition.top;
    } else {
      left = this.anchor.left;
      top = this.anchor.bottom + GAP;
      if (top + height > vh - MARGIN && this.anchor.top - height - GAP >= MARGIN) {
        top = this.anchor.top - height - GAP;
      }
    }
    left = clamp(left, MARGIN, vw - width - MARGIN);
    top = clamp(top, MARGIN, vh - height - MARGIN);
    this.container.style.left = `${Math.round(left)}px`;
    this.container.style.top = `${Math.round(top)}px`;
  }
}

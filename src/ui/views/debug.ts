/**
 * Debug overlay (top-left, monospace). Lines typically change every frame (fps, position),
 * so it keeps a pool of line elements and rewrites only the text nodes that differ.
 */
import { h, setHidden, TextSlot } from '../dom';

export class DebugOverlay {
  readonly el: HTMLElement;
  private readonly lines: TextSlot[] = [];
  private readonly lineEls: HTMLElement[] = [];
  private shownCount = 0;
  private visible: boolean | null = null;

  constructor(private readonly doc: Document) {
    this.el = h(doc, 'div', 'bl-debug', { hidden: true, 'aria-hidden': 'true' });
  }

  update(lines: readonly string[] | null): void {
    const show = lines !== null && lines.length > 0;
    if (show !== this.visible) {
      this.visible = show;
      setHidden(this.el, !show);
    }
    if (!lines) return;
    while (this.lines.length < lines.length) {
      const slot = new TextSlot(this.doc);
      const el = h(this.doc, 'div', 'bl-debug-line');
      el.appendChild(slot.node);
      this.lines.push(slot);
      this.lineEls.push(el);
    }
    for (let i = 0; i < lines.length; i++) this.lines[i]!.set(lines[i]!);
    if (lines.length !== this.shownCount) {
      // Attach / detach pooled line elements; the pool itself is kept for reuse.
      for (let i = this.shownCount; i < lines.length; i++) this.el.appendChild(this.lineEls[i]!);
      for (let i = lines.length; i < this.shownCount; i++) this.lineEls[i]!.remove();
      this.shownCount = lines.length;
    }
  }
}

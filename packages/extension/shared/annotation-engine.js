// Vector annotation engine shared by the extension editors and the web app.
//
// This file is the canonical copy. The web package imports it through the
// `@shared` Vite alias (packages/web/vite.config.ts) — do not duplicate it.
//
// Annotations are objects in *image coordinates*, rendered fresh every frame
// over the base image. Nothing is rasterized until export, so every shape can
// be selected, moved, reshaped, restyled, or deleted at any time — including
// after a page reload when the host persists getAnnotations().
//
// Annotation shape:
//   { id, type: 'rect'|'arrow'|'line'|'freehand'|'text',
//     points: [{x,y}, ...], color, thickness, text?, fontSize? }
//
//   rect:     points[0], points[1] are opposite corners
//   arrow:    points[0] tail, points[1] head
//   line:     points[0], points[1]
//   freehand: full point trail
//   text:     points[0] is the top-left anchor
//
// Crop is non-destructive: the engine keeps the full base image and a crop
// window; annotations stay in original image coordinates, so undoing a crop
// loses nothing.

const HANDLE_SIZE = 8;
const MIN_SHAPE_SIZE = 4;
const MAX_HISTORY = 100;

export const ANNOTATIONS_VERSION = 1;

function makeId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function shapeBounds(annotation, ctx) {
  if (annotation.type === 'text') {
    const fontSize = annotation.fontSize || 20;
    let width = (annotation.text || '').length * fontSize * 0.6;
    if (ctx) {
      ctx.save();
      ctx.font = `${fontSize}px Arial`;
      width = ctx.measureText(annotation.text || '').width;
      ctx.restore();
    }
    const anchor = annotation.points[0];
    return { x: anchor.x, y: anchor.y, width, height: fontSize * 1.25 };
  }

  const xs = annotation.points.map((p) => p.x);
  const ys = annotation.points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function drawAnnotationShape(ctx, annotation) {
  const { type, points } = annotation;
  ctx.strokeStyle = annotation.color;
  ctx.fillStyle = annotation.color;
  ctx.lineWidth = annotation.thickness || 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (type === 'rect') {
    const [p0, p1] = points;
    ctx.strokeRect(
      Math.min(p0.x, p1.x),
      Math.min(p0.y, p1.y),
      Math.abs(p1.x - p0.x),
      Math.abs(p1.y - p0.y)
    );
    return;
  }

  if (type === 'line' || type === 'arrow') {
    const [p0, p1] = points;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();

    if (type === 'arrow') {
      // Head scales with stroke thickness instead of a hardcoded 20px
      const headLength = Math.max(14, (annotation.thickness || 4) * 3.5);
      const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(
        p1.x - headLength * Math.cos(angle - Math.PI / 6),
        p1.y - headLength * Math.sin(angle - Math.PI / 6)
      );
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(
        p1.x - headLength * Math.cos(angle + Math.PI / 6),
        p1.y - headLength * Math.sin(angle + Math.PI / 6)
      );
      ctx.stroke();
    }
    return;
  }

  if (type === 'freehand') {
    if (points.length < 2) {
      const p = points[0];
      if (p) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, (annotation.thickness || 4) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    return;
  }

  if (type === 'text') {
    const fontSize = annotation.fontSize || 20;
    ctx.font = `${fontSize}px Arial`;
    ctx.textBaseline = 'top';
    ctx.fillText(annotation.text || '', points[0].x, points[0].y);
  }
}

function hitTest(annotation, point, tolerance, ctx) {
  const { type, points } = annotation;
  const tol = Math.max(tolerance, (annotation.thickness || 4) / 2 + tolerance / 2);

  if (type === 'text') {
    const bounds = shapeBounds(annotation, ctx);
    return (
      point.x >= bounds.x - tol &&
      point.x <= bounds.x + bounds.width + tol &&
      point.y >= bounds.y - tol &&
      point.y <= bounds.y + bounds.height + tol
    );
  }

  if (type === 'rect') {
    const [p0, p1] = points;
    const left = Math.min(p0.x, p1.x);
    const top = Math.min(p0.y, p1.y);
    const right = Math.max(p0.x, p1.x);
    const bottom = Math.max(p0.y, p1.y);
    // Filled hit: clicking anywhere inside the rectangle (or near its border)
    // grabs it, so it can be selected and moved like the other shapes. The
    // topmost annotation still wins, so overlapping shapes stay reachable.
    return (
      point.x >= left - tol &&
      point.x <= right + tol &&
      point.y >= top - tol &&
      point.y <= bottom + tol
    );
  }

  if (type === 'line' || type === 'arrow') {
    return distToSegment(point, points[0], points[1]) <= tol;
  }

  if (type === 'freehand') {
    for (let i = 1; i < points.length; i += 1) {
      if (distToSegment(point, points[i - 1], points[i]) <= tol) return true;
    }
    return points.length === 1 && Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tol;
  }

  return false;
}

function getHandles(annotation) {
  if (annotation.type === 'rect') {
    const [p0, p1] = annotation.points;
    const left = Math.min(p0.x, p1.x);
    const top = Math.min(p0.y, p1.y);
    const right = Math.max(p0.x, p1.x);
    const bottom = Math.max(p0.y, p1.y);
    return [
      { key: 'tl', x: left, y: top },
      { key: 'tr', x: right, y: top },
      { key: 'bl', x: left, y: bottom },
      { key: 'br', x: right, y: bottom },
    ];
  }
  if (annotation.type === 'line' || annotation.type === 'arrow') {
    return [
      { key: 'p0', x: annotation.points[0].x, y: annotation.points[0].y },
      { key: 'p1', x: annotation.points[1].x, y: annotation.points[1].y },
    ];
  }
  return [];
}

export function sanitizeAnnotations(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        ['rect', 'arrow', 'line', 'freehand', 'text'].includes(item.type) &&
        Array.isArray(item.points) &&
        item.points.length > 0 &&
        item.points.every(
          (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
        )
    )
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : makeId(),
      type: item.type,
      points: item.points.map((p) => ({ x: p.x, y: p.y })),
      color: typeof item.color === 'string' ? item.color : '#ef4444',
      thickness: Number.isFinite(item.thickness) ? item.thickness : 4,
      ...(item.type === 'text'
        ? {
            text: typeof item.text === 'string' ? item.text : '',
            fontSize: Number.isFinite(item.fontSize) ? item.fontSize : 20,
          }
        : {}),
    }));
}

export function parseAnnotations(json) {
  if (!json) return [];
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (Array.isArray(parsed)) return sanitizeAnnotations(parsed);
    return sanitizeAnnotations(parsed.items);
  } catch {
    return [];
  }
}

export function serializeAnnotations(items) {
  return JSON.stringify({ version: ANNOTATIONS_VERSION, items: sanitizeAnnotations(items) });
}

async function loadImageElement(source) {
  const url =
    typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Failed to load image'));
      image.src = url;
    });
    return image;
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

/**
 * Renders an image plus annotations to a PNG blob without an engine instance.
 * Used by viewers for downloads/clipboard of the flattened result.
 */
export async function renderAnnotatedBlob(imageSource, annotations, mimeType = 'image/png') {
  const image = await loadImageElement(imageSource);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  for (const annotation of parseAnnotations(annotations)) {
    drawAnnotationShape(ctx, annotation);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to export annotated image'));
    }, mimeType);
  });
}

/**
 * Draws image + annotations into an existing canvas (used by read-only viewers).
 */
export function drawAnnotatedImage(canvas, image, annotations) {
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  for (const annotation of parseAnnotations(annotations)) {
    drawAnnotationShape(ctx, annotation);
  }
}

export class AnnotationEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   enableCrop?: boolean,
   *   onChange?: () => void,
   *   onSelectionChange?: (annotation: object | null) => void,
   *   onHistoryChange?: (state: {canUndo: boolean, canRedo: boolean}) => void,
   *   onToolChange?: (tool: string) => void,
   *   onTextEditRequest?: (request: {
   *     imagePoint: {x: number, y: number},
   *     clientX: number, clientY: number,
   *     annotation: object | null,
   *   }) => void,
   * }} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = options;

    this.image = null;
    this.crop = null; // {x, y, width, height} in image coords
    this.annotations = [];
    this.history = [];
    this.historyIndex = -1;

    this.tool = 'select';
    this.color = '#000000';
    this.thickness = 4;
    this.fontSize = 84;

    this.selectedId = null;
    this.drag = null;
    this.cropDraft = null;

    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onDblClick = this._handleDblClick.bind(this);

    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('dblclick', this._onDblClick);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerUp);
    this.canvas.removeEventListener('dblclick', this._onDblClick);
  }

  async loadImage(source, { annotations = [], resetHistory = true } = {}) {
    this.image = await loadImageElement(source);
    this.crop = {
      x: 0,
      y: 0,
      width: this.image.naturalWidth,
      height: this.image.naturalHeight,
    };
    this.annotations = sanitizeAnnotations(annotations);
    this.selectedId = null;
    this.drag = null;
    this.cropDraft = null;
    if (resetHistory) {
      this.history = [];
      this.historyIndex = -1;
      this._snapshot();
    }
    this._resizeCanvas();
    this.render();
    this._emitSelection();
  }

  /**
   * @param {{relativeToCrop?: boolean}} [options] — with relativeToCrop the
   * points are translated into the cropped image's coordinate space, matching
   * what exportBlob()/exportBaseBlob() produce.
   */
  getAnnotations({ relativeToCrop = false } = {}) {
    const items = clone(this.annotations);
    if (relativeToCrop && this.crop && (this.crop.x !== 0 || this.crop.y !== 0)) {
      for (const item of items) {
        item.points = item.points.map((p) => ({
          x: p.x - this.crop.x,
          y: p.y - this.crop.y,
        }));
      }
    }
    return items;
  }

  setAnnotations(items) {
    this.annotations = sanitizeAnnotations(items);
    this.selectedId = null;
    this._snapshot();
    this.render();
    this._emitSelection();
  }

  serialize({ relativeToCrop = false } = {}) {
    return serializeAnnotations(this.getAnnotations({ relativeToCrop }));
  }

  get hasCrop() {
    if (!this.image || !this.crop) return false;
    return (
      this.crop.x !== 0 ||
      this.crop.y !== 0 ||
      this.crop.width !== this.image.naturalWidth ||
      this.crop.height !== this.image.naturalHeight
    );
  }

  setTool(tool) {
    this.tool = tool;
    this.cropDraft = null;
    if (tool !== 'select') {
      this.selectedId = null;
      this._emitSelection();
    }
    this.canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this.options.onToolChange?.(tool);
    this.render();
  }

  setColor(color) {
    this.color = color;
    this._applyStyleToSelection({ color });
  }

  setThickness(thickness) {
    this.thickness = thickness;
    this._applyStyleToSelection({ thickness });
  }

  setFontSize(fontSize) {
    this.fontSize = fontSize;
    const selected = this._selected();
    if (selected && selected.type === 'text') {
      this._applyStyleToSelection({ fontSize });
    }
  }

  _applyStyleToSelection(patch) {
    const selected = this._selected();
    if (!selected) return;
    Object.assign(selected, patch);
    this._snapshot();
    this.render();
  }

  _selected() {
    return this.annotations.find((a) => a.id === this.selectedId) || null;
  }

  get selectedAnnotation() {
    const selected = this._selected();
    return selected ? clone(selected) : null;
  }

  selectAnnotation(id) {
    this.selectedId = id;
    this.render();
    this._emitSelection();
  }

  deleteSelected() {
    if (!this.selectedId) return false;
    const before = this.annotations.length;
    this.annotations = this.annotations.filter((a) => a.id !== this.selectedId);
    this.selectedId = null;
    if (this.annotations.length !== before) {
      this._snapshot();
      this.render();
      this._emitSelection();
      return true;
    }
    return false;
  }

  canUndo() {
    return this.historyIndex > 0;
  }

  canRedo() {
    return this.historyIndex < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo()) return;
    this.historyIndex -= 1;
    this._restore();
  }

  redo() {
    if (!this.canRedo()) return;
    this.historyIndex += 1;
    this._restore();
  }

  /** Adds a text annotation at image coordinates. Returns the annotation. */
  insertText(imagePoint, text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    const annotation = {
      id: makeId(),
      type: 'text',
      points: [{ x: imagePoint.x, y: imagePoint.y }],
      color: this.color,
      thickness: this.thickness,
      text: trimmed,
      fontSize: this.fontSize,
    };
    this.annotations.push(annotation);
    this.selectedId = annotation.id;
    this._snapshot();
    this.render();
    this._emitSelection();
    return annotation;
  }

  updateText(id, text) {
    const annotation = this.annotations.find((a) => a.id === id);
    if (!annotation || annotation.type !== 'text') return;
    const trimmed = (text || '').trim();
    if (!trimmed) {
      this.selectedId = id;
      this.deleteSelected();
      return;
    }
    annotation.text = trimmed;
    this._snapshot();
    this.render();
  }

  /** Converts a client (mouse) position to image coordinates. */
  clientToImage(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX + (this.crop?.x || 0),
      y: (clientY - rect.top) * scaleY + (this.crop?.y || 0),
    };
  }

  _tolerance() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? this.canvas.width / rect.width : 1;
    return 8 * Math.max(scale, 1);
  }

  /**
   * Ratio of on-screen size to intrinsic (image) size — the canvas is usually
   * displayed smaller than the image via CSS (max-width). Multiply a font size
   * in image pixels by this to get the size it actually renders on screen, so
   * the text-input overlay can be shown at the same size as the drawn text.
   */
  get displayScale() {
    const rect = this.canvas.getBoundingClientRect();
    return rect.width > 0 && this.canvas.width > 0
      ? rect.width / this.canvas.width
      : 1;
  }

  /** Export the cropped image with annotations burned in. */
  exportBlob(mimeType = 'image/png') {
    return this._export(mimeType, true);
  }

  /** Export the cropped image only (no annotations). */
  exportBaseBlob(mimeType = 'image/png') {
    return this._export(mimeType, false);
  }

  _export(mimeType, withAnnotations) {
    const output = document.createElement('canvas');
    output.width = this.crop.width;
    output.height = this.crop.height;
    const ctx = output.getContext('2d');
    this._renderScene(ctx, { includeChrome: false, includeAnnotations: withAnnotations });
    return new Promise((resolve, reject) => {
      output.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to export image'));
      }, mimeType);
    });
  }

  // ── History ─────────────────────────────────────────────────────────

  _snapshot() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({ crop: clone(this.crop), annotations: clone(this.annotations) });
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    } else {
      this.historyIndex += 1;
    }
    this._emitHistory();
    this.options.onChange?.();
  }

  _restore() {
    const state = this.history[this.historyIndex];
    if (!state) return;
    this.crop = clone(state.crop);
    this.annotations = clone(state.annotations);
    if (this.selectedId && !this.annotations.some((a) => a.id === this.selectedId)) {
      this.selectedId = null;
      this._emitSelection();
    }
    this._resizeCanvas();
    this.render();
    this._emitHistory();
    this.options.onChange?.();
  }

  _emitHistory() {
    this.options.onHistoryChange?.({ canUndo: this.canUndo(), canRedo: this.canRedo() });
  }

  _emitSelection() {
    this.options.onSelectionChange?.(this.selectedAnnotation);
  }

  _resizeCanvas() {
    if (!this.crop) return;
    this.canvas.width = Math.max(1, Math.round(this.crop.width));
    this.canvas.height = Math.max(1, Math.round(this.crop.height));
  }

  // ── Pointer interaction ─────────────────────────────────────────────

  _handlePointerDown(event) {
    if (!this.image || event.button !== 0) return;
    this.canvas.setPointerCapture?.(event.pointerId);
    const point = this.clientToImage(event.clientX, event.clientY);

    if (this.tool === 'text') {
      this.options.onTextEditRequest?.({
        imagePoint: point,
        clientX: event.clientX,
        clientY: event.clientY,
        annotation: null,
      });
      return;
    }

    if (this.tool === 'crop') {
      this.cropDraft = { start: point, end: point };
      this.render();
      return;
    }

    if (this.tool === 'select' || !this.tool) {
      const tolerance = this._tolerance();

      // Handles of the current selection take priority
      const selected = this._selected();
      if (selected) {
        const handle = getHandles(selected).find(
          (h) => Math.hypot(point.x - h.x, point.y - h.y) <= tolerance * 1.5
        );
        if (handle) {
          this.drag = {
            mode: 'handle',
            id: selected.id,
            handle: handle.key,
            originalPoints: clone(selected.points),
          };
          return;
        }
      }

      // Topmost annotation wins
      for (let i = this.annotations.length - 1; i >= 0; i -= 1) {
        const annotation = this.annotations[i];
        if (hitTest(annotation, point, tolerance, this.ctx)) {
          this.selectedId = annotation.id;
          this.drag = {
            mode: 'move',
            id: annotation.id,
            start: point,
            originalPoints: clone(annotation.points),
          };
          this.render();
          this._emitSelection();
          return;
        }
      }

      if (this.selectedId) {
        this.selectedId = null;
        this.render();
        this._emitSelection();
      }
      return;
    }

    // Shape creation tools
    const annotation = {
      id: makeId(),
      type: this.tool === 'rectangle' ? 'rect' : this.tool,
      points:
        this.tool === 'freehand'
          ? [{ x: point.x, y: point.y }]
          : [{ x: point.x, y: point.y }, { x: point.x, y: point.y }],
      color: this.color,
      thickness: this.thickness,
    };
    this.annotations.push(annotation);
    this.drag = { mode: 'create', id: annotation.id, start: point };
    this.render();
  }

  _handlePointerMove(event) {
    if (!this.image) return;
    const point = this.clientToImage(event.clientX, event.clientY);

    if (this.cropDraft) {
      this.cropDraft.end = point;
      this.render();
      return;
    }

    if (!this.drag) {
      if (this.tool === 'select') this._updateHoverCursor(point);
      return;
    }

    const annotation = this.annotations.find((a) => a.id === this.drag.id);
    if (!annotation) return;

    if (this.drag.mode === 'create') {
      if (annotation.type === 'freehand') {
        const last = annotation.points[annotation.points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) > 2) {
          annotation.points.push({ x: point.x, y: point.y });
        }
      } else {
        annotation.points[1] = { x: point.x, y: point.y };
      }
      this.render();
      return;
    }

    if (this.drag.mode === 'move') {
      const dx = point.x - this.drag.start.x;
      const dy = point.y - this.drag.start.y;
      annotation.points = this.drag.originalPoints.map((p) => ({
        x: p.x + dx,
        y: p.y + dy,
      }));
      this.render();
      return;
    }

    if (this.drag.mode === 'handle') {
      const original = this.drag.originalPoints;
      if (annotation.type === 'line' || annotation.type === 'arrow') {
        const index = this.drag.handle === 'p0' ? 0 : 1;
        annotation.points = clone(original);
        annotation.points[index] = { x: point.x, y: point.y };
      } else if (annotation.type === 'rect') {
        const left = Math.min(original[0].x, original[1].x);
        const top = Math.min(original[0].y, original[1].y);
        const right = Math.max(original[0].x, original[1].x);
        const bottom = Math.max(original[0].y, original[1].y);
        // Dragged corner follows the pointer, opposite corner stays fixed
        const opposite = {
          tl: { x: right, y: bottom },
          tr: { x: left, y: bottom },
          bl: { x: right, y: top },
          br: { x: left, y: top },
        }[this.drag.handle];
        annotation.points = [opposite, { x: point.x, y: point.y }];
      }
      this.render();
    }
  }

  _handlePointerUp(event) {
    if (this.cropDraft) {
      const { start, end } = this.cropDraft;
      this.cropDraft = null;
      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);
      if (width >= 10 && height >= 10) {
        this.crop = { x: left, y: top, width, height };
        this._resizeCanvas();
        this._snapshot();
        this.setTool('select');
      }
      this.render();
      return;
    }

    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;

    const annotation = this.annotations.find((a) => a.id === drag.id);
    if (!annotation) return;

    if (drag.mode === 'create') {
      const bounds = shapeBounds(annotation, this.ctx);
      const isDegenerate =
        annotation.type !== 'freehand' &&
        bounds.width < MIN_SHAPE_SIZE &&
        bounds.height < MIN_SHAPE_SIZE;

      if (isDegenerate) {
        this.annotations = this.annotations.filter((a) => a.id !== annotation.id);
        this.render();
        return;
      }
      this.selectedId = annotation.id;
      this._snapshot();
      // Return to the select tool so the shape just drawn can be grabbed and
      // moved right away (matches common editors like Excalidraw). setTool
      // keeps the current selection when switching to 'select'.
      this.setTool('select');
      this._emitSelection();
      return;
    }

    // move / handle: only snapshot if something actually changed
    if (JSON.stringify(drag.originalPoints) !== JSON.stringify(annotation.points)) {
      this._snapshot();
    }
    void event;
  }

  _handleDblClick(event) {
    if (!this.image) return;
    const point = this.clientToImage(event.clientX, event.clientY);
    const tolerance = this._tolerance();
    for (let i = this.annotations.length - 1; i >= 0; i -= 1) {
      const annotation = this.annotations[i];
      if (annotation.type === 'text' && hitTest(annotation, point, tolerance, this.ctx)) {
        this.selectedId = annotation.id;
        this.render();
        this._emitSelection();
        this.options.onTextEditRequest?.({
          imagePoint: { x: annotation.points[0].x, y: annotation.points[0].y },
          clientX: event.clientX,
          clientY: event.clientY,
          annotation: clone(annotation),
        });
        return;
      }
    }
  }

  _updateHoverCursor(point) {
    const tolerance = this._tolerance();
    const selected = this._selected();
    if (selected) {
      const onHandle = getHandles(selected).some(
        (h) => Math.hypot(point.x - h.x, point.y - h.y) <= tolerance * 1.5
      );
      if (onHandle) {
        this.canvas.style.cursor = 'grab';
        return;
      }
    }
    const overShape = this.annotations.some((a) =>
      hitTest(a, point, tolerance, this.ctx)
    );
    this.canvas.style.cursor = overShape ? 'move' : 'default';
  }

  // ── Rendering ───────────────────────────────────────────────────────

  render() {
    if (!this.image || !this.crop) return;
    this._renderScene(this.ctx, { includeChrome: true, includeAnnotations: true });
  }

  _renderScene(ctx, { includeChrome, includeAnnotations }) {
    const { x, y, width, height } = this.crop;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.image, x, y, width, height, 0, 0, width, height);

    ctx.save();
    ctx.translate(-x, -y);

    if (includeAnnotations) {
      for (const annotation of this.annotations) {
        drawAnnotationShape(ctx, annotation);
      }
    }

    if (includeChrome) {
      const selected = this._selected();
      if (selected && !this.drag) {
        this._drawSelectionChrome(ctx, selected);
      } else if (selected && this.drag) {
        this._drawSelectionChrome(ctx, selected, { handlesOnly: this.drag.mode !== 'move' });
      }
    }

    ctx.restore();

    if (includeChrome && this.cropDraft) {
      this._drawCropDraft(ctx);
    }
  }

  _drawSelectionChrome(ctx, annotation, { handlesOnly = false } = {}) {
    const scale = this._tolerance() / 8;

    if (!handlesOnly) {
      const bounds = shapeBounds(annotation, ctx);
      ctx.save();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5 * scale;
      ctx.setLineDash([6 * scale, 4 * scale]);
      const pad = (annotation.thickness || 4) / 2 + 4 * scale;
      ctx.strokeRect(
        bounds.x - pad,
        bounds.y - pad,
        bounds.width + pad * 2,
        bounds.height + pad * 2
      );
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 * scale;
    const size = HANDLE_SIZE * scale;
    for (const handle of getHandles(annotation)) {
      ctx.beginPath();
      ctx.rect(handle.x - size / 2, handle.y - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawCropDraft(ctx) {
    const { start, end } = this.cropDraft;
    const offsetX = this.crop.x;
    const offsetY = this.crop.y;
    const left = Math.min(start.x, end.x) - offsetX;
    const top = Math.min(start.y, end.y) - offsetY;
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, this.crop.width, this.crop.height);
    ctx.rect(left, top, width, height);
    ctx.fill('evenodd');

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(left, top, width, height);
    ctx.restore();
  }
}

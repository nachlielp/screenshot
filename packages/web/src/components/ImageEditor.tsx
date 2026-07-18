import { useRef, useEffect, useState, useCallback } from 'react';
import {
  AnnotationEngine,
  parseAnnotations,
  type Annotation,
  type TextEditRequest,
} from '@shared/annotation-engine';
import { Button } from './Button';
import './ImageEditor.css';

export interface ImageEditorSaveResult {
  annotations: Annotation[];
  annotationsJson: string;
  blob: Blob;
  hasCrop: boolean;
  // The cropped image without annotations burned in — present only when the
  // user cropped, so callers can replace the stored base image and keep the
  // annotations as editable vectors on top of it.
  baseBlob: Blob | null;
  // Crop rectangle plus the dimensions of the image it was applied to, so
  // callers can remap anything anchored to the old image (e.g. percent-based
  // highlight positions).
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
    imageWidth: number;
    imageHeight: number;
  } | null;
}

interface ImageEditorProps {
  imageUrl: string;
  initialAnnotations?: Annotation[] | string | null;
  enableCrop?: boolean;
  onSave?: (result: ImageEditorSaveResult) => void;
  onCancel?: () => void;
  showSaveButton?: boolean;
  saveRequestToken?: number;
}

// Nudge a new text annotation's anchor down one screen pixel: canvas text
// (textBaseline 'top') renders a hair higher than the same text in the
// overlay input's line box. Matches the extension editors.
function nudgeTextAnchor(engine: AnnotationEngine, point: { x: number; y: number }) {
  return { x: point.x, y: point.y + 1 / engine.displayScale };
}

const TOOLS: { key: string; title: string }[] = [
  { key: 'select', title: 'Select / Move (V)' },
  { key: 'rect', title: 'Rectangle (R)' },
  { key: 'arrow', title: 'Arrow (A)' },
  { key: 'line', title: 'Line (L)' },
  { key: 'freehand', title: 'Pen (P)' },
  { key: 'text', title: 'Text (T)' },
];

// Line-drawn icons on a 24px grid (pink-posthog style): fill none,
// currentColor stroke, round caps/joins — matches the extension editor.
function ToolIcon({ name }: { name: string }) {
  const p = {
    className: 'icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'select':
      return <svg {...p}><path d="m4 3 7 17 2.5-7L20.5 10.5z" /></svg>;
    case 'crop':
      return <svg {...p}><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M2 6h14a2 2 0 0 1 2 2v14" /></svg>;
    case 'rect':
      return <svg {...p}><rect x="4" y="6" width="16" height="12" rx="1.5" /></svg>;
    case 'arrow':
      return <svg {...p}><path d="M5 19 19 5" /><path d="M9 5h10v10" /></svg>;
    case 'line':
      return <svg {...p}><path d="M5 19 19 5" /></svg>;
    case 'freehand':
      return <svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case 'text':
      return <svg {...p}><path d="M5 7V5h14v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>;
    case 'delete':
      return <svg {...p}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>;
    case 'undo':
      return <svg {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-4" /></svg>;
    case 'redo':
      return <svg {...p}><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h4" /></svg>;
    case 'copy':
      return <svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>;
    case 'check':
      return <svg {...p}><path d="M5 12l5 5 9-11" /></svg>;
    default:
      return null;
  }
}

const COLORS = [
  { value: '#000000', label: 'Black' },
  { value: '#ef4444', label: 'Red' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ffffff', label: 'White' },
];

export function ImageEditor({
  imageUrl,
  initialAnnotations = null,
  enableCrop = false,
  onSave,
  onCancel,
  showSaveButton = true,
  saveRequestToken,
}: ImageEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AnnotationEngine | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const lastSaveRequestTokenRef = useRef<number | undefined>(saveRequestToken);
  const initialAnnotationsRef = useRef(initialAnnotations);

  const [activeTool, setActiveTool] = useState('select');
  const [currentColor, setCurrentColor] = useState('#000000');
  const [currentThickness, setCurrentThickness] = useState(4);
  const [currentFontSize, setCurrentFontSize] = useState(84);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [hasSelection, setHasSelection] = useState(false);
  const [textEdit, setTextEdit] = useState<
    (TextEditRequest & { value: string }) | null
  >(null);
  // Mirror of textEdit read synchronously from engine callbacks / blur. React
  // state updates lag a render, and a click-out fires the engine pointerdown
  // before the input's blur — without a synchronous source of truth the typed
  // text gets cleared before it's committed (it "disappears"), or committed
  // twice. This ref is the authority for committing.
  const textEditRef = useRef<(TextEditRequest & { value: string }) | null>(null);

  // Create the engine and load the image
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new AnnotationEngine(canvas, {
      enableCrop,
      onHistoryChange: setHistoryState,
      // Keep the toolbar in sync when the engine changes tools itself — e.g.
      // it auto-returns to 'select' after a shape is drawn.
      onToolChange: (tool) => setActiveTool(tool),
      onSelectionChange: (annotation) => {
        setHasSelection(Boolean(annotation));
        if (annotation) {
          // Reflect the selection's style in the toolbar without mutating it
          setCurrentColor(annotation.color);
          setCurrentThickness(annotation.thickness);
          if (annotation.fontSize) setCurrentFontSize(annotation.fontSize);
          engine.color = annotation.color;
          engine.thickness = annotation.thickness;
          if (annotation.fontSize) engine.fontSize = annotation.fontSize;
        }
      },
      onTextEditRequest: (request) => {
        // A text box is already open — this request is the click meant to
        // dismiss it (the text tool is still active). Commit what's typed and
        // return to select instead of opening a second box, so the placed text
        // stays put and is grabbable, matching how finishing a shape behaves.
        const pending = textEditRef.current;
        if (pending) {
          if (pending.annotation) engine.updateText(pending.annotation.id, pending.value);
          else engine.insertText(nudgeTextAnchor(engine, pending.imagePoint), pending.value);
          textEditRef.current = null;
          setTextEdit(null);
          engine.setTool('select');
          return;
        }
        const next = { ...request, value: request.annotation?.text ?? '' };
        textEditRef.current = next;
        setTextEdit(next);
        setTimeout(() => textInputRef.current?.focus(), 0);
      },
    });

    engineRef.current = engine;
    engine.color = '#000000';
    engine.thickness = 4;
    engine.fontSize = 84;

    let cancelled = false;
    void engine
      .loadImage(imageUrl, {
        annotations: parseAnnotations(initialAnnotationsRef.current),
      })
      .then(() => {
        if (!cancelled) engine.setTool('select');
      })
      .catch((error) => console.error('Failed to load image into editor:', error));

    return () => {
      cancelled = true;
      engine.destroy();
      engineRef.current = null;
    };
  }, [imageUrl, enableCrop]);

  const selectTool = (tool: string) => {
    setActiveTool(tool);
    engineRef.current?.setTool(tool);
  };

  const handleColorChange = (color: string) => {
    setCurrentColor(color);
    engineRef.current?.setColor(color);
  };

  const handleThicknessChange = (thickness: number) => {
    setCurrentThickness(thickness);
    engineRef.current?.setThickness(thickness);
  };

  const handleFontSizeChange = (fontSize: number) => {
    setCurrentFontSize(fontSize);
    engineRef.current?.setFontSize(fontSize);
  };

  const commitTextEdit = useCallback(() => {
    const engine = engineRef.current;
    const pending = textEditRef.current;
    // The ref guards against a double commit: a click-out already commits via
    // onTextEditRequest, then the input's blur fires this too.
    if (!engine || !pending) return;
    textEditRef.current = null;

    if (pending.annotation) {
      engine.updateText(pending.annotation.id, pending.value);
    } else {
      engine.insertText(nudgeTextAnchor(engine, pending.imagePoint), pending.value);
    }
    setTextEdit(null);
    // Land on select with the new text selected, so it's immediately grabbable.
    engine.setTool('select');
  }, []);

  const cancelTextEdit = useCallback(() => {
    textEditRef.current = null;
    setTextEdit(null);
  }, []);

  const copyToClipboard = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    try {
      const blob = await engine.exportBlob('image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  }, []);

  const handleSave = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    const hasCrop = engine.hasCrop;
    const blob = await engine.exportBlob('image/png');
    const baseBlob = hasCrop ? await engine.exportBaseBlob('image/png') : null;
    const crop =
      hasCrop && engine.crop && engine.image
        ? {
            x: engine.crop.x,
            y: engine.crop.y,
            width: engine.crop.width,
            height: engine.crop.height,
            imageWidth: engine.image.naturalWidth,
            imageHeight: engine.image.naturalHeight,
          }
        : null;
    onSave?.({
      annotations: engine.getAnnotations({ relativeToCrop: true }),
      annotationsJson: engine.serialize({ relativeToCrop: true }),
      blob,
      hasCrop,
      baseBlob,
      crop,
    });
  }, [onSave]);

  useEffect(() => {
    if (
      saveRequestToken === undefined ||
      saveRequestToken === lastSaveRequestTokenRef.current
    ) {
      return;
    }

    lastSaveRequestTokenRef.current = saveRequestToken;
    void handleSave();
  }, [saveRequestToken, handleSave]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;

      if (textEdit) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTextEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelTextEdit();
        }
        return;
      }

      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        void copyToClipboard();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (engine.deleteSelected()) e.preventDefault();
      } else if (e.key === 'Escape') {
        selectTool('select');
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const toolByKey: Record<string, string> = {
          v: 'select',
          r: 'rect',
          a: 'arrow',
          l: 'line',
          p: 'freehand',
          t: 'text',
          ...(enableCrop ? { c: 'crop' } : {}),
        };
        const tool = toolByKey[e.key.toLowerCase()];
        if (tool) selectTool(tool);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [textEdit, commitTextEdit, cancelTextEdit, copyToClipboard, enableCrop]);

  return (
    <div className="image-editor">
      <div className="editor-toolbar">
        <div className="tool-group">
          {enableCrop && (
            <button
              className={`tool-btn ${activeTool === 'crop' ? 'active' : ''}`}
              onClick={() => selectTool('crop')}
              title="Crop (C)"
            >
              <ToolIcon name="crop" />
            </button>
          )}
          {TOOLS.map((tool) => (
            <button
              key={tool.key}
              className={`tool-btn ${activeTool === tool.key ? 'active' : ''}`}
              onClick={() => selectTool(tool.key)}
              title={tool.title}
            >
              <ToolIcon name={tool.key} />
            </button>
          ))}
          <button
            className="tool-btn"
            onClick={() => engineRef.current?.deleteSelected()}
            disabled={!hasSelection}
            title="Delete selected (⌫)"
          >
            <ToolIcon name="delete" />
          </button>
        </div>

        <div className="tool-group">
          {COLORS.map((color) => (
            <button
              key={color.value}
              className={`color-btn ${currentColor === color.value ? 'active' : ''}`}
              style={{ backgroundColor: color.value }}
              onClick={() => handleColorChange(color.value)}
              title={color.label}
            />
          ))}
          <input
            type="color"
            className="color-picker-native"
            value={currentColor}
            onChange={(e) => handleColorChange(e.target.value)}
            title="Pick a custom color"
          />
        </div>

        <div className="tool-group">
          <label className="slider-label">
            <span className="slider-title">Line width</span>
            <span className="slider-row">
              <input
                type="range"
                min="1"
                max="12"
                value={currentThickness}
                onChange={(e) => handleThicknessChange(parseInt(e.target.value))}
              />
              <span className="slider-value">{currentThickness}px</span>
            </span>
          </label>
          <label className="slider-label">
            <span className="slider-title">Text size</span>
            <span className="slider-row">
              <input
                type="range"
                min="7"
                max="84"
                value={currentFontSize}
                onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
              />
              <span className="slider-value">{currentFontSize}px</span>
            </span>
          </label>
        </div>

        <div className="tool-group">
          <button
            className="tool-btn"
            onClick={() => engineRef.current?.undo()}
            disabled={!historyState.canUndo}
            title="Undo (⌘Z)"
          >
            <ToolIcon name="undo" />
          </button>
          <button
            className="tool-btn"
            onClick={() => engineRef.current?.redo()}
            disabled={!historyState.canRedo}
            title="Redo (⌘⇧Z)"
          >
            <ToolIcon name="redo" />
          </button>
          <button className="tool-btn" onClick={() => void copyToClipboard()} title="Copy (⌘C)">
            <ToolIcon name="copy" />
          </button>
        </div>

        {onSave && showSaveButton && (
          <Button variant="primary" onClick={() => void handleSave()}>
            <ToolIcon name="check" /> Save
          </Button>
        )}
        {onCancel && (
          <Button onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>

      <div className="editor-canvas-container">
        <canvas ref={canvasRef} className="editor-canvas" />

        {textEdit && (
          <div
            className="text-input-overlay"
            // The engine anchors committed text with its top-left at the click
            // point, but typed characters sit inset by the input's border +
            // padding (see .text-input-overlay input in ImageEditor.css). Pull
            // the overlay up-left by that inset so text doesn't jump on commit.
            style={{ left: textEdit.clientX - 10, top: textEdit.clientY - 6 }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={textInputRef}
              type="text"
              value={textEdit.value}
              onChange={(e) => {
                const value = e.target.value;
                if (textEditRef.current) {
                  textEditRef.current = { ...textEditRef.current, value };
                }
                setTextEdit((current) => (current ? { ...current, value } : current));
              }}
              onBlur={commitTextEdit}
              placeholder="Enter text..."
              // Match the drawn text's on-screen size: the canvas is displayed
              // scaled down, so multiply the image-pixel font size by the same
              // scale, otherwise the input looks larger than the result.
              style={{
                fontSize: currentFontSize * (engineRef.current?.displayScale ?? 1),
                color: currentColor,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

import { useRef, useEffect, useState, useCallback } from 'react';
import {
  AnnotationEngine,
  type Annotation,
  type TextEditRequest,
} from '@shared/annotation-engine';
import './ImageEditor.css';

export interface ImageEditorSaveResult {
  annotations: Annotation[];
  annotationsJson: string;
  blob: Blob;
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

const TOOLS: { key: string; label: string; title: string }[] = [
  { key: 'select', label: '⤺', title: 'Select / Move (V)' },
  { key: 'rect', label: '□', title: 'Rectangle (R)' },
  { key: 'arrow', label: '↗', title: 'Arrow (A)' },
  { key: 'line', label: '╱', title: 'Line (L)' },
  { key: 'freehand', label: '✎', title: 'Pen (P)' },
  { key: 'text', label: 'T', title: 'Text (T)' },
];

const COLORS = [
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
  const [currentColor, setCurrentColor] = useState('#ef4444');
  const [currentThickness, setCurrentThickness] = useState(4);
  const [currentFontSize, setCurrentFontSize] = useState(20);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [hasSelection, setHasSelection] = useState(false);
  const [textEdit, setTextEdit] = useState<
    (TextEditRequest & { value: string }) | null
  >(null);

  // Create the engine and load the image
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new AnnotationEngine(canvas, {
      enableCrop,
      onHistoryChange: setHistoryState,
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
        setTextEdit({ ...request, value: request.annotation?.text ?? '' });
        setTimeout(() => textInputRef.current?.focus(), 0);
      },
    });

    engineRef.current = engine;
    engine.color = '#ef4444';
    engine.thickness = 4;
    engine.fontSize = 20;

    let cancelled = false;
    const parsed = initialAnnotationsRef.current;
    void engine
      .loadImage(imageUrl, {
        annotations:
          typeof parsed === 'string'
            ? (JSON.parse(parsed || '{"items":[]}').items ?? [])
            : (parsed ?? []),
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
    if (!engine || !textEdit) return;

    if (textEdit.annotation) {
      engine.updateText(textEdit.annotation.id, textEdit.value);
    } else {
      engine.insertText(textEdit.imagePoint, textEdit.value);
    }
    setTextEdit(null);
  }, [textEdit]);

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

    const blob = await engine.exportBlob('image/png');
    onSave?.({
      annotations: engine.getAnnotations({ relativeToCrop: true }),
      annotationsJson: engine.serialize({ relativeToCrop: true }),
      blob,
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
          setTextEdit(null);
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
        };
        const tool = toolByKey[e.key.toLowerCase()];
        if (tool) selectTool(tool);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [textEdit, commitTextEdit, copyToClipboard]);

  return (
    <div className="image-editor">
      <div className="editor-toolbar">
        <div className="tool-group">
          {enableCrop && (
            <button
              className={`tool-btn ${activeTool === 'crop' ? 'active' : ''}`}
              onClick={() => selectTool('crop')}
              title="Crop"
            >
              ✂️
            </button>
          )}
          {TOOLS.map((tool) => (
            <button
              key={tool.key}
              className={`tool-btn ${activeTool === tool.key ? 'active' : ''}`}
              onClick={() => selectTool(tool.key)}
              title={tool.title}
            >
              {tool.label}
            </button>
          ))}
          <button
            className="tool-btn"
            onClick={() => engineRef.current?.deleteSelected()}
            disabled={!hasSelection}
            title="Delete selected (⌫)"
          >
            🗑
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
        </div>

        <div className="tool-group">
          <label className="slider-label">
            Thickness:
            <input
              type="range"
              min="1"
              max="12"
              value={currentThickness}
              onChange={(e) => handleThicknessChange(parseInt(e.target.value))}
            />
            <span>{currentThickness}px</span>
          </label>
          <label className="slider-label">
            Font Size:
            <input
              type="range"
              min="12"
              max="48"
              value={currentFontSize}
              onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
            />
            <span>{currentFontSize}px</span>
          </label>
        </div>

        <div className="tool-group">
          <button
            className="tool-btn"
            onClick={() => engineRef.current?.undo()}
            disabled={!historyState.canUndo}
            title="Undo (⌘Z)"
          >
            ↶
          </button>
          <button
            className="tool-btn"
            onClick={() => engineRef.current?.redo()}
            disabled={!historyState.canRedo}
            title="Redo (⌘⇧Z)"
          >
            ↷
          </button>
          <button className="tool-btn" onClick={() => void copyToClipboard()} title="Copy (⌘C)">
            📋
          </button>
        </div>

        {onSave && showSaveButton && (
          <button className="done-btn" onClick={() => void handleSave()}>
            ✓ Save
          </button>
        )}
        {onCancel && (
          <button className="cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      <div className="editor-canvas-container">
        <canvas ref={canvasRef} className="editor-canvas" />

        {textEdit && (
          <div
            className="text-input-overlay"
            style={{ left: textEdit.clientX, top: textEdit.clientY }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={textInputRef}
              type="text"
              value={textEdit.value}
              onChange={(e) =>
                setTextEdit((current) =>
                  current ? { ...current, value: e.target.value } : current
                )
              }
              onBlur={commitTextEdit}
              placeholder="Enter text..."
              style={{ fontSize: currentFontSize, color: currentColor }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

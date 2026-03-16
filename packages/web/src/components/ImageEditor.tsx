import { useRef, useEffect, useState, useCallback } from 'react';
import './ImageEditor.css';

type Tool = 'crop' | 'rectangle' | 'arrow' | 'text' | null;

interface ImageEditorProps {
  imageUrl: string;
  onSave?: (blob: Blob) => void;
  onCancel?: () => void;
  showSaveButton?: boolean;
  saveRequestToken?: number;
}

interface HistoryState {
  imageData: ImageData;
  width: number;
  height: number;
}

export function ImageEditor({
  imageUrl,
  onSave,
  onCancel,
  showSaveButton = true,
  saveRequestToken,
}: ImageEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [currentTool, setCurrentTool] = useState<Tool>(null);
  const [currentColor, setCurrentColor] = useState('#ef4444');
  const [currentThickness, setCurrentThickness] = useState(3);
  const [currentFontSize, setCurrentFontSize] = useState(20);
  const [isDrawing, setIsDrawing] = useState(false);
  const [history, setHistory] = useState<HistoryState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [textInputActive, setTextInputActive] = useState(false);
  const [textInputPosition, setTextInputPosition] = useState({ x: 0, y: 0 });
  const [textInputValue, setTextInputValue] = useState('');
  const textInputRef = useRef<HTMLInputElement>(null);
  const lastSaveRequestTokenRef = useRef<number | undefined>(saveRequestToken);
  
  const startPosRef = useRef({ x: 0, y: 0 });
  const originalImageRef = useRef<HTMLImageElement | null>(null);

  const MAX_HISTORY = 50;
  const colors = [
    { value: '#ef4444', label: 'Red' },
    { value: '#f59e0b', label: 'Orange' },
    { value: '#eab308', label: 'Yellow' },
    { value: '#22c55e', label: 'Green' },
    { value: '#3b82f6', label: 'Blue' },
    { value: '#8b5cf6', label: 'Purple' },
    { value: '#ffffff', label: 'White' }
  ];

  // Load image
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      originalImageRef.current = img;
      
      // Create temp canvas
      tempCanvasRef.current = document.createElement('canvas');
      
      // Save initial state
      saveToHistory(ctx, canvas.width, canvas.height);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const saveToHistory = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    
    setHistory(prev => {
      let newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push({ imageData, width, height });
      
      if (newHistory.length > MAX_HISTORY) {
        newHistory = newHistory.slice(1);
        setHistoryIndex(idx => idx);
        return newHistory;
      }
      
      setHistoryIndex(newHistory.length - 1);
      return newHistory;
    });
  }, [historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      setHistoryIndex(idx => {
        const newIdx = idx - 1;
        const state = history[newIdx];
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx && state) {
          canvas.width = state.width;
          canvas.height = state.height;
          ctx.putImageData(state.imageData, 0, 0);
        }
        return newIdx;
      });
    }
  }, [historyIndex, history]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(idx => {
        const newIdx = idx + 1;
        const state = history[newIdx];
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx && state) {
          canvas.width = state.width;
          canvas.height = state.height;
          ctx.putImageData(state.imageData, 0, 0);
        }
        return newIdx;
      });
    }
  }, [historyIndex, history]);

  const getCanvasCoordinates = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  const drawRectangle = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
    const width = x2 - x1;
    const height = y2 - y1;
    ctx.strokeRect(x1, y1, width, height);
  };

  const drawArrow = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
    const headLength = 20;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLength * Math.cos(angle - Math.PI / 6),
      y2 - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLength * Math.cos(angle + Math.PI / 6),
      y2 - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.stroke();
  };

  const drawCropPreview = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, tempCanvas: HTMLCanvasElement, x1: number, y1: number, x2: number, y2: number) => {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const width = x2 - x1;
    const height = y2 - y1;
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      ctx.clearRect(x1, y1, width, height);
      ctx.drawImage(tempCanvas, x1, y1, width, height, x1, y1, width, height);
    }

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(x1, y1, width, height);
    ctx.setLineDash([]);
  };

  const executeCrop = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, tempCanvas: HTMLCanvasElement, x1: number, y1: number, x2: number, y2: number) => {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    if (width < 10 || height < 10) {
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) {
        ctx.drawImage(tempCanvas, 0, 0);
      }
      return;
    }

    const croppedData = ctx.getImageData(left, top, width, height);
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(croppedData, 0, 0);

    saveToHistory(ctx, width, height);
    setCurrentTool(null);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!currentTool || textInputActive) return;

    const coords = getCanvasCoordinates(e);
    startPosRef.current = coords;
    setIsDrawing(true);

    if (currentTool === 'text') {
      setTextInputPosition({ x: e.clientX, y: e.clientY });
      setTextInputActive(true);
      setTextInputValue('');
      setTimeout(() => textInputRef.current?.focus(), 0);
    } else {
      const canvas = canvasRef.current;
      const tempCanvas = tempCanvasRef.current;
      if (canvas && tempCanvas) {
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx) {
          tempCtx.drawImage(canvas, 0, 0);
        }
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentTool || currentTool === 'text') return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const tempCanvas = tempCanvasRef.current;
    
    if (!canvas || !ctx || !tempCanvas) return;

    const coords = getCanvasCoordinates(e);
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      ctx.drawImage(tempCanvas, 0, 0);
    }

    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentThickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (currentTool === 'crop') {
      drawCropPreview(ctx, canvas, tempCanvas, startPosRef.current.x, startPosRef.current.y, coords.x, coords.y);
    } else if (currentTool === 'rectangle') {
      drawRectangle(ctx, startPosRef.current.x, startPosRef.current.y, coords.x, coords.y);
    } else if (currentTool === 'arrow') {
      drawArrow(ctx, startPosRef.current.x, startPosRef.current.y, coords.x, coords.y);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    setIsDrawing(false);

    if (!currentTool || currentTool === 'text') return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const tempCanvas = tempCanvasRef.current;
    
    if (!canvas || !ctx || !tempCanvas) return;

    const coords = getCanvasCoordinates(e);

    if (currentTool === 'crop') {
      executeCrop(ctx, canvas, tempCanvas, startPosRef.current.x, startPosRef.current.y, coords.x, coords.y);
    } else {
      saveToHistory(ctx, canvas.width, canvas.height);
    }
  };

  const finalizeText = useCallback(() => {
    if (!textInputValue.trim()) {
      setTextInputActive(false);
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const coords = getCanvasCoordinates({
      clientX: textInputPosition.x,
      clientY: textInputPosition.y
    } as React.MouseEvent<HTMLCanvasElement>);

    ctx.font = `${currentFontSize}px Arial`;
    ctx.fillStyle = currentColor;
    ctx.textBaseline = 'top';
    ctx.fillText(textInputValue, coords.x, coords.y);

    saveToHistory(ctx, canvas.width, canvas.height);
    setTextInputActive(false);
    setTextInputValue('');
  }, [
    currentColor,
    currentFontSize,
    saveToHistory,
    textInputPosition.x,
    textInputPosition.y,
    textInputValue,
  ]);

  const copyToClipboard = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const blob = await new Promise<Blob>((resolve) => 
        canvas.toBlob((b) => b && resolve(b), 'image/png')
      );
      
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      
      alert('Copied to clipboard!');
    } catch (error) {
      console.error('Failed to copy:', error);
      alert('Failed to copy to clipboard');
    }
  };

  const handleSave = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (textInputActive) {
      finalizeText();
    }

    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => b && resolve(b), 'image/png')
    );

    onSave?.(blob);
  }, [finalizeText, onSave, textInputActive]);

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
      if (textInputActive) {
        if (e.key === 'Enter') {
          e.preventDefault();
          finalizeText();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setTextInputActive(false);
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        copyToClipboard();
      } else if (e.key === 'Escape') {
        setCurrentTool(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [textInputActive, undo, redo]);

  return (
    <div className="image-editor">
      <div className="editor-toolbar">
        <div className="tool-group">
          <button
            className={`tool-btn ${currentTool === 'crop' ? 'active' : ''}`}
            onClick={() => setCurrentTool(currentTool === 'crop' ? null : 'crop')}
            title="Crop (✂️)"
          >
            ✂️
          </button>
          <button
            className={`tool-btn ${currentTool === 'rectangle' ? 'active' : ''}`}
            onClick={() => setCurrentTool(currentTool === 'rectangle' ? null : 'rectangle')}
            title="Rectangle"
          >
            □
          </button>
          <button
            className={`tool-btn ${currentTool === 'arrow' ? 'active' : ''}`}
            onClick={() => setCurrentTool(currentTool === 'arrow' ? null : 'arrow')}
            title="Arrow"
          >
            ↗️
          </button>
          <button
            className={`tool-btn ${currentTool === 'text' ? 'active' : ''}`}
            onClick={() => setCurrentTool(currentTool === 'text' ? null : 'text')}
            title="Text"
          >
            T
          </button>
        </div>

        <div className="tool-group">
          {colors.map(color => (
            <button
              key={color.value}
              className={`color-btn ${currentColor === color.value ? 'active' : ''}`}
              style={{ backgroundColor: color.value }}
              onClick={() => setCurrentColor(color.value)}
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
              max="10"
              value={currentThickness}
              onChange={(e) => setCurrentThickness(parseInt(e.target.value))}
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
              onChange={(e) => setCurrentFontSize(parseInt(e.target.value))}
            />
            <span>{currentFontSize}px</span>
          </label>
        </div>

        <div className="tool-group">
          <button
            className="tool-btn"
            onClick={undo}
            disabled={historyIndex <= 0}
            title="Undo (⌘Z)"
          >
            ↶
          </button>
          <button
            className="tool-btn"
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            title="Redo (⌘⇧Z)"
          >
            ↷
          </button>
          <button
            className="tool-btn"
            onClick={copyToClipboard}
            title="Copy (⌘C)"
          >
            📋
          </button>
        </div>

        {onSave && showSaveButton && (
          <button className="done-btn" onClick={handleSave}>
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
        <canvas
          ref={canvasRef}
          className="editor-canvas"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: currentTool ? 'crosshair' : 'default' }}
        />
        
        {textInputActive && (
          <div
            className="text-input-overlay"
            style={{ left: textInputPosition.x, top: textInputPosition.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={textInputRef}
              type="text"
              value={textInputValue}
              onChange={(e) => setTextInputValue(e.target.value)}
              placeholder="Enter text..."
              style={{ fontSize: currentFontSize, color: currentColor }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

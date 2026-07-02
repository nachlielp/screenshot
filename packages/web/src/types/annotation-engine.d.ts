declare module "@shared/annotation-engine" {
  export interface AnnotationPoint {
    x: number;
    y: number;
  }

  export type AnnotationType = "rect" | "arrow" | "line" | "freehand" | "text";

  export interface Annotation {
    id: string;
    type: AnnotationType;
    points: AnnotationPoint[];
    color: string;
    thickness: number;
    text?: string;
    fontSize?: number;
  }

  export interface TextEditRequest {
    imagePoint: AnnotationPoint;
    clientX: number;
    clientY: number;
    annotation: Annotation | null;
  }

  export interface AnnotationEngineOptions {
    enableCrop?: boolean;
    onChange?: () => void;
    onSelectionChange?: (annotation: Annotation | null) => void;
    onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
    onTextEditRequest?: (request: TextEditRequest) => void;
  }

  export const ANNOTATIONS_VERSION: number;

  export function sanitizeAnnotations(items: unknown): Annotation[];
  export function parseAnnotations(
    json: string | { items?: unknown } | Annotation[] | null | undefined
  ): Annotation[];
  export function serializeAnnotations(items: Annotation[]): string;
  export function renderAnnotatedBlob(
    imageSource: string | Blob,
    annotations: string | Annotation[] | null | undefined,
    mimeType?: string
  ): Promise<Blob>;
  export function drawAnnotatedImage(
    canvas: HTMLCanvasElement,
    image: HTMLImageElement,
    annotations: string | Annotation[] | null | undefined
  ): void;

  export class AnnotationEngine {
    constructor(canvas: HTMLCanvasElement, options?: AnnotationEngineOptions);
    tool: string;
    color: string;
    thickness: number;
    fontSize: number;
    readonly selectedAnnotation: Annotation | null;
    readonly hasCrop: boolean;
    loadImage(
      source: string | Blob,
      options?: { annotations?: Annotation[]; resetHistory?: boolean }
    ): Promise<void>;
    getAnnotations(options?: { relativeToCrop?: boolean }): Annotation[];
    setAnnotations(items: Annotation[]): void;
    serialize(options?: { relativeToCrop?: boolean }): string;
    setTool(tool: string | null): void;
    setColor(color: string): void;
    setThickness(thickness: number): void;
    setFontSize(fontSize: number): void;
    selectAnnotation(id: string | null): void;
    deleteSelected(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    undo(): void;
    redo(): void;
    insertText(point: AnnotationPoint, text: string): Annotation | null;
    updateText(id: string, text: string): void;
    clientToImage(clientX: number, clientY: number): AnnotationPoint;
    exportBlob(mimeType?: string): Promise<Blob>;
    exportBaseBlob(mimeType?: string): Promise<Blob>;
    render(): void;
    destroy(): void;
  }
}

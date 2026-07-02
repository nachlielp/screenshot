import { useEffect, useRef } from "react";
import { drawAnnotatedImage } from "@shared/annotation-engine";

/**
 * Renders the base image with its vector annotations drawn on top.
 * Falls back to a plain <img> when there are no annotations, so existing
 * snapshots behave exactly as before.
 */
export function AnnotatedImage({
  src,
  annotations,
  alt,
  className,
}: {
  src: string;
  annotations?: string | null;
  alt?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const hasAnnotations = Boolean(
    annotations && annotations.includes('"items"') && !annotations.includes('"items":[]')
  );

  useEffect(() => {
    if (!hasAnnotations) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      drawAnnotatedImage(canvas, image, annotations);
    };
    image.onerror = () => console.error("Failed to load snapshot image");
    image.src = src;

    return () => {
      cancelled = true;
    };
  }, [src, annotations, hasAnnotations]);

  if (!hasAnnotations) {
    return <img src={src} alt={alt} className={className} />;
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={alt}
      style={{ maxWidth: "100%", height: "auto" }}
    />
  );
}

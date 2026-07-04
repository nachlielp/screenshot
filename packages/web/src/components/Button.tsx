import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The one action button for the whole web app. Wraps the pink-posthog `.btn`
 * classes (defined globally in index.css) so every button is the same height
 * (34px) and type scale — there is intentionally no size variant. Reach for
 * `ghost` when a real button is too heavy; pass `className` only for layout
 * (e.g. `flex: 1`), never for sizing.
 */
type Variant = "primary" | "secondary" | "danger" | "success";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  ghost?: boolean;
  /** Leading icon (line-drawn SVG), rendered before the label. */
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  ghost = false,
  icon,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const variantClass = ghost ? "btn-ghost" : `btn btn-${variant}`;
  return (
    <button
      type={type}
      className={[variantClass, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

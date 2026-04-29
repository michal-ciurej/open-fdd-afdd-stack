import * as React from "react";
import { cn } from "@/lib/utils";

interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Public asset path (served from frontend/public) — e.g. "/data/images/overview.jpg".
   *  When omitted, renders just the soft green gradient overlay. */
  backgroundImage?: string;
  /** 0..1; multiplied with the base 0.08 page-image opacity. Default 1. */
  intensity?: number;
}

/**
 * Wraps page content with a fixed, low-opacity background image and a green→transparent
 * gradient wash, sized to the main content area. Lives behind everything; never blocks input.
 *
 * Image is rendered as a fixed background — no backdrop-blur, so it's free on the GPU even
 * for dense data pages.
 */
export function PageShell({
  backgroundImage,
  intensity = 1,
  className,
  children,
  ...props
}: PageShellProps) {
  const baseOpacity = 0.08 * intensity;
  return (
    <div className={cn("relative", className)} {...props}>
      {backgroundImage && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage: `url("${backgroundImage}")`,
            opacity: baseOpacity,
          }}
        />
      )}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-br from-primary/[0.06] via-transparent to-transparent"
      />
      {children}
    </div>
  );
}

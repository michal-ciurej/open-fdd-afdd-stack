import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Card tones:
 * - "flat" (default): solid surface, premium gradient stroke + soft elevation. No backdrop-blur.
 *   Use everywhere by default — performant on tables, charts, and dense data screens.
 * - "glass": semi-transparent surface with backdrop-blur. GPU-expensive; opt in only for
 *   hero/overview surfaces (Overview page) where it reads as premium and density is low.
 * - "elevated": same as flat but with stronger shadow — for primary call-to-action cards.
 */
type CardTone = "flat" | "glass" | "elevated";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
}

const toneClasses: Record<CardTone, string> = {
  flat: "bg-card text-card-foreground rounded-2xl gradient-stroke shadow-[var(--shadow-elev-sm)]",
  glass:
    "bg-card/65 text-card-foreground rounded-2xl gradient-stroke shadow-[var(--shadow-elev-md)] backdrop-blur-xl backdrop-saturate-150",
  elevated:
    "bg-card text-card-foreground rounded-2xl gradient-stroke shadow-[var(--shadow-elev-lg)]",
};

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, tone = "flat", ...props }, ref) => (
    <div ref={ref} className={cn(toneClasses[tone], className)} {...props} />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-tight tracking-tight",
      className,
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
export type { CardProps, CardTone };

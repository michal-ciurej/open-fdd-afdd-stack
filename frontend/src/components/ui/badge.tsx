import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "secondary" | "destructive" | "success" | "warning" | "outline";
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide ring-1 ring-inset",
        {
          "bg-primary/10 text-primary ring-primary/20": variant === "default",
          "bg-secondary text-secondary-foreground ring-border/40": variant === "secondary",
          "bg-destructive/10 text-destructive ring-destructive/25": variant === "destructive",
          "bg-success/10 text-success ring-success/25": variant === "success",
          "bg-warning/15 text-warning-foreground ring-warning/30": variant === "warning",
          "bg-transparent text-muted-foreground ring-border/60": variant === "outline",
        },
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
export type { BadgeProps };

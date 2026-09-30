import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "surface" | "raised" | "sunken" | "outline";
}

const tones = {
  surface: "bg-surface border border-border-base",
  raised: "bg-surface-raised border border-border-base",
  sunken: "bg-surface-sunken",
  outline: "border border-border-strong",
} as const;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, tone = "surface", ...props },
  ref,
) {
  return <div ref={ref} className={cn("rounded-lg", tones[tone], className)} {...props} />;
});

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-3 py-2 border-b border-border-base", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-sm font-semibold text-content", className)} {...props} />
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-3", className)} {...props} />;
}

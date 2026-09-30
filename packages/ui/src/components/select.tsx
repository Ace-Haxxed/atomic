import { forwardRef, type HTMLAttributes, type SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Rendered when no real option is supplied yet, e.g. the model list is loading. */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, placeholder, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-8 w-full appearance-none rounded-md border border-border-base bg-surface px-2 pr-7 text-sm text-content",
        "bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat",
        "focus:border-accent focus:outline-none",
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3 4.5 6 7.5 9 4.5' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
      }}
      {...props}
    >
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {children}
    </select>
  );
});

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded bg-surface-raised", className)}
      {...props}
    />
  );
}

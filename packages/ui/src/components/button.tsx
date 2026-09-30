import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

/**
 * Every interactive control in Atomic uses this one button. Sizes are in rem so
 * they scale with the user's font-size setting, and the hit area never drops
 * below 28px even at the compact end.
 *
 * The base class is deliberately explicit about layout. An icon+label button has
 * to be a flex row with a fixed line height: without `leading-*` the label's
 * line box is taller than the button and gets clipped, and without `shrink-0` on
 * the svg the icon is the first thing to squash when the label is long.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    // A fixed leading keeps the text box equal across sizes, so an icon+label
    // button is exactly as tall as its `h-*` and never overflows it.
    "leading-[1.2] font-medium",
    "rounded-md transition-colors duration-100",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:shrink-0 [&_svg]:size-4",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-foreground hover:bg-accent-hover active:brightness-95",
        secondary:
          "bg-surface-raised text-content border border-border-base hover:bg-surface-sunken",
        ghost: "text-content-muted hover:bg-surface-raised hover:text-content",
        outline:
          "border border-border-strong text-content hover:bg-surface-raised",
        danger: "bg-danger text-white hover:brightness-110",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2 text-xs",
        md: "h-8 px-3 text-sm",
        lg: "h-10 px-4 text-sm",
        icon: "size-8",
        "icon-sm": "size-7",
      },
      block: {
        true: "w-full",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>`, keeping the styling. */
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  block,
  asChild = false,
  type,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      // Buttons inside a form default to submit, which is almost never wanted.
      {...(asChild ? {} : { type: type ?? "button" })}
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...props}
    />
  );
}

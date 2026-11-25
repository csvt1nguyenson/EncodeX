import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-medium transition-colors duration-150 select-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-cyan-400 text-zinc-950 font-semibold shadow-[0_0_18px_rgba(34,211,238,0.28)] hover:bg-cyan-300 active:scale-[0.99]",
        secondary:
          "bg-zinc-900 text-zinc-100 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700",
        warning:
          "bg-amber-400 text-zinc-950 font-semibold hover:bg-amber-300",
        destructive:
          "bg-rose-500/12 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20 hover:border-rose-500/50",
        ghost:
          "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100",
      },
      size: {
        sm: "h-7 px-2.5 text-[11px]",
        md: "h-8 px-3",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Tag = asChild ? Slot : "button";
  return <Tag className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

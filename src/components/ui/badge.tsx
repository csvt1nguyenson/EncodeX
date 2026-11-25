import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeStyles = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-tight whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-zinc-900 text-zinc-300 border-zinc-800",
        cyan: "bg-cyan-500/15 text-cyan-300 border-cyan-500/35",
        emerald: "bg-emerald-500/15 text-emerald-300 border-emerald-500/35",
        amber: "bg-amber-500/15 text-amber-300 border-amber-500/35",
        rose: "bg-rose-500/15 text-rose-300 border-rose-500/35",
        orange: "bg-orange-500/15 text-orange-300 border-orange-500/35",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeStyles> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeStyles({ tone }), className)} {...props} />;
}

import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

interface ProgressProps extends ProgressPrimitive.ProgressProps {
  tone?: "cyan" | "emerald" | "rose";
}

export function Progress({ value = 0, tone = "cyan", className, ...props }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, Number(value) || 0));
  const barColor =
    tone === "emerald"
      ? "bg-emerald-400"
      : tone === "rose"
        ? "bg-rose-500"
        : "bg-cyan-400";

  return (
    <ProgressPrimitive.Root
      value={clamped}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-800",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn("h-full w-full transition-transform duration-150", barColor)}
        style={{ transform: `translateX(-${100 - clamped}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

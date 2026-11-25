import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      richColors
      toastOptions={{
        classNames: {
          toast: "!bg-[#141417] !border !border-zinc-800 !text-zinc-100 !text-xs !shadow-xl",
          description: "!text-zinc-400",
        },
      }}
    />
  );
}

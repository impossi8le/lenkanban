import { toast as sonnerToast } from "sonner";
import { isValidElement, type ReactNode } from "react";

type LegacyToast = {
  title?: ReactNode;
  description?: ReactNode;
  variant?: "default" | "destructive";
  duration?: number;
};
type Message = Parameters<typeof sonnerToast>[0];
type Options = Parameters<typeof sonnerToast>[1];

function isLegacyToast(message: Message | LegacyToast): message is LegacyToast {
  return typeof message === "object" && message !== null && !isValidElement(message)
    && ("title" in message || "description" in message || "variant" in message);
}

// Support legacy object callers while preserving Sonner's callable API and methods.
export const toast = Object.assign((message: Message | LegacyToast, options?: Options) => {
  if (isLegacyToast(message)) {
    const { title, description, variant, duration } = message;
    const notify = variant === "destructive" ? sonnerToast.error : sonnerToast;
    return notify(title, { description, duration, ...options });
  }
  return sonnerToast(message, options);
}, sonnerToast);

export function useToast() {
  return {
    toast,
  };
}

import * as React from "react";
import { MessageCircle, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

// 44px on touch layouts, tighter where there is a pointer.
const SQUARE = "inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-colors lg:size-8 [&_svg]:size-4";
const READY = "bg-brand-soft text-brand hover:bg-brand hover:text-brand-fg focus-visible:outline-2 focus-visible:outline-ring";
const UNAVAILABLE = "cursor-not-allowed bg-bg-subtle text-fg-subtle";

/** One-tap call on the device's dialler. Without a number (none saved, or not visible to this member) it stays visibly off. */
export function CallLink({ phone, name, className }: { phone: string | null | undefined; name: string; className?: string }) {
  const digits = phone?.replace(/[^\d+]/g, "");
  if (!digits) {
    return (
      <button type="button" disabled title="No phone number" aria-label={`Call ${name}: no phone number`} className={cn(SQUARE, UNAVAILABLE, className)}>
        <Phone aria-hidden />
      </button>
    );
  }
  return (
    <a href={`tel:${digits}`} draggable={false} aria-label={`Call ${name}`} title={`Call ${phone}`} className={cn(SQUARE, READY, className)}>
      <Phone aria-hidden />
    </a>
  );
}

/** Opens the WhatsApp composer, which owns consent, the service window and templates. */
export function WhatsAppButton({ phone, name, onClick, className }: { phone: string | null | undefined; name: string; onClick: () => void; className?: string }) {
  const available = Boolean(phone);
  return (
    <button
      type="button"
      disabled={!available}
      onClick={onClick}
      aria-label={available ? `WhatsApp ${name}` : `WhatsApp ${name}: no phone number`}
      title={available ? "Send a WhatsApp message" : "No phone number"}
      className={cn(SQUARE, available ? READY : UNAVAILABLE, className)}
    >
      <MessageCircle aria-hidden />
    </button>
  );
}

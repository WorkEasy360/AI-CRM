import * as React from "react";
import { MessageCircle, Phone } from "lucide-react";
import { whatsAppUrl } from "@/lib/phone";
import { cn } from "@/lib/utils";

// 44px on touch layouts, tighter where there is a pointer.
const SQUARE = "inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-colors lg:size-8 [&_svg]:size-4 max-md:rounded-full max-md:[&_svg]:size-5 max-md:[&_svg]:fill-current";
const READY = "bg-brand-soft text-brand hover:bg-brand hover:text-brand-fg focus-visible:outline-2 focus-visible:outline-ring";
const UNAVAILABLE = "cursor-not-allowed bg-bg-subtle text-fg-subtle";

const WHATSAPP = "bg-[#25D366]/10 text-[#25D366] hover:bg-[#25D366] hover:text-white focus-visible:outline-2 focus-visible:outline-ring";

/** The WhatsApp logo, in the current text colour. */
export function WhatsAppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.91-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35ZM12.05 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88a9.82 9.82 0 0 1 6.99 2.9 9.83 9.83 0 0 1 2.9 7c0 5.44-4.44 9.87-9.89 9.87Zm8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.17-3.48-8.42Z" />
    </svg>
  );
}

function Unavailable({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" disabled title="No phone number" aria-label={`${label}: no phone number`} className={cn(SQUARE, UNAVAILABLE, className)}>
      {children}
    </button>
  );
}

/** A link inside a draggable card: a click stays with the link, and the link itself cannot be dragged away. */
const inCard = {
  target: "_blank",
  rel: "noopener noreferrer",
  draggable: false,
  onClick: (event: React.MouseEvent) => event.stopPropagation(),
};

/** Opens the chat in the member's own WhatsApp. Takes an already normalized number; null shows it switched off. */
export function WhatsAppChatLink({ number, name, text, className }: { number: string | null; name: string; text?: string; className?: string }) {
  if (!number) {
    return (
      <Unavailable label={`WhatsApp ${name}`} className={className}>
        <WhatsAppLogo />
      </Unavailable>
    );
  }
  return (
    <a href={whatsAppUrl(number, text)} {...inCard} aria-label={`WhatsApp ${name}`} title="Open in WhatsApp" className={cn(SQUARE, WHATSAPP, className)}>
      <WhatsAppLogo />
    </a>
  );
}

/** WhatsApp has no link that starts a call, so this opens the chat, where the call is one tap away. */
export function WhatsAppCallLink({ number, name, className }: { number: string | null; name: string; className?: string }) {
  if (!number) {
    return (
      <Unavailable label={`Call ${name}`} className={className}>
        <Phone aria-hidden />
      </Unavailable>
    );
  }
  return (
    <a href={whatsAppUrl(number)} {...inCard} aria-label={`WhatsApp call ${name}`} title="WhatsApp call (opens chat)" className={cn(SQUARE, WHATSAPP, className)}>
      <Phone aria-hidden />
    </a>
  );
}

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

"use client";

import * as React from "react";
import QRCode from "qrcode";

/**
 * Renders an otpauth:// URL as an inline SVG built from the QR bit matrix.
 * No HTML strings are injected: modules become a single <path>.
 */
export function TotpQr({ value, size = 176 }: { value: string; size?: number }) {
  const model = React.useMemo(() => {
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
      const count = qr.modules.size;
      const data = qr.modules.data;
      let d = "";
      for (let y = 0; y < count; y += 1) {
        for (let x = 0; x < count; x += 1) {
          if (data[y * count + x]) d += `M${x} ${y}h1v1h-1z`;
        }
      }
      return { count, d };
    } catch {
      return null;
    }
  }, [value]);

  if (!model) return null;
  const quiet = 2;
  const box = model.count + quiet * 2;
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      className="rounded-sm border border-border bg-white"
    >
      <rect width={box} height={box} fill="#ffffff" />
      <path d={model.d} fill="#151a22" transform={`translate(${quiet} ${quiet})`} />
    </svg>
  );
}

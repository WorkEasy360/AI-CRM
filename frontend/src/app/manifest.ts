import type { MetadataRoute } from "next";

/**
 * Web app manifest, served at /manifest.webmanifest. It makes Keel installable and is the source the
 * Android Trusted Web Activity in android/ is generated from (twa-manifest.json mirrors these values).
 * Colours match the light theme's page background (--kl-bg) and brand primary (--kl-primary-600).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Keel CRM",
    short_name: "Keel",
    description: "Pipeline, contacts and follow-ups for sales teams.",
    start_url: "/pipeline",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f5f9fd",
    theme_color: "#f5f9fd",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" },
    ],
    shortcuts: [
      { name: "Pipeline", url: "/pipeline", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Contacts", url: "/contacts", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Activities", url: "/activities", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}

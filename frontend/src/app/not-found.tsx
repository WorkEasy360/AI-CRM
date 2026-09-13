import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-fg-muted">The page you are looking for does not exist or has moved.</p>
      <Link href="/pipeline" className="text-sm font-medium text-primary hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}

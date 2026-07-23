import { AlertTriangle } from "lucide-react";

/**
 * Shared Forbidden / Access Denied state. Rendered when a route or page area
 * is outside the user's effective permissions (the server independently
 * rejects the underlying requests).
 */
export default function AccessDenied({
  title = "Access restricted",
  message = "Your account does not have permission to open this area.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-destructive" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

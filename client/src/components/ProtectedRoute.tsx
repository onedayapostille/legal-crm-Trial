import { useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { isActiveSession, userCan } from "@/lib/permissions";
import type { KnownCapability } from "@shared/policy";
import { Loader2 } from "lucide-react";

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Capability required to open this route (Phase 10 — typed, not a legacy string). */
  capability?: KnownCapability;
}

export default function ProtectedRoute({ children, capability }: ProtectedRouteProps) {
  const [, navigate] = useLocation();
  const { data: user, isLoading, error } = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });

  // No session, an errored session, or an inactive/suspended account → login.
  // (The server also enforces this; this is the UI reflection, not the gate.)
  const active = isActiveSession(user);
  useEffect(() => {
    if (!isLoading && (!user || error || !active)) {
      navigate("/login");
    }
  }, [user, isLoading, error, active, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!user || !active) return null;

  if (capability && !userCan(user, capability)) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold">Access restricted</h1>
          <p className="mt-2 text-muted-foreground">
            Your account does not have permission to open this area.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

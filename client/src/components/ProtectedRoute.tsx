import { useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { can, type Capability } from "@shared/permissions";
import { Loader2 } from "lucide-react";
import AccessDenied from "@/components/AccessDenied";

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Capability required to open this route (central policy, shared/permissions.ts). */
  capability?: Capability;
  /** Any one of these capabilities grants access (view/manage splits). */
  anyCapability?: Capability[];
}

export default function ProtectedRoute({ children, capability, anyCapability }: ProtectedRouteProps) {
  const [, navigate] = useLocation();
  const { data: user, isLoading, error } = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!isLoading && (!user || error)) {
      navigate("/login");
    }
  }, [user, isLoading, error, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!user) return null;

  const allowed =
    (!capability || can(user.role, capability)) &&
    (!anyCapability || anyCapability.some(c => can(user.role, c)));

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <AccessDenied />
      </div>
    );
  }

  return <>{children}</>;
}

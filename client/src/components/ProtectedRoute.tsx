import { useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { hasPermission } from "@shared/const";
import { Loader2 } from "lucide-react";

interface ProtectedRouteProps {
  children: React.ReactNode;
  permission?: string;
}

export default function ProtectedRoute({ children, permission }: ProtectedRouteProps) {
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

  if (permission && !hasPermission(user.role, permission)) {
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

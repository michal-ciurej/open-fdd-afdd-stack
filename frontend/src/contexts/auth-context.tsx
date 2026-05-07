import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Role = "admin" | "engineer" | "user";

export interface AuthUser {
  oid: string;
  email: string;
  roles: Role[];
  sites: string[] | null; // null = unrestricted (admin/machine)
  isMachine: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  signOut: () => void;
  hasRole: (...roles: Role[]) => boolean;
  canAccessSite: (siteId: string) => boolean;
  isAdmin: boolean;
  isEngineer: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ME_URL = "/api/auth/me";
const LOGIN_URL = "/login";
const LOGOUT_URL = "/logout";

interface MeResponse {
  oid: string;
  email: string;
  roles: string[];
  sites: string[] | null;
  is_machine: boolean;
}

function normalizeRoles(roles: string[] | undefined): Role[] {
  if (!roles) return [];
  const valid: Role[] = ["admin", "engineer", "user"];
  return roles.filter((r): r is Role => (valid as string[]).includes(r));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(ME_URL, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (res.status === 401) {
        // Not signed in — bounce to SWA's Entra redirect.
        window.location.assign(LOGIN_URL);
        return;
      }
      if (!res.ok) {
        throw new Error(`auth/me ${res.status}`);
      }
      const body = (await res.json()) as MeResponse;
      setUser({
        oid: body.oid,
        email: body.email,
        roles: normalizeRoles(body.roles),
        sites: body.sites,
        isMachine: body.is_machine,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "auth failed");
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<AuthContextValue>(() => {
    const roles = user?.roles ?? [];
    const sites = user?.sites ?? null;
    const isAdmin = roles.includes("admin");
    return {
      user,
      isLoading,
      error,
      reload,
      signOut: () => window.location.assign(LOGOUT_URL),
      hasRole: (...required: Role[]) => required.some((r) => roles.includes(r)),
      canAccessSite: (siteId: string) =>
        isAdmin || sites === null || sites.includes(siteId),
      isAdmin,
      isEngineer: roles.includes("engineer"),
    };
  }, [user, isLoading, error, reload]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}

/** Render children only when the user has at least one of `roles`. */
export function RequireRole({
  roles,
  fallback = null,
  children,
}: {
  roles: Role[];
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { hasRole, isLoading } = useAuth();
  if (isLoading) return null;
  return hasRole(...roles) ? <>{children}</> : <>{fallback}</>;
}

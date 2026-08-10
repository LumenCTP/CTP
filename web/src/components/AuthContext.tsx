import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface User {
  id: number;
  full_name: string;
  company_name: string;
  inbox_slug?: string | null;
  inbox_address?: string | null;
  email: string;
  role?: string | null;
  tenant_id?: number | null;
  tenant_name?: string | null;
  subscription_status?: string | null;
  payment_week_start_day?: string | null;
  wizard_status?: string | null;
  // Partner-specific fields (populated from /api/partner/me when role === "partner")
  partner_id?: number | null;
  partner_status?: string | null;
  referral_code?: string | null;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<string | null>;
  register: (full_name: string, company_name: string, email: string, password: string, referral_code?: string) => Promise<string | null>;
  logout: () => void;
  refreshUser: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "cleartopay_token";
const USER_KEY = "cleartopay_user";

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeAuth(token: string, user: User) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // localStorage unavailable
  }
}

function clearAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // localStorage unavailable
  }
}

// Merge the flat user object from the API with the nested tenant object
// returned by login/register (the /me endpoint already returns flat fields).
function mergeTenant(user: Record<string, unknown>, tenant: Record<string, unknown> | null | undefined): User {
  return {
    ...(user as User),
    tenant_id: (tenant?.id as number) ?? null,
    tenant_name: (tenant?.name as string) ?? null,
    subscription_status: (tenant?.subscription_status as string) ?? null,
    payment_week_start_day: (tenant?.payment_week_start_day as string) ?? "monday",
    wizard_status: (tenant?.wizard_status as string) ?? null,
  };
}

// True when the user must complete the setup wizard before using the app.
// Admins have no tenant/wizard record — they always skip the setup flow.
export function needsSetup(user: User | null): boolean {
  if (!user || user.role === "admin") return false;
  return user.wizard_status === "NOT_STARTED" || user.wizard_status === "IN_PROGRESS";
}

// True when the user is a partner whose application has not been approved yet
// (pending, rejected, or suspended). Approved partners can use the portal.
export function needsPartnerSetup(user: User | null): boolean {
  return !!user && user.role === "partner" && !!user.partner_status && user.partner_status !== "approved";
}

// Fetch partner-specific data from /api/partner/me and attach it to the user
// object. Non-approved partners still get their partner row back (status
// pending/rejected/suspended); only a user with no partner record 403s.
async function withPartnerData(token: string, user: User): Promise<User> {
  if (user.role !== "partner") return user;
  try {
    const res = await fetch("/api/partner/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { partner?: Record<string, unknown> };
      const p = data.partner || {};
      return {
        ...user,
        partner_id: (p.id as number) ?? null,
        partner_status: (p.status as string) ?? null,
        referral_code: (p.referral_code as string) ?? null,
      };
    }
    // No partner record (or error) — treat as not yet approved.
    return { ...user, partner_id: null, partner_status: "pending", referral_code: null };
  } catch {
    return { ...user, partner_status: user.partner_status ?? "pending" };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(getStoredUser);
  const [token, setToken] = useState<string | null>(getStoredToken);
  const [loading, setLoading] = useState(true);

  // Load the full session (base user + partner data when applicable).
  const loadSession = useCallback(async (storedToken: string): Promise<User | null> => {
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${storedToken}` },
    });
    if (!res.ok) throw new Error("Invalid token");
    const userData = (await res.json()) as User;
    return withPartnerData(storedToken, userData);
  }, []);

  // Verify token on mount
  useEffect(() => {
    const storedToken = getStoredToken();
    if (storedToken) {
      loadSession(storedToken)
        .then((userData) => {
          setUser(userData);
          setToken(storedToken);
          storeAuth(storedToken, userData);
        })
        .catch(() => {
          clearAuth();
          setUser(null);
          setToken(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [loadSession]);

  const login = useCallback(async (email: string, password: string): Promise<string | null> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      return data.error || "Login failed";
    }
    const merged = mergeTenant(data.user || {}, data.tenant);
    setToken(data.token);
    setUser(merged);
    storeAuth(data.token, merged);
    return null;
  }, []);

  const register = useCallback(async (
    full_name: string, company_name: string, email: string, password: string, referral_code?: string
  ): Promise<string | null> => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name,
        company_name,
        email,
        password,
        ...(referral_code ? { referral_code } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return data.error || "Registration failed";
    }
    const merged = mergeTenant(data.user || {}, data.tenant);
    setToken(data.token);
    setUser(merged);
    storeAuth(data.token, merged);
    return null;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    clearAuth();
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }, []);

  // Re-fetch /api/auth/me (plus partner data for partners) and update the
  // cached user (used after setup wizard completes and after partner login).
  const refreshUser = useCallback(async (): Promise<boolean> => {
    const storedToken = getStoredToken();
    if (!storedToken) return false;
    try {
      const userData = await loadSession(storedToken);
      setUser(userData);
      storeAuth(storedToken, userData);
      return true;
    } catch {
      return false;
    }
  }, [loadSession]);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

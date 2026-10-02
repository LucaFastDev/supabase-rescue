import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const LINKS = [
  { to: "/appointments", label: "Appointments" },
  { to: "/customers", label: "Customers" },
  { to: "/reports", label: "Reports" },
];

const StaffLayout = () => {
  const navigate = useNavigate();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const signOut = async () => {
    setSignOutError(null);
    const { error } = await supabase.auth.signOut();
    if (error) {
      setSignOutError(`Could not sign out: ${error.message}`);
      return;
    }
    navigate("/login");
  };

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Juniper &amp; Ash</span>
          <nav className="flex gap-4 text-sm">
            {LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  cn("text-muted-foreground hover:text-foreground", isActive && "text-foreground font-medium")
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <Button variant="outline" size="sm" className="ml-auto" onClick={signOut}>
            Sign out
          </Button>
        </div>
        {signOutError && (
          <p role="alert" className="mx-auto max-w-5xl px-4 pb-3 text-sm text-destructive">
            {signOutError}
          </p>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
};

export default StaffLayout;

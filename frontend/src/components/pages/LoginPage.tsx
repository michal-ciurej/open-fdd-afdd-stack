import { useAuth } from "@/contexts/auth-context";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Landing screen shown when no authenticated session exists. The user must
 * explicitly click "Sign on" to begin the SWA → Entra (CIAM) redirect, rather
 * than being bounced into the identity provider automatically.
 */
export function LoginPage() {
  const { signIn, error } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card tone="elevated" className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-6 p-8 text-center">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl font-semibold tracking-tight text-foreground">
              3mse Sherlock
            </span>
            <img
              src="/data/images/logosmall.png"
              alt="3mse Sherlock"
              className="w-6"
            />
          </div>

          <p className="text-sm text-muted-foreground">
            Sign in with your organisation account to continue.
          </p>

          <button
            type="button"
            onClick={signIn}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Sign on
          </button>

          {error ? (
            <p className="text-xs text-destructive">
              Sign-in could not be verified. Please try again.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

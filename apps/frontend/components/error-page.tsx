import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

/**
 * The shared shell for every error surface: 404, the segment error boundaries,
 * and the root `global-error`.
 *
 * Built on `Empty` rather than a new primitive, because "a centred icon, a
 * heading, an explanation, and one or two actions" is exactly what `Empty`
 * already is — an error page is an empty state with a status code.
 *
 * Deliberately presentational and hook-free, so the *same* component serves the
 * server-rendered `not-found.tsx` and the client-only `error.tsx` boundaries.
 * Anything that needs state (a retry callback, an error digest) is passed in.
 */
export function ErrorPage({
  code,
  title,
  description,
  icon,
  detail,
  actions,
  className,
}: {
  /** The HTTP-ish status shown above the heading, e.g. "404". */
  code: string;
  title: string;
  description: React.ReactNode;
  icon: React.ReactNode;
  /**
   * A short technical hint — typically Next.js's error digest — shown in a
   * monospace line under the description. In production a server error's real
   * message is withheld from the browser, so the digest is the only thing that
   * ties what the user saw to what the operator will find in the logs.
   */
  detail?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("min-h-[60vh] border-none", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {code}
        </p>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {(actions || detail) && (
        <EmptyContent>
          {actions && (
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              {actions}
            </div>
          )}
          {detail && (
            <p className="font-mono text-[11px] break-all text-muted-foreground">
              {detail}
            </p>
          )}
        </EmptyContent>
      )}
    </Empty>
  );
}

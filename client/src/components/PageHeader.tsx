import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  /** Page title (h1). */
  title: React.ReactNode;
  /** Optional supporting description under the title. */
  description?: React.ReactNode;
  /** Right-aligned action buttons. */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * PageHeader — the standard title + description + actions row used at the top
 * of every module page. Actions wrap below the title on small screens.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export default PageHeader;

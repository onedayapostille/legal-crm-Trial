import * as React from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SectionHeaderProps {
  /** Small uppercase section label. */
  label: React.ReactNode;
  /** Optional right-aligned navigation link. */
  actionLabel?: string;
  actionHref?: string;
  className?: string;
}

/**
 * SectionHeader — a small uppercase label used to group dashboard sections
 * (e.g. "Client Registry", "Financial Overview"), with an optional
 * "View all →" style navigation link on the right.
 */
export function SectionHeader({
  label,
  actionLabel,
  actionHref,
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between",
        className,
      )}
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h2>
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {actionLabel}
          <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

export default SectionHeader;

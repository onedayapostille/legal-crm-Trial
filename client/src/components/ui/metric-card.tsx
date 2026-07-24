import * as React from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Accent color for the metric card's left edge line. Maps to the semantic
 * design tokens so the palette stays centralized (see index.css).
 */
export type MetricAccent =
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "purple"
  | "slate";

const ACCENT_BAR: Record<MetricAccent, string> = {
  blue: "bg-primary",
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-danger",
  purple: "bg-[var(--accent-purple)]",
  slate: "bg-slate-400",
};

const ACCENT_ICON: Record<MetricAccent, string> = {
  blue: "text-primary",
  green: "text-success",
  amber: "text-warning",
  red: "text-danger",
  purple: "text-[var(--accent-purple)]",
  slate: "text-slate-500",
};

export interface MetricCardProps {
  /** Small uppercase label above the value. */
  label: string;
  /** Large primary value. */
  value: React.ReactNode;
  /** Optional supporting text below the value. */
  subtitle?: React.ReactNode;
  /** Accent color for the left edge line + icon. */
  accent?: MetricAccent;
  /** Optional icon rendered top-right. */
  icon?: React.ElementType;
  /** When set, the whole card becomes a navigation link. */
  href?: string;
  /** Shows a skeleton placeholder instead of content. */
  loading?: boolean;
  /** Extra content rendered under the subtitle (e.g. range toggles). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * MetricCard — the standard KPI tile used across the dashboard and reports.
 * A colored accent line on the left, an uppercase label, a large value, and
 * optional supporting text + icon. Consistent height keeps rows aligned.
 */
export function MetricCard({
  label,
  value,
  subtitle,
  accent = "blue",
  icon: Icon,
  href,
  loading,
  children,
  className,
}: MetricCardProps) {
  const card = (
    <Card
      className={cn(
        "relative h-full overflow-hidden p-5 pl-6 transition-shadow",
        href && "cursor-pointer hover:shadow-md",
        className,
      )}
    >
      {/* Colored accent line */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          ACCENT_BAR[accent],
        )}
      />
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-3 w-28" />
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <p className="mt-1.5 text-2xl font-bold leading-tight text-foreground sm:text-3xl">
              {value}
            </p>
            {subtitle && (
              <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
            )}
            {children}
          </div>
          {Icon && (
            <div className="shrink-0 rounded-lg bg-muted p-2">
              <Icon className={cn("h-5 w-5", ACCENT_ICON[accent])} />
            </div>
          )}
        </div>
      )}
    </Card>
  );

  if (href && !loading) {
    return (
      <Link href={href} className="block h-full">
        {card}
      </Link>
    );
  }
  return card;
}

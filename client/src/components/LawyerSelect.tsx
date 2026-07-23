import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, UserX } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import AddAttorneyDialog from "@/components/AddAttorneyDialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/permissions";
import type { AssignmentField } from "@shared/assignmentEligibility";

/**
 * Reusable searchable user dropdown for lawyer-assignment fields (Lead Partner,
 * Support Lead, Attorney Head, Attorney 1–4, Responsible Lawyer).
 *
 * Options come from `users.eligibleLawyers` — active users with a role eligible
 * for the given field, filtered server-side. Search matches full name AND
 * email. A current value pointing at a user who is no longer eligible (e.g.
 * deactivated) is kept visible as "(inactive)" via `fallbackLabel`, but
 * inactive users are never offered as new options.
 *
 * `allowCreate` renders a small `+` button beside the dropdown that opens the
 * shared Add New Attorney dialog (AddAttorneyDialog). The button is shown only
 * to users who may create users (users:manage — user creation itself is an
 * admin-only endpoint, enforced server-side). After a successful creation the
 * eligible-lawyers cache is invalidated and the new ACTIVE user is selected in
 * this field automatically; the surrounding form state is untouched.
 */
export default function LawyerSelect({
  field,
  value,
  onChange,
  fallbackLabel,
  excludeIds = [],
  allowNone = true,
  allowCreate = false,
  disabled = false,
  placeholder = "— select —",
  className,
}: {
  /** Which assignment field this selects for (drives role eligibility). */
  field: AssignmentField;
  /** Currently selected user id, or null. */
  value: number | null;
  /** Called with the new user id (null = None) and the picked user's name. */
  onChange: (id: number | null, name?: string) => void;
  /** Display name for a value not in the eligible list (legacy/inactive user). */
  fallbackLabel?: string;
  /** User ids to hide from the options (e.g. already picked as another attorney). */
  excludeIds?: number[];
  allowNone?: boolean;
  /** Offer a `+` create-attorney button (visible only with users:manage). */
  allowCreate?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const { user } = useAuth();
  const canCreateUsers = can(user?.role, "users.manage");
  const { data: lawyers, isLoading, error, refetch } = trpc.users.eligibleLawyers.useQuery({ field });

  const options = useMemo(
    () => (lawyers ?? []).filter(l => l.id === value || !excludeIds.includes(l.id)),
    [lawyers, value, excludeIds],
  );
  const selected = value != null ? (lawyers ?? []).find(l => l.id === value) : undefined;
  // Value set but not in the eligible list → historical assignment to a user
  // who is inactive or no longer role-eligible.
  const selectedIsInactive = value != null && lawyers !== undefined && !selected;

  const triggerLabel =
    value == null
      ? placeholder
      : selected?.fullName ?? (fallbackLabel ? `${fallbackLabel} (inactive)` : `User #${value} (inactive)`);

  const showCreate = allowCreate && canCreateUsers;

  return (
    <div className={cn("flex items-center gap-1", className)}>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-8 w-full justify-between text-sm font-normal px-3 min-w-0 flex-1",
            value == null && "text-muted-foreground",
          )}
        >
          <span className="truncate flex items-center gap-1">
            {selectedIsInactive && <UserX className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
            {triggerLabel}
          </span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name or email…" className="h-9" />
          <CommandList>
            {isLoading && (
              <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
              </div>
            )}
            {error && (
              <div className="py-4 px-3 text-center text-sm">
                <p className="text-destructive mb-2">Could not load users.</p>
                <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
                  Retry
                </Button>
              </div>
            )}
            {!isLoading && !error && (
              <>
                <CommandEmpty>No eligible user found.</CommandEmpty>
                <CommandGroup>
                  {allowNone && (
                    <CommandItem
                      value="__none__"
                      onSelect={() => { onChange(null); setOpen(false); }}
                    >
                      <Check className={cn("mr-2 h-4 w-4", value == null ? "opacity-100" : "opacity-0")} />
                      <span className="text-muted-foreground">— None —</span>
                    </CommandItem>
                  )}
                  {/* Historical value no longer eligible: visible, not re-selectable. */}
                  {selectedIsInactive && (
                    <CommandItem value={`__inactive_${value}__`} disabled>
                      <Check className="mr-2 h-4 w-4 opacity-100" />
                      <span className="flex items-center gap-1">
                        <UserX className="h-3.5 w-3.5 text-amber-600" />
                        {fallbackLabel || `User #${value}`} (inactive)
                      </span>
                    </CommandItem>
                  )}
                  {options.map(l => (
                    <CommandItem
                      // cmdk filters on this string → search by name AND email.
                      value={`${l.fullName ?? ""} ${l.email} #${l.id}`}
                      key={l.id}
                      onSelect={() => {
                        onChange(l.id, l.fullName ?? undefined);
                        setOpen(false);
                      }}
                    >
                      <Check className={cn("mr-2 h-4 w-4", value === l.id ? "opacity-100" : "opacity-0")} />
                      <span className="flex flex-col">
                        <span>{l.fullName ?? `User #${l.id}`}</span>
                        <span className="text-xs text-muted-foreground">
                          {l.email}
                          <span className="capitalize"> · {l.role}</span>
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
    {showCreate && (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              disabled={disabled}
              onClick={() => setCreateOpen(true)}
              aria-label="Add new attorney"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add new attorney</TooltipContent>
        </Tooltip>
        <AddAttorneyDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          field={field}
          onCreated={(u) => {
            // Auto-select only ACTIVE users — inactive users are not assignable
            // (also enforced server-side on matter save).
            if (u.status === "active") onChange(u.id, u.name ?? undefined);
          }}
        />
      </>
    )}
    </div>
  );
}

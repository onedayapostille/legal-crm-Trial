import { useState } from "react";
import { useLocation } from "wouter";
import { Bell, CheckCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * In-app notification bell. Polls the unread count, lists recent notifications,
 * and supports mark-as-read. Used in the dashboard top bar.
 */
export default function NotificationBell() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  // Light polling so newly-assigned lawyers see alerts without a manual refresh.
  const { data: unread = 0 } = trpc.notifications.unreadCount.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const { data: items = [] } = trpc.notifications.list.useQuery({ limit: 20 }, { enabled: open });

  const invalidate = () => {
    utils.notifications.unreadCount.invalidate();
    utils.notifications.list.invalidate();
  };
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: invalidate });
  const markAllRead = trpc.notifications.markAllRead.useMutation({ onSuccess: invalidate });

  function openItem(n: any) {
    if (!n.isRead) markRead.mutate({ id: n.id });
    setOpen(false);
    if (n.entityType === "lead" && n.entityId) navigate(`/enquiries/${n.entityId}`);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <Badge className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full text-[10px] flex items-center justify-center bg-red-600 text-white">
              {unread > 9 ? "9+" : unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-semibold">Notifications</span>
          {items.some((n: any) => !n.isRead) && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => markAllRead.mutate()}>
              <CheckCheck className="h-3.5 w-3.5 mr-1" /> Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No notifications.</p>
          ) : (
            items.map((n: any) => (
              <button
                key={n.id}
                onClick={() => openItem(n)}
                className={`w-full text-left px-3 py-2.5 border-b hover:bg-accent/50 ${n.isRead ? "opacity-60" : ""}`}
              >
                <div className="flex items-start gap-2">
                  {!n.isRead && <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.body && <p className="text-xs text-muted-foreground">{n.body}</p>}
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

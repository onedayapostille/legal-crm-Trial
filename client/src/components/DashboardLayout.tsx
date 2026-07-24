import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/useMobile";
import {
  LogOut, PanelLeft, Users, FileText, BarChart3,
  DollarSign, UserCog, Briefcase, CheckSquare, Home,
  Building2, UserCheck, UserX, Calendar, Upload, Sparkles,
  PieChart,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import NotificationBell from './NotificationBell';
import { ROUTE_CAPABILITIES, userCan } from "@/lib/permissions";

// Each item's capability is derived from the single ROUTE_CAPABILITIES source of
// truth (shared with ProtectedRoute), so a sidebar entry can never disagree with
// the route gate or the server capability name.
const menuItems = [
  { icon: Home,          label: "Dashboard",         path: "/dashboard",         capability: ROUTE_CAPABILITIES["/dashboard"] },
  // ── Clients Module ──
  { icon: Building2,     label: "All Clients",        path: "/clients",           capability: ROUTE_CAPABILITIES["/clients"] },
  { icon: UserCheck,     label: "Existing Clients",   path: "/clients/existing",  capability: ROUTE_CAPABILITIES["/clients/existing"] },
  { icon: Users,         label: "Leads Pipeline",     path: "/clients/leads",     capability: ROUTE_CAPABILITIES["/clients/leads"] },
  { icon: FileText,      label: "Enquiries Log",      path: "/enquiries/log",     capability: ROUTE_CAPABILITIES["/enquiries/log"] },
  { icon: UserX,         label: "Rejected Clients",   path: "/clients/rejected",  capability: ROUTE_CAPABILITIES["/clients/rejected"] },
  { icon: Calendar,      label: "Action Log",         path: "/client-actions",    capability: ROUTE_CAPABILITIES["/client-actions"] },
  { icon: DollarSign,    label: "Financial Records",  path: "/financial",         capability: ROUTE_CAPABILITIES["/financial"] },
  { icon: PieChart,      label: "Financial Reports",  path: "/financial-reports", capability: ROUTE_CAPABILITIES["/financial-reports"] },
  { icon: Upload,        label: "Import Clients",     path: "/import",            capability: ROUTE_CAPABILITIES["/import"] },
  // ── Legacy / Other ──
  { icon: Briefcase,     label: "Matters",            path: "/matters",           capability: ROUTE_CAPABILITIES["/matters"] },
  { icon: CheckSquare,   label: "Tasks",              path: "/tasks",             capability: ROUTE_CAPABILITIES["/tasks"] },
  { icon: BarChart3,     label: "Status Tracker",     path: "/status-tracker",    capability: ROUTE_CAPABILITIES["/status-tracker"] },
  { icon: Sparkles,      label: "AI Assistant",       path: "/ai-assistant",      capability: ROUTE_CAPABILITIES["/ai-assistant"] },
  { icon: UserCog,       label: "User Management",   path: "/user-management",   capability: ROUTE_CAPABILITIES["/user-management"] },
];

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  // Always render dashboard - auth is handled by backend
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const visibleMenuItems = menuItems.filter(item => userCan(user, item.capability));
  const activeMenuItem = visibleMenuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r-0"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 justify-center border-b border-sidebar-border/60">
            <div className="flex items-center gap-3 px-1.5 transition-all w-full">
              {/* G&P brand identity */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground text-[11px] font-bold tracking-tight shadow-sm">
                G&amp;P
              </div>
              {!isCollapsed ? (
                <div className="flex flex-1 items-center justify-between min-w-0">
                  <div className="min-w-0 leading-tight">
                    <p className="text-sm font-semibold tracking-tight text-sidebar-accent-foreground truncate">
                      Legal CRM
                    </p>
                    <p className="text-[11px] text-sidebar-foreground/70 truncate">
                      Practice Management
                    </p>
                  </div>
                  <button
                    onClick={toggleSidebar}
                    className="h-7 w-7 flex items-center justify-center hover:bg-sidebar-accent rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring shrink-0 text-sidebar-foreground/70"
                    aria-label="Collapse navigation"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0">
            {!isCollapsed && (
              <p className="px-4 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/50">
                Navigation
              </p>
            )}
            <SidebarMenu className="px-2 py-1">
              {visibleMenuItems.map(item => {
                const isActive = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className="relative h-10 font-normal transition-all data-[active=true]:font-medium"
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-sidebar-primary group-data-[collapsible=icon]:hidden" />
                      )}
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarContent>

          <SidebarFooter className="p-3 border-t border-sidebar-border/60">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1.5 py-1.5 hover:bg-sidebar-accent transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                  <Avatar className="h-9 w-9 border border-sidebar-border shrink-0">
                    <AvatarFallback className="text-xs font-medium bg-sidebar-accent text-sidebar-accent-foreground">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none text-sidebar-accent-foreground">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-sidebar-foreground/70 truncate mt-1.5">
                      {user?.email || "-"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {/* Top bar — always shows the notification bell; mobile shows the menu trigger. */}
        <div className="flex border-b h-14 items-center justify-between bg-card/95 px-3 sm:px-4 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
          <div className="flex items-center gap-2 min-w-0">
            {isMobile && <SidebarTrigger className="h-9 w-9 rounded-lg" aria-label="Open navigation" />}
            {isMobile ? (
              <span className="tracking-tight font-medium text-foreground truncate">
                {activeMenuItem?.label ?? "Menu"}
              </span>
            ) : (
              <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm min-w-0">
                <span className="font-medium text-foreground truncate">AlGhazzawi &amp; Partners</span>
                {activeMenuItem && (
                  <>
                    <span className="text-muted-foreground/50">/</span>
                    <span className="text-muted-foreground truncate">{activeMenuItem.label}</span>
                  </>
                )}
              </nav>
            )}
          </div>
          <NotificationBell />
        </div>
        <main className="flex-1 p-4 sm:p-6">
          <div className="mx-auto w-full max-w-[1400px]">{children}</div>
        </main>
      </SidebarInset>
    </>
  );
}

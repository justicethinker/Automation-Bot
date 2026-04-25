import React from "react";
import { Link, useLocation, useParams } from "wouter";
import { 
  LayoutDashboard, Store, Smartphone, Settings,
  MenuSquare, ShoppingCart, MessageSquare, Users, CreditCard, BarChart, ChevronLeft,
  Tag, Megaphone
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetVendor } from "@workspace/api-client-react";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const params = useParams<{ vendorId?: string }>();
  const isVendorRoute = location.startsWith("/vendors/") && location !== "/vendors/new" && params.vendorId;

  const { data: vendor } = useGetVendor(params.vendorId || "", {
    query: { enabled: !!isVendorRoute }
  });

  const mainNavItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/vendors", label: "Vendors", icon: Store },
    { href: "/simulator", label: "Simulator", icon: Smartphone },
  ];

  const vendorNavItems = [
    { href: `/vendors/${params.vendorId}`, label: "Overview", icon: LayoutDashboard, exact: true },
    { href: `/vendors/${params.vendorId}/menu`, label: "Menu", icon: MenuSquare },
    { href: `/vendors/${params.vendorId}/orders`, label: "Orders", icon: ShoppingCart },
    { href: `/vendors/${params.vendorId}/conversations`, label: "Conversations", icon: MessageSquare },
    { href: `/vendors/${params.vendorId}/customers`, label: "Customers", icon: Users },
    { href: `/vendors/${params.vendorId}/payments`, label: "Payments", icon: CreditCard },
    { href: `/vendors/${params.vendorId}/analytics`, label: "Analytics", icon: BarChart },
    { href: `/vendors/${params.vendorId}/promotions`, label: "Promotions", icon: Tag },
    { href: `/vendors/${params.vendorId}/broadcasts`, label: "Broadcasts", icon: Megaphone },
    { href: `/vendors/${params.vendorId}/settings`, label: "Settings", icon: Settings },
  ];

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground selection:bg-primary/30">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex-shrink-0 flex flex-col shadow-sm z-10 relative">
        <div className="p-5 border-b border-border flex items-center gap-3">
          <div className="bg-primary/10 p-2 rounded-lg text-primary">
            <Settings className="w-5 h-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-sidebar-foreground">Control Panel</h1>
        </div>

        {isVendorRoute ? (
          <div className="flex-1 overflow-y-auto flex flex-col">
            <div className="p-4 border-b border-border bg-sidebar-accent/50">
              <Link href="/vendors" className="text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3 transition-colors">
                <ChevronLeft className="w-3 h-3" /> Back to Vendors
              </Link>
              {vendor ? (
                <div>
                  <h2 className="font-semibold text-base truncate" title={vendor.name}>{vendor.name}</h2>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={cn(
                      "text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-sm",
                      vendor.plan === "pro" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" : "bg-primary/10 text-primary"
                    )}>
                      {vendor.plan}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">{vendor.phoneNumber}</span>
                  </div>
                </div>
              ) : (
                <div className="animate-pulse space-y-2">
                  <div className="h-5 bg-muted rounded w-3/4"></div>
                  <div className="h-4 bg-muted rounded w-1/2"></div>
                </div>
              )}
            </div>
            <nav className="p-3 space-y-1">
              {vendorNavItems.map((item) => {
                const isActive = item.exact 
                  ? location === item.href 
                  : location.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-all duration-200",
                      isActive
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <item.icon className={cn("h-4 w-4", isActive ? "opacity-100" : "opacity-70")} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        ) : (
          <nav className="flex-1 overflow-y-auto p-4 space-y-1">
            <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Main Menu
            </div>
            {mainNavItems.map((item) => {
              const isActive = item.href === "/" 
                ? location === item.href 
                : location.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-all duration-200",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <item.icon className={cn("h-4 w-4", isActive ? "opacity-100" : "opacity-70")} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <div className="flex-1 overflow-y-auto bg-muted/20">
          <div className="mx-auto max-w-6xl p-6 lg:p-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

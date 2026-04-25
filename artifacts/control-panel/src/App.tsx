import { Switch, Route, Router as WouterRouter, useParams } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout";

import Dashboard from "@/pages/dashboard";
import VendorsList from "@/pages/vendors/index";
import NewVendor from "@/pages/vendors/new";
import VendorOverview from "@/pages/vendors/overview";
import VendorMenu from "@/pages/vendors/menu";
import VendorOrders from "@/pages/vendors/orders";
import VendorConversations from "@/pages/vendors/conversations";
import VendorCustomers from "@/pages/vendors/customers";
import VendorPayments from "@/pages/vendors/payments";
import VendorAnalytics from "@/pages/vendors/analytics";
import VendorPromotions from "@/pages/vendors/promotions";
import VendorBroadcasts from "@/pages/vendors/broadcasts";
import VendorSettings from "@/pages/vendors/settings";
import Simulator from "@/pages/simulator";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000 } },
});

function VendorPage({ children }: { children: (vendorId: string) => React.ReactNode }) {
  const params = useParams<{ vendorId: string }>();
  return <AppLayout>{children(params.vendorId!)}</AppLayout>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <AppLayout><Dashboard /></AppLayout>} />
      <Route path="/vendors" component={() => <AppLayout><VendorsList /></AppLayout>} />
      <Route path="/vendors/new" component={() => <AppLayout><NewVendor /></AppLayout>} />
      <Route path="/vendors/:vendorId" component={() => <VendorPage>{(id) => <VendorOverview vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/menu" component={() => <VendorPage>{(id) => <VendorMenu vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/orders" component={() => <VendorPage>{(id) => <VendorOrders vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/conversations" component={() => <VendorPage>{(id) => <VendorConversations vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/customers" component={() => <VendorPage>{(id) => <VendorCustomers vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/payments" component={() => <VendorPage>{(id) => <VendorPayments vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/analytics" component={() => <VendorPage>{(id) => <VendorAnalytics vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/promotions" component={() => <VendorPage>{(id) => <VendorPromotions vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/broadcasts" component={() => <VendorPage>{(id) => <VendorBroadcasts vendorId={id} />}</VendorPage>} />
      <Route path="/vendors/:vendorId/settings" component={() => <VendorPage>{(id) => <VendorSettings vendorId={id} />}</VendorPage>} />
      <Route path="/simulator" component={() => <AppLayout><Simulator /></AppLayout>} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

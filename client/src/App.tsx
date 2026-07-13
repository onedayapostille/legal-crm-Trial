import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import ProtectedRoute from "./components/ProtectedRoute";
import ScrollRestoration from "./components/ScrollRestoration";
import { ThemeProvider } from "./contexts/ThemeContext";

// Pages
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import EnquiryForm from "@/pages/EnquiryForm";
import EnquiriesLog from "@/pages/EnquiriesLog";
import StatusTracker from "@/pages/StatusTracker";
import PaymentTracker from "@/pages/PaymentTracker";
import AIAssistant from "@/pages/AIAssistant";
import UserManagement from "@/pages/UserManagement";
import MatterList from "@/pages/MatterList";
import MatterNew from "@/pages/MatterNew";
import TaskList from "@/pages/TaskList";
import TaskForm from "@/pages/TaskForm";
import DashboardLayout from "./components/DashboardLayout";
// AlGhazzawi Clients Module
import ClientList from "@/pages/ClientList";
import ClientForm from "@/pages/ClientForm";
import ClientDetail from "@/pages/ClientDetail";
import ClientsExisting from "@/pages/ClientsExisting";
import ClientsLeads from "@/pages/ClientsLeads";
import ClientsRejected from "@/pages/ClientsRejected";
import FinancialRecords from "@/pages/FinancialRecords";
import FinancialReports from "@/pages/FinancialReports";
import ClientActionLog from "@/pages/ClientActionLog";
import ImportPage from "@/pages/ImportPage";

function Router() {
  return (
    <>
      <ScrollRestoration />
      <Switch>
      {/* Public routes */}
      <Route path="/login" component={Login} />

      {/* Root → redirect to dashboard */}
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>

      {/* Protected routes */}
      <Route path="/dashboard">
        <ProtectedRoute><Dashboard /></ProtectedRoute>
      </Route>

      {/* Unified intake: the Enquiry Log / Leads list is consolidated into the
          clients-module Leads Pipeline. The list routes redirect (preserving
          bookmarks); the create/edit enquiry forms still work. */}
      <Route path="/leads">
        <Redirect to="/clients/leads" />
      </Route>
      <Route path="/leads/new">
        <ProtectedRoute>
          <DashboardLayout><EnquiryForm /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      {/* Explicit edit alias (kept alongside /leads/:id for deep-link compat). */}
      <Route path="/leads/:id/edit">
        {(params) => (
          <ProtectedRoute>
            <DashboardLayout><EnquiryForm id={parseInt(params.id)} /></DashboardLayout>
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/leads/:id">
        {(params) => (
          <ProtectedRoute>
            <DashboardLayout><EnquiryForm id={parseInt(params.id)} /></DashboardLayout>
          </ProtectedRoute>
        )}
      </Route>

      {/* Enquiries (legacy bookmarks preserved via redirect) */}
      <Route path="/enquiries">
        <Redirect to="/clients/leads" />
      </Route>
      {/* Filterable enquiries list for channel/marketing-source reporting */}
      <Route path="/enquiries/log">
        <ProtectedRoute permission="leads:manage"><EnquiriesLog /></ProtectedRoute>
      </Route>
      <Route path="/enquiries/new">
        <ProtectedRoute>
          <DashboardLayout><EnquiryForm /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      {/* Canonical edit path for an enquiry (was previously missing, causing a
          404 on /enquiries/:id/edit deep links). */}
      <Route path="/enquiries/:id/edit">
        {(params) => (
          <ProtectedRoute>
            <DashboardLayout><EnquiryForm id={parseInt(params.id)} /></DashboardLayout>
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/enquiries/:id">
        {(params) => (
          <ProtectedRoute>
            <DashboardLayout><EnquiryForm id={parseInt(params.id)} /></DashboardLayout>
          </ProtectedRoute>
        )}
      </Route>

      {/* Matters */}
      <Route path="/matters/new">
        <ProtectedRoute permission="clients:manage"><MatterNew /></ProtectedRoute>
      </Route>
      <Route path="/matters">
        <ProtectedRoute><MatterList /></ProtectedRoute>
      </Route>

      {/* Tasks */}
      <Route path="/tasks/new">
        <ProtectedRoute><TaskForm /></ProtectedRoute>
      </Route>
      <Route path="/tasks">
        <ProtectedRoute><TaskList /></ProtectedRoute>
      </Route>

      {/* Analytics */}
      <Route path="/status-tracker">
        <ProtectedRoute>
          <DashboardLayout><StatusTracker /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/payment-tracker">
        <ProtectedRoute>
          <DashboardLayout><PaymentTracker /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/ai-assistant">
        <ProtectedRoute permission="ai:assistant"><AIAssistant /></ProtectedRoute>
      </Route>

      {/* Admin */}
      <Route path="/user-management">
        <ProtectedRoute permission="users:manage">
          <DashboardLayout><UserManagement /></DashboardLayout>
        </ProtectedRoute>
      </Route>

      {/* ── AlGhazzawi Clients Module ── */}
      <Route path="/clients">
        <ProtectedRoute permission="clients:view">
          <ClientList />
        </ProtectedRoute>
      </Route>
      <Route path="/clients/new">
        <ProtectedRoute permission="clients:manage">
          <ClientForm />
        </ProtectedRoute>
      </Route>
      <Route path="/clients/existing">
        <ProtectedRoute permission="clients:view">
          <ClientsExisting />
        </ProtectedRoute>
      </Route>
      <Route path="/clients/leads">
        <ProtectedRoute permission="clients:view">
          <ClientsLeads />
        </ProtectedRoute>
      </Route>
      <Route path="/clients/rejected">
        <ProtectedRoute permission="clients:view">
          <ClientsRejected />
        </ProtectedRoute>
      </Route>
      <Route path="/clients/:id">
        {(params) => (
          <ProtectedRoute permission="clients:view">
            <ClientDetail id={parseInt(params.id)} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/financial">
        <ProtectedRoute permission="financial:view">
          <FinancialRecords />
        </ProtectedRoute>
      </Route>
      <Route path="/financial-reports">
        <ProtectedRoute permission="financial:view">
          <FinancialReports />
        </ProtectedRoute>
      </Route>
      <Route path="/client-actions">
        <ProtectedRoute permission="actions:manage">
          <ClientActionLog />
        </ProtectedRoute>
      </Route>
      <Route path="/import">
        <ProtectedRoute permission="clients:manage">
          <ImportPage />
        </ProtectedRoute>
      </Route>

      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
      </Switch>
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;

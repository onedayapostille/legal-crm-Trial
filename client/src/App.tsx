import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import ProtectedRoute from "./components/ProtectedRoute";
import { ThemeProvider } from "./contexts/ThemeContext";

// Pages
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import EnquiryList from "@/pages/EnquiryList";
import EnquiryForm from "@/pages/EnquiryForm";
import StatusTracker from "@/pages/StatusTracker";
import KPIDashboard from "@/pages/KPIDashboard";
import PaymentTracker from "@/pages/PaymentTracker";
import PipelineForecast from "@/pages/PipelineForecast";
import UserManagement from "@/pages/UserManagement";
import MatterList from "@/pages/MatterList";
import TaskList from "@/pages/TaskList";
import TaskForm from "@/pages/TaskForm";
import DashboardLayout from "./components/DashboardLayout";

function Router() {
  return (
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

      {/* Leads — also aliased as /leads from the old /enquiries */}
      <Route path="/leads">
        <ProtectedRoute>
          <DashboardLayout><EnquiryList /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/leads/new">
        <ProtectedRoute>
          <DashboardLayout><EnquiryForm /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/leads/:id">
        {(params) => (
          <ProtectedRoute>
            <DashboardLayout><EnquiryForm id={parseInt(params.id)} /></DashboardLayout>
          </ProtectedRoute>
        )}
      </Route>

      {/* Enquiries (legacy URLs still work) */}
      <Route path="/enquiries">
        <ProtectedRoute>
          <DashboardLayout><EnquiryList /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/enquiries/new">
        <ProtectedRoute>
          <DashboardLayout><EnquiryForm /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/enquiries/:id">
        {(params) => (
          <ProtectedRoute>
            <DashboardLayout><EnquiryForm id={parseInt(params.id)} /></DashboardLayout>
          </ProtectedRoute>
        )}
      </Route>

      {/* Matters */}
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
      <Route path="/kpi-dashboard">
        <ProtectedRoute>
          <DashboardLayout><KPIDashboard /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/payment-tracker">
        <ProtectedRoute>
          <DashboardLayout><PaymentTracker /></DashboardLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/pipeline-forecast">
        <ProtectedRoute>
          <DashboardLayout><PipelineForecast /></DashboardLayout>
        </ProtectedRoute>
      </Route>

      {/* Admin */}
      <Route path="/user-management">
        <ProtectedRoute permission="users:manage">
          <DashboardLayout><UserManagement /></DashboardLayout>
        </ProtectedRoute>
      </Route>

      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
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

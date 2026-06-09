import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Plus, Eye, Loader2, Download, Trash2, Filter, X } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import * as XLSX from "xlsx";

const statusColors: Record<string, string> = {
  "Pending": "bg-gray-100 text-gray-800",
  "Contacted": "bg-blue-100 text-blue-800",
  "Meeting Scheduled": "bg-purple-100 text-purple-800",
  "Proposal Sent": "bg-yellow-100 text-yellow-800",
  "Converted": "bg-green-100 text-green-800",
  "Declined": "bg-red-100 text-red-800",
  "Conflict": "bg-orange-100 text-orange-800",
  "Not Pursued": "bg-gray-100 text-gray-800",
};

const urgencyColors: Record<string, string> = {
  "Low": "bg-gray-100 text-gray-800",
  "Medium": "bg-blue-100 text-blue-800",
  "High": "bg-orange-100 text-orange-800",
  "Critical": "bg-red-100 text-red-800",
};

const statusOptions = [
  "Pending",
  "Contacted",
  "Meeting Scheduled",
  "Proposal Sent",
  "Converted",
  "Declined",
  "Conflict",
  "Not Pursued",
];

const urgencyOptions = ["Low", "Medium", "High", "Critical"];

export default function EnquiryList() {
  const { data: enquiries, isLoading, refetch } = trpc.leads.list.useQuery();
  const deleteEnquiryMutation = trpc.leads.delete.useMutation({
    onSuccess: () => {
      toast.success("Enquiry deleted successfully");
      refetch();
      setSelectedIds([]);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete enquiry");
    },
  });

  // Filter states
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [urgencyFilter, setUrgencyFilter] = useState<string>("all");
  const [serviceFilter, setServiceFilter] = useState<string>("all");
  const [dateFromFilter, setDateFromFilter] = useState<string>("");
  const [dateToFilter, setDateToFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showFilters, setShowFilters] = useState<boolean>(false);

  // Bulk selection states
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [showDeleteDialog, setShowDeleteDialog] = useState<boolean>(false);

  // Get unique services for filter
  const uniqueServices = useMemo(() => {
    if (!enquiries) return [];
    const services = enquiries
      .map(e => e.serviceRequested)
      .filter((s): s is string => Boolean(s));
    return Array.from(new Set(services));
  }, [enquiries]);

  // Apply filters
  const filteredEnquiries = useMemo(() => {
    if (!enquiries) return [];

    return enquiries.filter(enquiry => {
      // Status filter
      if (statusFilter !== "all" && enquiry.currentStatus !== statusFilter) {
        return false;
      }

      // Urgency filter
      if (urgencyFilter !== "all" && enquiry.urgencyLevel !== urgencyFilter) {
        return false;
      }

      // Service filter
      if (serviceFilter !== "all" && enquiry.serviceRequested !== serviceFilter) {
        return false;
      }

      // Date range filter
      if (dateFromFilter && enquiry.dateOfEnquiry) {
        const enquiryDate = new Date(enquiry.dateOfEnquiry);
        const fromDate = new Date(dateFromFilter);
        if (enquiryDate < fromDate) return false;
      }

      if (dateToFilter && enquiry.dateOfEnquiry) {
        const enquiryDate = new Date(enquiry.dateOfEnquiry);
        const toDate = new Date(dateToFilter);
        if (enquiryDate > toDate) return false;
      }

      // Search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          enquiry.clientName?.toLowerCase().includes(query) ||
          enquiry.leadCode?.toLowerCase().includes(query) ||
          enquiry.email?.toLowerCase().includes(query) ||
          enquiry.phoneNumber?.toLowerCase().includes(query)
        );
      }

      return true;
    });
  }, [enquiries, statusFilter, urgencyFilter, serviceFilter, dateFromFilter, dateToFilter, searchQuery]);

  // Handle select all
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(filteredEnquiries.map(e => e.id));
    } else {
      setSelectedIds([]);
    }
  };

  // Handle individual selection
  const handleSelectOne = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedIds([...selectedIds, id]);
    } else {
      setSelectedIds(selectedIds.filter(selectedId => selectedId !== id));
    }
  };

  // Handle bulk delete
  const handleBulkDelete = async () => {
    for (const id of selectedIds) {
      await deleteEnquiryMutation.mutateAsync({ id });
    }
    setShowDeleteDialog(false);
  };

  // Export to Excel
  const handleExport = () => {
    if (!filteredEnquiries || filteredEnquiries.length === 0) {
      toast.error("No data to export");
      return;
    }

    const exportData = filteredEnquiries.map(e => ({
      "Enquiry ID": e.leadCode,
      "Date": e.dateOfEnquiry,
      "Client Name": e.clientName,
      "Email": e.email || "",
      "Phone": e.phoneNumber || "",
      "Service": e.serviceRequested || "",
      "Status": e.currentStatus || "",
      "Urgency": e.urgencyLevel || "",
      "Assigned Lawyer": e.suggestedLeadLawyer || "",
      "Proposal Value": e.proposalValue || "",
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Enquiries");
    
    const fileName = `enquiries_export_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);
    
    toast.success(`Exported ${filteredEnquiries.length} enquiries to ${fileName}`);
  };

  // Clear all filters
  const clearFilters = () => {
    setStatusFilter("all");
    setUrgencyFilter("all");
    setServiceFilter("all");
    setDateFromFilter("");
    setDateToFilter("");
    setSearchQuery("");
  };

  const hasActiveFilters = statusFilter !== "all" || urgencyFilter !== "all" || 
    serviceFilter !== "all" || dateFromFilter || dateToFilter || searchQuery;

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </DashboardLayout>
    );
  }

  const allSelected = filteredEnquiries.length > 0 && selectedIds.length === filteredEnquiries.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < filteredEnquiries.length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Enquiry Log</h1>
            <p className="text-gray-600 mt-1">Manage all client enquiries from initial contact to conversion</p>
          </div>
          <Link href="/enquiries/new">
            <Button size="lg">
              <Plus className="h-5 w-5 mr-2" />
              New Enquiry
            </Button>
          </Link>
        </div>

        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>All Enquiries</CardTitle>
                <CardDescription>
                  {filteredEnquiries.length} of {enquiries?.length || 0} enquiries
                  {selectedIds.length > 0 && ` (${selectedIds.length} selected)`}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <Filter className="h-4 w-4 mr-2" />
                  Filters
                  {hasActiveFilters && (
                    <Badge variant="secondary" className="ml-2">
                      Active
                    </Badge>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExport}
                  disabled={filteredEnquiries.length === 0}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
                {selectedIds.length > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setShowDeleteDialog(true)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete ({selectedIds.length})
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>

          {/* Filters Panel */}
          {showFilters && (
            <div className="border-t border-b bg-muted/50 p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="search">Search</Label>
                  <Input
                    id="search"
                    placeholder="Client name, ID, email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="status-filter">Status</Label>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger id="status-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      {statusOptions.map(status => (
                        <SelectItem key={status} value={status}>{status}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="urgency-filter">Urgency</Label>
                  <Select value={urgencyFilter} onValueChange={setUrgencyFilter}>
                    <SelectTrigger id="urgency-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Urgencies</SelectItem>
                      {urgencyOptions.map(urgency => (
                        <SelectItem key={urgency} value={urgency}>{urgency}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="service-filter">Service</Label>
                  <Select value={serviceFilter} onValueChange={setServiceFilter}>
                    <SelectTrigger id="service-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Services</SelectItem>
                      {uniqueServices.map(service => (
                        <SelectItem key={service} value={service}>{service}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="date-from">Date From</Label>
                  <Input
                    id="date-from"
                    type="date"
                    value={dateFromFilter}
                    onChange={(e) => setDateFromFilter(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="date-to">Date To</Label>
                  <Input
                    id="date-to"
                    type="date"
                    value={dateToFilter}
                    onChange={(e) => setDateToFilter(e.target.value)}
                  />
                </div>
              </div>

              {hasActiveFilters && (
                <div className="mt-4 flex justify-end">
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    <X className="h-4 w-4 mr-2" />
                    Clear Filters
                  </Button>
                </div>
              )}
            </div>
          )}

          <CardContent>
            {!filteredEnquiries || filteredEnquiries.length === 0 ? (
              <div className="text-center py-12">
                {hasActiveFilters ? (
                  <>
                    <p className="text-gray-500 mb-4">No enquiries match your filters.</p>
                    <Button variant="outline" onClick={clearFilters}>
                      <X className="h-4 w-4 mr-2" />
                      Clear Filters
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-gray-500 mb-4">No enquiries yet. Create your first enquiry to get started.</p>
                    <Link href="/enquiries/new">
                      <Button>
                        <Plus className="h-4 w-4 mr-2" />
                        Create Enquiry
                      </Button>
                    </Link>
                  </>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={handleSelectAll}
                          aria-label="Select all"
                        />
                      </TableHead>
                      <TableHead>Enquiry ID</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Client Name</TableHead>
                      <TableHead>Service</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Urgency</TableHead>
                      <TableHead>Assigned Lawyer</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEnquiries.map((enquiry) => (
                      <TableRow key={enquiry.id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.includes(enquiry.id)}
                            onCheckedChange={(checked) => handleSelectOne(enquiry.id, checked as boolean)}
                            aria-label={`Select ${enquiry.leadCode}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{enquiry.leadCode}</TableCell>
                        <TableCell>
                          {(enquiry as any).enquiryAt
                            ? new Date((enquiry as any).enquiryAt).toLocaleString()
                            : new Date(enquiry.dateOfEnquiry).toLocaleDateString()}
                        </TableCell>
                        <TableCell>{enquiry.clientName}</TableCell>
                        <TableCell>{enquiry.serviceRequested || "N/A"}</TableCell>
                        <TableCell>
                          <Badge className={statusColors[enquiry.currentStatus || ""] || "bg-gray-100"}>
                            {enquiry.currentStatus || "N/A"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={urgencyColors[enquiry.urgencyLevel || ""] || "bg-gray-100"}>
                            {enquiry.urgencyLevel || "N/A"}
                          </Badge>
                        </TableCell>
                        <TableCell>{enquiry.suggestedLeadLawyer || "Unassigned"}</TableCell>
                        <TableCell>
                          <Link href={`/enquiries/${enquiry.id}`}>
                            <Button variant="ghost" size="sm">
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {selectedIds.length} enquir{selectedIds.length === 1 ? 'y' : 'ies'}.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}

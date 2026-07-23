import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, DollarSign, CheckCircle, Clock, AlertCircle } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission } from "@shared/const";

export default function PaymentTracker() {
  const { user } = useAuth();
  // payments:view is read-only (e.g. Manager); recording/editing needs payments:manage.
  const canManagePayments = hasPermission(user?.role, "payments:manage");
  const [selectedEnquiry, setSelectedEnquiry] = useState<number | null>(null);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [paymentData, setPaymentData] = useState({
    paymentStatus: "Not Started",
    totalAmount: "",
    amountPaid: "",
    retainerAmount: "",
    retainerPaidDate: "",
    midPaymentAmount: "",
    midPaymentDate: "",
    finalPaymentAmount: "",
    finalPaymentDate: "",
    paymentTerms: "",
    paymentNotes: "",
  });

  const utils = trpc.useUtils();
  const { data: enquiries, isLoading: loadingEnquiries } = trpc.leads.list.useQuery();
  const { data: payments, isLoading: loadingPayments } = trpc.payments.list.useQuery();

  const createPaymentMutation = trpc.payments.create.useMutation({
    onSuccess: () => {
      toast.success("Payment record created successfully");
      utils.payments.list.invalidate();
      setPaymentDialogOpen(false);
      resetPaymentForm();
    },
    onError: (error) => {
      toast.error(`Failed to create payment: ${error.message}`);
    },
  });

  const updatePaymentMutation = trpc.payments.update.useMutation({
    onSuccess: () => {
      toast.success("Payment updated successfully");
      utils.payments.list.invalidate();
      setPaymentDialogOpen(false);
      resetPaymentForm();
    },
    onError: (error) => {
      toast.error(`Failed to update payment: ${error.message}`);
    },
  });

  const resetPaymentForm = () => {
    setSelectedEnquiry(null);
    setPaymentData({
      paymentStatus: "Not Started",
      totalAmount: "",
      amountPaid: "",
      retainerAmount: "",
      retainerPaidDate: "",
      midPaymentAmount: "",
      midPaymentDate: "",
      finalPaymentAmount: "",
      finalPaymentDate: "",
      paymentTerms: "",
      paymentNotes: "",
    });
  };

  const handleCreatePayment = (leadId: number, matterCode: string) => {
    setSelectedEnquiry(leadId);
    const existingPayment = payments?.find(p => p.leadId === leadId);
    if (existingPayment) {
      setPaymentData({
        paymentStatus: existingPayment.paymentStatus || "Not Started",
        totalAmount: existingPayment.totalAmount?.toString() || "",
        amountPaid: existingPayment.amountPaid?.toString() || "",
        retainerAmount: existingPayment.retainerAmount?.toString() || "",
        retainerPaidDate: existingPayment.retainerPaidDate ? new Date(existingPayment.retainerPaidDate).toISOString().split('T')[0] : "",
        midPaymentAmount: existingPayment.midPaymentAmount?.toString() || "",
        midPaymentDate: existingPayment.midPaymentDate ? new Date(existingPayment.midPaymentDate).toISOString().split('T')[0] : "",
        finalPaymentAmount: existingPayment.finalPaymentAmount?.toString() || "",
        finalPaymentDate: existingPayment.finalPaymentDate ? new Date(existingPayment.finalPaymentDate).toISOString().split('T')[0] : "",
        paymentTerms: existingPayment.paymentTerms || "",
        paymentNotes: existingPayment.paymentNotes || "",
      });
    }
    setPaymentDialogOpen(true);
  };

  const handleSubmitPayment = () => {
    if (!selectedEnquiry) return;

    const enquiry = enquiries?.find(e => e.id === selectedEnquiry);
    if (!enquiry?.matterCode) {
      toast.error("Matter code is required");
      return;
    }

    const existingPayment = payments?.find(p => p.leadId === selectedEnquiry);

    if (existingPayment) {
      updatePaymentMutation.mutate({
        id: existingPayment.id,
        ...paymentData,
      });
    } else {
      createPaymentMutation.mutate({
        leadId: selectedEnquiry,
        matterCode: enquiry.matterCode,
        ...paymentData,
      });
    }
  };

  if (loadingEnquiries || loadingPayments) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const convertedEnquiries = enquiries?.filter(e => e.currentStatus === "Converted" && e.matterCode) || [];
  const totalPaymentsReceived = payments?.reduce((sum, p) => sum + Number(p.amountPaid || 0), 0) || 0;
  const totalOutstanding = payments?.reduce((sum, p) => sum + Number(p.amountOutstanding || 0), 0) || 0;

  const statusColors: Record<string, string> = {
    "Not Started": "bg-gray-100 text-gray-800",
    "Retainer Paid": "bg-blue-100 text-blue-800",
    "Partially Paid": "bg-yellow-100 text-yellow-800",
    "Fully Paid": "bg-green-100 text-green-800",
    "Overdue": "bg-red-100 text-red-800",
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Payment Tracker</h1>
        <p className="text-gray-600 mt-1">Manage payment milestones for converted clients</p>
      </div>

      <div className="grid md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Converted Clients</CardDescription>
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <CardTitle className="text-3xl">{convertedEnquiries.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">With matter codes</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Payments Received</CardDescription>
              <DollarSign className="h-5 w-5 text-blue-600" />
            </div>
            <CardTitle className="text-3xl text-blue-600">
              {totalPaymentsReceived.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">SAR</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Outstanding</CardDescription>
              <Clock className="h-5 w-5 text-orange-600" />
            </div>
            <CardTitle className="text-3xl text-orange-600">
              {totalOutstanding.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">SAR</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Pending Setup</CardDescription>
              <AlertCircle className="h-5 w-5 text-gray-600" />
            </div>
            <CardTitle className="text-3xl text-gray-600">
              {convertedEnquiries.filter(e => !payments?.find(p => p.leadId === e.id)).length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">No payment records</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payment Records</CardTitle>
          <CardDescription>Track payment milestones for all converted enquiries</CardDescription>
        </CardHeader>
        <CardContent>
          {convertedEnquiries.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">No converted enquiries yet. Convert enquiries to track payments.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Matter Code</TableHead>
                    <TableHead>Client Name</TableHead>
                    <TableHead>Conversion Date</TableHead>
                    <TableHead className="text-right">Total Amount</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {convertedEnquiries.map((enquiry) => {
                    const payment = payments?.find(p => p.leadId === enquiry.id);
                    return (
                      <TableRow key={enquiry.id}>
                        <TableCell className="font-mono text-sm">{enquiry.matterCode}</TableCell>
                        <TableCell className="font-medium">{enquiry.clientName}</TableCell>
                        <TableCell>
                          {enquiry.conversionDate ? new Date(enquiry.conversionDate).toLocaleDateString() : '-'}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {payment?.totalAmount ? Number(payment.totalAmount).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell className="text-right text-green-600 font-medium">
                          {payment?.amountPaid ? Number(payment.amountPaid).toLocaleString() : '0'}
                        </TableCell>
                        <TableCell className="text-right text-orange-600 font-medium">
                          {payment?.amountOutstanding ? Number(payment.amountOutstanding).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell>
                          {payment ? (
                            <Badge className={statusColors[payment.paymentStatus] || "bg-gray-100 text-gray-800"}>
                              {payment.paymentStatus}
                            </Badge>
                          ) : (
                            <Badge variant="outline">Not Set Up</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {canManagePayments && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleCreatePayment(enquiry.id, enquiry.matterCode!)}
                            >
                              {payment ? "Edit" : "Set Up"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Payment Details</DialogTitle>
            <DialogDescription>
              Manage payment milestones and status
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="paymentStatus">Payment Status</Label>
                <Select
                  value={paymentData.paymentStatus}
                  onValueChange={(value) => setPaymentData({ ...paymentData, paymentStatus: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Not Started">Not Started</SelectItem>
                    <SelectItem value="Retainer Paid">Retainer Paid</SelectItem>
                    <SelectItem value="Partially Paid">Partially Paid</SelectItem>
                    <SelectItem value="Fully Paid">Fully Paid</SelectItem>
                    <SelectItem value="Overdue">Overdue</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="totalAmount">Total Amount (SAR)</Label>
                <Input
                  id="totalAmount"
                  type="number"
                  step="0.01"
                  value={paymentData.totalAmount}
                  onChange={(e) => setPaymentData({ ...paymentData, totalAmount: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amountPaid">Amount Paid (SAR)</Label>
                <Input
                  id="amountPaid"
                  type="number"
                  step="0.01"
                  value={paymentData.amountPaid}
                  onChange={(e) => setPaymentData({ ...paymentData, amountPaid: e.target.value })}
                />
              </div>
            </div>

            <div className="border-t pt-4">
              <h4 className="font-semibold mb-3">Payment Milestones</h4>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="retainerAmount">Retainer Amount (SAR)</Label>
                  <Input
                    id="retainerAmount"
                    type="number"
                    step="0.01"
                    value={paymentData.retainerAmount}
                    onChange={(e) => setPaymentData({ ...paymentData, retainerAmount: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="retainerPaidDate">Retainer Paid Date</Label>
                  <Input
                    id="retainerPaidDate"
                    type="date"
                    value={paymentData.retainerPaidDate}
                    onChange={(e) => setPaymentData({ ...paymentData, retainerPaidDate: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="midPaymentAmount">Mid Payment Amount (SAR)</Label>
                  <Input
                    id="midPaymentAmount"
                    type="number"
                    step="0.01"
                    value={paymentData.midPaymentAmount}
                    onChange={(e) => setPaymentData({ ...paymentData, midPaymentAmount: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="midPaymentDate">Mid Payment Date</Label>
                  <Input
                    id="midPaymentDate"
                    type="date"
                    value={paymentData.midPaymentDate}
                    onChange={(e) => setPaymentData({ ...paymentData, midPaymentDate: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="finalPaymentAmount">Final Payment Amount (SAR)</Label>
                  <Input
                    id="finalPaymentAmount"
                    type="number"
                    step="0.01"
                    value={paymentData.finalPaymentAmount}
                    onChange={(e) => setPaymentData({ ...paymentData, finalPaymentAmount: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="finalPaymentDate">Final Payment Date</Label>
                  <Input
                    id="finalPaymentDate"
                    type="date"
                    value={paymentData.finalPaymentDate}
                    onChange={(e) => setPaymentData({ ...paymentData, finalPaymentDate: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="paymentTerms">Payment Terms</Label>
              <Textarea
                id="paymentTerms"
                rows={2}
                value={paymentData.paymentTerms}
                onChange={(e) => setPaymentData({ ...paymentData, paymentTerms: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="paymentNotes">Payment Notes</Label>
              <Textarea
                id="paymentNotes"
                rows={3}
                value={paymentData.paymentNotes}
                onChange={(e) => setPaymentData({ ...paymentData, paymentNotes: e.target.value })}
              />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setPaymentDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmitPayment}
                disabled={createPaymentMutation.isPending || updatePaymentMutation.isPending}
              >
                {(createPaymentMutation.isPending || updatePaymentMutation.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Save Payment
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

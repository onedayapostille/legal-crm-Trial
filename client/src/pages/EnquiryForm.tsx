import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { Loader2, Save, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { useEffect } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CHANNEL_TYPES, DIGITAL_MEDIUMS, channelMediumRequired } from "@shared/const";
import { userCan } from "@/lib/permissions";

interface EnquiryFormProps {
  id?: number;
}

/** Format a Date as `YYYY-MM-DDTHH:MM` in the browser's local time for
 *  <input type="datetime-local">. Avoids toISOString()'s UTC shift. */
function toLocalDateTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface FormData {
  dateOfEnquiry: string;
  enquiryDateTime?: string; // local datetime-local value; UTC + legacy fields derived on submit
  clientName: string;
  time?: string;
  channelType?: string;
  channelMedium?: string;
  communicationChannel?: string;
  receivedBy?: string;
  clientType?: string;
  nationality?: string;
  email?: string;
  phoneNumber?: string;
  preferredContactMethod?: string;
  languagePreference?: string;
  serviceRequested?: string;
  shortDescription?: string;
  urgencyLevel?: string;
  clientBudget?: string;
  potentialValueRange?: string;
  expectedTimeline?: string;
  referralSourceName?: string;
  competitorInvolvement?: string;
  competitorName?: string;
  assignedDepartment?: string;
  suggestedLeadLawyer?: string; // legacy display name (server-derived from assignedTo)
  assignedTo?: number;          // selected lead-lawyer user id
  currentStatus?: string;
  nextAction?: string;
  deadline?: string;
  firstResponseDate?: string;
  meetingDate?: string;
  proposalSentDate?: string;
  proposalValue?: string;
  followUpCount?: number;
  lastContactDate?: string;
  conversionDate?: string;
  engagementLetterDate?: string;
  paymentStatus?: string;
  invoiceNumber?: string;
  lostReason?: string;
  internalNotes?: string;
}

export default function EnquiryForm({ id }: EnquiryFormProps) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { user } = useAuth();
  // leads:view (e.g. Manager) may open an enquiry read-only; saving needs leads:manage.
  const canManageLeads = id
    ? userCan(user, "leads:edit")
    : userCan(user, "leads:create");

  const { data: enquiry, isLoading: loadingEnquiry } = trpc.leads.get.useQuery(
    { id: id! },
    { enabled: !!id }
  );

  // Active Partners/Lawyers for the Suggested Lead Lawyer dropdown.
  const { data: leadLawyers = [] } = trpc.users.leadLawyers.useQuery();

  // Every enquiry create/update mirrors a canonical client (see syncLeadToClient
  // on the server). Invalidate both the legacy leads list AND the canonical
  // client queries that back the Leads Pipeline + dashboard, so the new/updated
  // intake is visible immediately without a manual refresh (same-user real-time).
  const invalidateCanonicalIntake = () => {
    utils.leads.list.invalidate();
    utils.dashboard.stats.invalidate();
    utils.clients.list.invalidate();
    utils.clients.recentLeads.invalidate();
    utils.clients.dashboardStats.invalidate();
    utils.clients.statusCounts.invalidate();
    utils.clients.conversionMetrics.invalidate();
  };

  const createMutation = trpc.leads.create.useMutation({
    onSuccess: () => {
      toast.success("Enquiry created successfully");
      invalidateCanonicalIntake();
      navigate("/enquiries");
    },
    onError: (error) => {
      toast.error(`Failed to create enquiry: ${error.message}`);
    },
  });

  const updateMutation = trpc.leads.update.useMutation({
    onSuccess: () => {
      toast.success("Enquiry updated successfully");
      invalidateCanonicalIntake();
      utils.leads.get.invalidate({ id: id! });
    },
    onError: (error) => {
      toast.error(`Failed to update enquiry: ${error.message}`);
    },
  });

  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormData>({
    defaultValues: {
      currentStatus: "New",
      urgencyLevel: "Medium",
    }
  });

  useEffect(() => {
    if (enquiry) {
      Object.entries(enquiry).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          setValue(key as keyof FormData, value as any);
        }
      });
      // Show the stored UTC instant in the user's local timezone.
      const iso = (enquiry as any).enquiryAt as string | null | undefined;
      if (iso) {
        setValue("enquiryDateTime", toLocalDateTimeInput(new Date(iso)));
      } else if (enquiry.dateOfEnquiry) {
        setValue("enquiryDateTime", `${enquiry.dateOfEnquiry}T${String(enquiry.time ?? "00:00").slice(0, 5)}`);
      }
    } else if (!id) {
      // New enquiry → auto-populate with the current browser/local time.
      setValue("enquiryDateTime", toLocalDateTimeInput(new Date()));
    }
  }, [enquiry, id, setValue]);

  const onSubmit = (data: FormData) => {
    // Channel validation (mirrors the backend).
    if (!data.channelType) {
      toast.error("Communication channel type is required.");
      return;
    }
    if (channelMediumRequired(data.channelType) && !data.channelMedium?.trim()) {
      toast.error(data.channelType === "Referral" ? "Referral name is required." : "Channel medium is required.");
      return;
    }

    const local = data.enquiryDateTime || toLocalDateTimeInput(new Date());
    // local ("YYYY-MM-DDTHH:MM") is parsed as local time → toISOString() gives UTC.
    const enquiryAt = new Date(local).toISOString();
    const dateOfEnquiry = local.split("T")[0];            // legacy display column
    const time = (local.split("T")[1] ?? "").slice(0, 5); // legacy display column
    const enquiryTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Keep the legacy flat column populated for back-compat.
    const communicationChannel = data.channelMedium?.trim() || data.channelType;
    // suggestedLeadLawyer is derived server-side from assignedTo — never send the
    // free-text name (avoids misspellings / stale values).
    const { enquiryDateTime: _omit, suggestedLeadLawyer: _omit2, ...rest } = data;
    const payload = { ...rest, communicationChannel, dateOfEnquiry, time, enquiryAt, enquiryTimezone };
    if (id) {
      updateMutation.mutate({ id, ...payload });
    } else {
      createMutation.mutate(payload as any);
    }
  };

  if (loadingEnquiry) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={() => navigate("/enquiries")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to List
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">
            {id ? `Edit Enquiry ${enquiry?.leadCode}` : "New Enquiry"}
          </h1>
          <p className="text-gray-600 mt-1">
            {id ? "Update enquiry details" : "Create a new client enquiry"}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Basic Information */}
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
            <CardDescription>Essential enquiry details</CardDescription>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="enquiryDateTime">Date &amp; Time of Enquiry *</Label>
              <Input
                id="enquiryDateTime"
                type="datetime-local"
                {...register("enquiryDateTime", { required: true })}
              />
              <p className="text-xs text-muted-foreground">
                Auto-filled with your current local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
                Override for past enquiries — stored in UTC.
              </p>
              {errors.enquiryDateTime && <p className="text-sm text-red-600">Date &amp; time is required</p>}
            </div>
            {/* Communication Channel — Level 1: type */}
            <div className="space-y-2">
              <Label htmlFor="channelType">Communication Channel *</Label>
              <Select
                value={watch("channelType")}
                onValueChange={(value) => {
                  setValue("channelType", value);
                  setValue("channelMedium", ""); // reset medium when type changes
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select channel type" />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Level 2: medium (conditional on type) */}
            {watch("channelType") === "Digital Channels" && (
              <div className="space-y-2">
                <Label htmlFor="channelMedium">Medium *</Label>
                <Select value={watch("channelMedium")} onValueChange={(value) => setValue("channelMedium", value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select medium" />
                  </SelectTrigger>
                  <SelectContent>
                    {DIGITAL_MEDIUMS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {watch("channelType") === "Referral" && (
              <div className="space-y-2">
                <Label htmlFor="channelMedium">Referral Name *</Label>
                <Input id="channelMedium" {...register("channelMedium")} placeholder="Who referred them?" />
              </div>
            )}
            {watch("channelType") === "Event / Conference" && (
              <div className="space-y-2">
                <Label htmlFor="channelMedium">Event Name</Label>
                <Input id="channelMedium" {...register("channelMedium")} placeholder="Event / conference name (optional)" />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="receivedBy">Received By</Label>
              <Input id="receivedBy" {...register("receivedBy")} />
            </div>
          </CardContent>
        </Card>

        {/* Client Details */}
        <Card>
          <CardHeader>
            <CardTitle>Client Details</CardTitle>
            <CardDescription>Information about the client</CardDescription>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="clientName">Client Name / Entity *</Label>
              <Input
                id="clientName"
                {...register("clientName", { required: true })}
                placeholder="Full name or company name"
              />
              {errors.clientName && <p className="text-sm text-red-600">Client name is required</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="clientType">Client Type</Label>
              <Select onValueChange={(value) => setValue("clientType", value)} value={watch("clientType")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Individual">Individual</SelectItem>
                  <SelectItem value="Corporate">Corporate</SelectItem>
                  <SelectItem value="Government">Government</SelectItem>
                  <SelectItem value="Foreign Investor">Foreign Investor</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="nationality">Nationality / Jurisdiction</Label>
              <Input id="nationality" {...register("nationality")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...register("email")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phoneNumber">Phone Number</Label>
              <Input id="phoneNumber" {...register("phoneNumber")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="preferredContactMethod">Preferred Contact Method</Label>
              <Select onValueChange={(value) => setValue("preferredContactMethod", value)} value={watch("preferredContactMethod")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Email">Email</SelectItem>
                  <SelectItem value="Phone">Phone</SelectItem>
                  <SelectItem value="WhatsApp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="languagePreference">Language Preference</Label>
              <Select onValueChange={(value) => setValue("languagePreference", value)} value={watch("languagePreference")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Arabic">Arabic</SelectItem>
                  <SelectItem value="English">English</SelectItem>
                  <SelectItem value="Both">Both</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Service Details */}
        <Card>
          <CardHeader>
            <CardTitle>Service Details</CardTitle>
            <CardDescription>Information about the requested service</CardDescription>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="serviceRequested">Service Requested</Label>
              <Select onValueChange={(value) => setValue("serviceRequested", value)} value={watch("serviceRequested")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select service" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Corporate / M&A">Corporate / M&A</SelectItem>
                  <SelectItem value="Commercial Advisory">Commercial Advisory</SelectItem>
                  <SelectItem value="Litigation">Litigation</SelectItem>
                  <SelectItem value="Employment">Employment</SelectItem>
                  <SelectItem value="Tax">Tax</SelectItem>
                  <SelectItem value="Government Relations">Government Relations</SelectItem>
                  <SelectItem value="Foreign Investment">Foreign Investment</SelectItem>
                  <SelectItem value="Regulatory / Licensing">Regulatory / Licensing</SelectItem>
                  <SelectItem value="AI & Technology">AI & Technology</SelectItem>
                  <SelectItem value="Dispute Resolution">Dispute Resolution</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="urgencyLevel">Urgency Level</Label>
              <Select onValueChange={(value) => setValue("urgencyLevel", value)} value={watch("urgencyLevel")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select urgency" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Low">Low</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="shortDescription">Short Description</Label>
              <Textarea id="shortDescription" {...register("shortDescription")} rows={3} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="clientBudget">Client Budget (SAR)</Label>
              <Input id="clientBudget" type="number" step="0.01" {...register("clientBudget")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="potentialValueRange">Potential Value Range</Label>
              <Select onValueChange={(value) => setValue("potentialValueRange", value)} value={watch("potentialValueRange")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select range" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="< 20k">{"< 20k"}</SelectItem>
                  <SelectItem value="20k-100k">20k-100k</SelectItem>
                  <SelectItem value="100k-300k">100k-300k</SelectItem>
                  <SelectItem value="300k-1M">300k-1M</SelectItem>
                  <SelectItem value="> 1M">{"> 1M"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="expectedTimeline">Expected Timeline</Label>
              <Input id="expectedTimeline" {...register("expectedTimeline")} placeholder="e.g., 2-3 months" />
            </div>
          </CardContent>
        </Card>

        {/* Assignment & Status */}
        <Card>
          <CardHeader>
            <CardTitle>Assignment & Status</CardTitle>
            <CardDescription>Internal assignment and tracking</CardDescription>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="assignedDepartment">Assigned Department</Label>
              <Select onValueChange={(value) => setValue("assignedDepartment", value)} value={watch("assignedDepartment")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Corporate">Corporate</SelectItem>
                  <SelectItem value="Litigation">Litigation</SelectItem>
                  <SelectItem value="Employment">Employment</SelectItem>
                  <SelectItem value="Tax">Tax</SelectItem>
                  <SelectItem value="Government Relations">Government Relations</SelectItem>
                  <SelectItem value="Regulatory">Regulatory</SelectItem>
                  <SelectItem value="Foreign Investment">Foreign Investment</SelectItem>
                  <SelectItem value="AI & Technology">AI & Technology</SelectItem>
                  <SelectItem value="Dispute Resolution">Dispute Resolution</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="assignedTo">Suggested Lead Lawyer</Label>
              <Select
                value={watch("assignedTo") ? String(watch("assignedTo")) : "none"}
                onValueChange={(value) => setValue("assignedTo", value === "none" ? undefined : Number(value))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a lawyer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Unassigned —</SelectItem>
                  {leadLawyers.map(l => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name ?? `User #${l.id}`} · <span className="capitalize">{l.role}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Active Partners/Lawyers only. The selected lawyer is notified on save.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="currentStatus">Current Status</Label>
              <Select onValueChange={(value) => setValue("currentStatus", value)} value={watch("currentStatus")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="New">New</SelectItem>
                  <SelectItem value="Contacted">Contacted</SelectItem>
                  <SelectItem value="Meeting Scheduled">Meeting Scheduled</SelectItem>
                  <SelectItem value="Proposal Sent">Proposal Sent</SelectItem>
                  <SelectItem value="Converted">Converted</SelectItem>
                  <SelectItem value="Lost">Lost</SelectItem>
                  <SelectItem value="On Hold">On Hold</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="deadline">Deadline</Label>
              <Input id="deadline" type="date" {...register("deadline")} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="nextAction">Next Action</Label>
              <Textarea id="nextAction" {...register("nextAction")} rows={2} />
            </div>
          </CardContent>
        </Card>

        {/* Progress Tracking */}
        {id && (
          <Card>
            <CardHeader>
              <CardTitle>Progress Tracking</CardTitle>
              <CardDescription>Milestone dates and follow-up</CardDescription>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstResponseDate">First Response Date</Label>
                <Input id="firstResponseDate" type="date" {...register("firstResponseDate")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="meetingDate">Meeting Date</Label>
                <Input id="meetingDate" type="date" {...register("meetingDate")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proposalSentDate">Proposal Sent Date</Label>
                <Input id="proposalSentDate" type="date" {...register("proposalSentDate")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proposalValue">Proposal Value (SAR)</Label>
                <Input id="proposalValue" type="number" step="0.01" {...register("proposalValue")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="followUpCount">Follow-up Count</Label>
                <Input id="followUpCount" type="number" {...register("followUpCount", { valueAsNumber: true })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastContactDate">Last Contact Date</Label>
                <Input id="lastContactDate" type="date" {...register("lastContactDate")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="conversionDate">Conversion Date</Label>
                <Input id="conversionDate" type="date" {...register("conversionDate")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="engagementLetterDate">Engagement Letter Date</Label>
                <Input id="engagementLetterDate" type="date" {...register("engagementLetterDate")} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Additional Information */}
        <Card>
          <CardHeader>
            <CardTitle>Additional Information</CardTitle>
            <CardDescription>Referral sources and notes</CardDescription>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="referralSourceName">Referral Source Name</Label>
              <Input id="referralSourceName" {...register("referralSourceName")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="competitorInvolvement">Competitor Involvement</Label>
              <Select onValueChange={(value) => setValue("competitorInvolvement", value)} value={watch("competitorInvolvement")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select option" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Yes">Yes</SelectItem>
                  <SelectItem value="No">No</SelectItem>
                  <SelectItem value="Unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {watch("competitorInvolvement") === "Yes" && (
              <div className="space-y-2">
                <Label htmlFor="competitorName">Competitor Name</Label>
                <Input id="competitorName" {...register("competitorName")} />
              </div>
            )}
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="internalNotes">Internal Notes</Label>
              <Textarea id="internalNotes" {...register("internalNotes")} rows={4} />
            </div>
          </CardContent>
        </Card>

        {/* Submit Button */}
        <div className="flex justify-end gap-4">
          <Button type="button" variant="outline" onClick={() => navigate("/enquiries")}>
            Cancel
          </Button>
          {canManageLeads && (
            <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              <Save className="h-4 w-4 mr-2" />
              {id ? "Update Enquiry" : "Create Enquiry"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

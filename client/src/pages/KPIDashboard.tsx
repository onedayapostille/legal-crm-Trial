import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingUp, Users, DollarSign, Target, Clock, CheckCircle } from "lucide-react";

export default function KPIDashboard() {
  const { data: metrics, isLoading } = trpc.leads.kpiMetrics.useQuery();
  // Conversion Rate uses the SAME canonical source as the main dashboard
  // (clients.conversionMetrics) so every page reports an identical rate. The
  // leads.kpiMetrics query above is kept only for enquiry-volume + revenue cards.
  const { data: conversion } = trpc.clients.conversionMetrics.useQuery({ range: "all" });
  const convertedLeads = conversion?.converted ?? 0;
  const totalLeadsCanonical = conversion?.total ?? 0;
  const conversionRate = conversion?.conversionRate ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const kpiCards = [
    {
      title: "Total Enquiries",
      value: metrics?.totalLeads || 0,
      description: "All time",
      icon: Users,
      color: "text-blue-600",
      bgColor: "bg-blue-100",
    },
    {
      title: "This Month",
      value: metrics?.newLeads || 0,
      description: "Current month enquiries",
      icon: Clock,
      color: "text-purple-600",
      bgColor: "bg-purple-100",
    },
    {
      title: "Converted",
      value: convertedLeads,
      description: "Leads that became clients",
      icon: CheckCircle,
      color: "text-green-600",
      bgColor: "bg-green-100",
    },
    {
      title: "Conversion Rate",
      value: `${conversionRate.toFixed(1)}%`,
      description: totalLeadsCanonical > 0
        ? `${convertedLeads} of ${totalLeadsCanonical} leads · all time`
        : "No leads yet",
      icon: Target,
      color: "text-orange-600",
      bgColor: "bg-orange-100",
    },
    {
      title: "Total Revenue",
      value: `${(metrics?.totalRevenue || 0).toLocaleString()} SAR`,
      description: "From converted enquiries",
      icon: DollarSign,
      color: "text-emerald-600",
      bgColor: "bg-emerald-100",
    },
    {
      title: "Avg. Value",
      value: metrics?.convertedLeads && metrics.convertedLeads > 0
        ? `${((metrics?.totalRevenue || 0) / metrics.convertedLeads).toLocaleString(undefined, { maximumFractionDigits: 0 })} SAR`
        : "0 SAR",
      description: "Per converted enquiry",
      icon: TrendingUp,
      color: "text-indigo-600",
      bgColor: "bg-indigo-100",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">KPI Dashboard</h1>
        <p className="text-gray-600 mt-1">Key performance indicators and metrics</p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {kpiCards.map((kpi, index) => (
          <Card key={index} className="border-2 hover:border-blue-200 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription>{kpi.title}</CardDescription>
                <div className={`p-2 rounded-lg ${kpi.bgColor}`}>
                  <kpi.icon className={`h-5 w-5 ${kpi.color}`} />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <CardTitle className={`text-3xl mb-1 ${kpi.color}`}>
                {kpi.value}
              </CardTitle>
              <p className="text-sm text-gray-600">{kpi.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance Summary</CardTitle>
          <CardDescription>Overview of your enquiry management performance</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <h4 className="font-semibold text-gray-900">Enquiry Volume</h4>
              <p className="text-sm text-gray-600">
                You have received <strong>{metrics?.totalLeads || 0}</strong> total enquiries, 
                with <strong>{metrics?.newLeads || 0}</strong> coming in this month.
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold text-gray-900">Conversion Performance</h4>
              <p className="text-sm text-gray-600">
                Your conversion rate is <strong>{conversionRate.toFixed(1)}%</strong>,
                with <strong>{convertedLeads}</strong> of <strong>{totalLeadsCanonical}</strong> leads converted into clients.
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold text-gray-900">Revenue Generated</h4>
              <p className="text-sm text-gray-600">
                Total revenue from converted enquiries is <strong>{(metrics?.totalRevenue || 0).toLocaleString()} SAR</strong>, 
                averaging {metrics?.convertedLeads && metrics.convertedLeads > 0
                  ? <strong>{((metrics?.totalRevenue || 0) / metrics.convertedLeads).toLocaleString(undefined, { maximumFractionDigits: 0 })} SAR</strong>
                  : <strong>0 SAR</strong>} per conversion.
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold text-gray-900">Growth Opportunity</h4>
              <p className="text-sm text-gray-600">
                {totalLeadsCanonical > 0 && conversionRate < 50 ? (
                  <>
                    There are <strong>{totalLeadsCanonical - convertedLeads}</strong> leads
                    that could potentially be converted with proper follow-up.
                  </>
                ) : (
                  "Continue tracking leads to identify growth opportunities."
                )}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

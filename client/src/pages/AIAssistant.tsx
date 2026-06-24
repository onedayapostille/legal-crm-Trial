import { useState, useRef, useEffect } from "react";
import { Sparkles, Send, Loader2, AlertTriangle, User as UserIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/_core/hooks/useAuth";
import { hasPermission } from "@shared/const";

type Period = "month" | "quarter" | "year" | "all";
const PERIODS: { value: Period; label: string }[] = [
  { value: "month", label: "This Month" },
  { value: "quarter", label: "This Quarter" },
  { value: "year", label: "This Year" },
  { value: "all", label: "All Time" },
];

const SUGGESTED = [
  "What is the conversion rate this month?",
  "Which leads need follow-up?",
  "What are the outstanding amounts?",
  "Which matters are delayed?",
  "Which lawyers have overdue tasks?",
  "Summarize this quarter’s CRM performance.",
  "What are the main risks in current matters?",
];

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  ok?: boolean;
  period?: Period;
};

export default function AIAssistant() {
  const { user } = useAuth();
  const canUse = hasPermission(user?.role, "ai:assistant");

  const [period, setPeriod] = useState<Period>("month");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ask = trpc.ai.ask.useMutation({
    onSuccess: (res) => {
      setMessages(m => [...m, { role: "assistant", content: res.answer, ok: res.ok, period: res.period as Period }]);
    },
    onError: (err) => {
      setMessages(m => [...m, {
        role: "assistant",
        content: err.message || "AI analysis is temporarily unavailable. Please try again later.",
        ok: false,
      }]);
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, ask.isPending]);

  if (!canUse) {
    return (
      <DashboardLayout>
        <div className="max-w-md mx-auto mt-20 text-center text-muted-foreground">
          <AlertTriangle className="h-8 w-8 mx-auto mb-3 text-amber-500" />
          You don’t have access to the AI Assistant.
        </div>
      </DashboardLayout>
    );
  }

  const submit = (question: string) => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    setMessages(m => [...m, { role: "user", content: q, period }]);
    setInput("");
    ask.mutate({ question: q, period });
  };

  return (
    <DashboardLayout>
      <div className="flex flex-col h-[calc(100vh-7rem)] max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-purple-100">
              <Sparkles className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">AI Assistant</h1>
              <p className="text-xs text-muted-foreground">
                Ask about CRM performance — answers use your permitted CRM data only.
              </p>
            </div>
          </div>
          <div className="w-40">
            <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERIODS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 space-y-4">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Try one of these:</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED.map(s => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="text-xs px-3 py-1.5 rounded-full border bg-muted/40 hover:bg-muted transition-colors text-left"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" && (
                <div className="p-1.5 rounded-lg bg-purple-100 h-fit"><Sparkles className="h-4 w-4 text-purple-600" /></div>
              )}
              <Card className={`max-w-[80%] ${m.role === "user" ? "bg-primary text-primary-foreground" : ""}`}>
                <CardContent className="py-2.5 px-3.5">
                  {m.role === "assistant" && m.ok === false && (
                    <Badge variant="outline" className="mb-1.5 bg-amber-50 text-amber-700 border-amber-200">
                      Unavailable
                    </Badge>
                  )}
                  <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.content}</p>
                </CardContent>
              </Card>
              {m.role === "user" && (
                <div className="p-1.5 rounded-lg bg-muted h-fit"><UserIcon className="h-4 w-4" /></div>
              )}
            </div>
          ))}

          {ask.isPending && (
            <div className="flex gap-3 justify-start">
              <div className="p-1.5 rounded-lg bg-purple-100 h-fit"><Sparkles className="h-4 w-4 text-purple-600" /></div>
              <Card><CardContent className="py-2.5 px-3.5 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Analyzing CRM data…
              </CardContent></Card>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t pt-3">
          <div className="flex gap-2 items-end">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(input); } }}
              placeholder="Ask about leads, conversion, outstanding amounts, matters, tasks…"
              rows={2}
              className="resize-none text-sm"
            />
            <Button onClick={() => submit(input)} disabled={ask.isPending || !input.trim()} className="h-auto py-2.5">
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            AI can make mistakes — verify figures against the CRM. Answers use only the data your role permits.
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}

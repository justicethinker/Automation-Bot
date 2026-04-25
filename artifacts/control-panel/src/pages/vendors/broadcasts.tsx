import { useState } from "react";
import {
  useGetVendor,
  useListVendorBroadcasts,
  useSendVendorBroadcast,
  useRunVendorFollowUps,
  useUpdateVendor,
  getListVendorBroadcastsQueryKey,
  getGetVendorQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Megaphone, Sparkles, Send, Bell } from "lucide-react";
import { Link } from "wouter";
import { format } from "date-fns";

export default function VendorBroadcasts({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const { data: vendor } = useGetVendor(vendorId, { query: { enabled: !!vendorId } });
  const { data: history, isLoading } = useListVendorBroadcasts(vendorId, {
    query: { enabled: !!vendorId },
  });
  const send = useSendVendorBroadcast();
  const runFollowUps = useRunVendorFollowUps();
  const updateVendor = useUpdateVendor();

  const [message, setMessage] = useState("");
  const [sinceDays, setSinceDays] = useState(30);
  const [feedback, setFeedback] = useState<string | null>(null);

  const isPro = vendor?.plan === "pro";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListVendorBroadcastsQueryKey(vendorId) });
  };

  const onSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    const res = await send.mutateAsync({
      vendorId,
      data: { message: message.trim(), sinceDays },
    });
    setFeedback(`Sent to ${res.recipientCount} customer${res.recipientCount === 1 ? "" : "s"}.`);
    setMessage("");
    invalidate();
  };

  const onRunFollowUps = async () => {
    const res = await runFollowUps.mutateAsync({ vendorId });
    setFeedback(
      res.reminded === 0
        ? `No stalled orders right now.`
        : `Reminded ${res.reminded} customer${res.reminded === 1 ? "" : "s"} with unpaid orders.`,
    );
    invalidate();
  };

  const toggleAuto = async (v: boolean) => {
    await updateVendor.mutateAsync({ vendorId, data: { followUpsEnabled: v } });
    qc.invalidateQueries({ queryKey: getGetVendorQueryKey(vendorId) });
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Broadcasts &amp; follow-ups</h1>
        <p className="text-muted-foreground mt-1">
          Reach recent customers with one message, or remind people who haven't paid.
        </p>
      </div>

      {!isPro && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50">
          <CardContent className="py-4 flex items-center gap-3 flex-wrap">
            <div className="h-10 w-10 rounded-full bg-amber-200 dark:bg-amber-900 flex items-center justify-center text-amber-700 dark:text-amber-300">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <h3 className="font-semibold text-sm">Broadcasts and follow-ups are Pro features</h3>
              <p className="text-xs text-muted-foreground">
                Upgrade {vendor?.name} to Pro to message customers in bulk and automate reminders.
              </p>
            </div>
            <Link href={`/vendors/${vendorId}/settings`}>
              <Button size="sm" variant="outline">Upgrade plan</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Send a broadcast</CardTitle>
          <CardDescription>
            Goes to customers who messaged this vendor in the last N days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSend} className="space-y-3">
            <Textarea
              placeholder="Hi! New menu items just dropped. Reply *menu* to see them."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              disabled={!isPro}
            />
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-sm text-muted-foreground flex items-center gap-2">
                Active in last
                <Input
                  type="number"
                  className="w-20"
                  value={sinceDays}
                  min={1}
                  max={365}
                  onChange={(e) => setSinceDays(Math.max(1, Number(e.target.value) || 30))}
                  disabled={!isPro}
                />
                days
              </label>
              <Button
                type="submit"
                disabled={!isPro || !message.trim() || send.isPending}
                className="gap-2"
              >
                <Send className="w-4 h-4" />
                {send.isPending ? "Sending..." : "Send broadcast"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto follow-ups</CardTitle>
          <CardDescription>
            Reminds customers whose order was confirmed more than 24h ago but still unpaid.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium text-sm">Enable automatic reminders</div>
              <div className="text-xs text-muted-foreground">
                When on, follow-ups run automatically once a day.
              </div>
            </div>
            <Switch
              checked={!!vendor?.followUpsEnabled}
              onCheckedChange={toggleAuto}
              disabled={!isPro}
            />
          </div>
          <Button
            variant="outline"
            onClick={onRunFollowUps}
            disabled={!isPro || runFollowUps.isPending}
            className="gap-2"
          >
            <Bell className="w-4 h-4" />
            {runFollowUps.isPending ? "Running..." : "Run follow-ups now"}
          </Button>
        </CardContent>
      </Card>

      {feedback && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="py-3 text-sm">{feedback}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent broadcasts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2].map((i) => <div key={i} className="h-12 bg-muted animate-pulse rounded" />)}
            </div>
          ) : !history || history.length === 0 ? (
            <div className="py-12 flex flex-col items-center text-center gap-3">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <Megaphone className="w-5 h-5" />
              </div>
              <h3 className="font-semibold">No broadcasts sent yet</h3>
              <p className="text-sm text-muted-foreground">Your sent messages will show up here.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Message</th>
                  <th className="px-4 py-3 text-right">Recipients</th>
                </tr>
              </thead>
              <tbody>
                {history.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {format(new Date(b.sentAt), "MMM d, p")}
                    </td>
                    <td className="px-4 py-3 max-w-md truncate">{b.message}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{b.recipientCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

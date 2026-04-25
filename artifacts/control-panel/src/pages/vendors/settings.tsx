import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVendor,
  useUpdateVendor,
  useDeleteVendor,
  getGetVendorQueryKey,
  getListVendorsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { PlanBadge } from "@/components/plan-badge";
import { Trash2 } from "lucide-react";

export default function VendorSettings({ vendorId }: { vendorId: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: vendor } = useGetVendor(vendorId, { query: { enabled: !!vendorId } });
  const updateVendor = useUpdateVendor();
  const deleteVendor = useDeleteVendor();

  const [form, setForm] = useState({
    name: "",
    phoneNumber: "",
    botNumber: "",
    adminNumber: "",
    phoneNumberId: "",
    plan: "starter" as "starter" | "pro",
    currency: "USD",
    bankName: "",
    bankAccountNumber: "",
    bankAccountHolder: "",
    welcomeMessage: "",
    botEnabled: true,
  });

  useEffect(() => {
    if (vendor) {
      setForm({
        name: vendor.name,
        phoneNumber: vendor.phoneNumber,
        botNumber: vendor.botNumber ?? "",
        adminNumber: vendor.adminNumber ?? "",
        phoneNumberId: vendor.phoneNumberId ?? "",
        plan: vendor.plan,
        currency: vendor.currency,
        bankName: vendor.bankName ?? "",
        bankAccountNumber: vendor.bankAccountNumber ?? "",
        bankAccountHolder: vendor.bankAccountHolder ?? "",
        welcomeMessage: vendor.welcomeMessage ?? "",
        botEnabled: vendor.botEnabled,
      });
    }
  }, [vendor?.id]);

  if (!vendor) {
    return <div className="h-32 bg-muted animate-pulse rounded-xl" />;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateVendor.mutateAsync({
        vendorId,
        data: {
          name: form.name,
          phoneNumber: form.phoneNumber,
          botNumber: form.botNumber,
          adminNumber: form.adminNumber,
          phoneNumberId: form.phoneNumberId,
          plan: form.plan,
          currency: form.currency,
          bankName: form.bankName,
          bankAccountNumber: form.bankAccountNumber,
          bankAccountHolder: form.bankAccountHolder,
          welcomeMessage: form.welcomeMessage,
          botEnabled: form.botEnabled,
        },
      });
      qc.invalidateQueries({ queryKey: getGetVendorQueryKey(vendorId) });
      qc.invalidateQueries({ queryKey: getListVendorsQueryKey() });
      toast({ title: "Vendor updated" });
    } catch (err) {
      toast({ title: "Update failed", description: err instanceof Error ? err.message : "", variant: "destructive" });
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete ${vendor!.name}? This removes all menu items, orders, customers, and chats.`)) return;
    await deleteVendor.mutateAsync({ vendorId });
    qc.invalidateQueries({ queryKey: getListVendorsQueryKey() });
    toast({ title: "Vendor deleted" });
    navigate("/vendors");
  }

  return (
    <div className="max-w-2xl space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <PlanBadge plan={form.plan} />
      </div>

      <form onSubmit={save} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label>Business name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid gap-2 md:grid-cols-2 md:gap-4">
              <div className="grid gap-2">
                <Label>WhatsApp number</Label>
                <Input value={form.phoneNumber} onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Currency</Label>
                <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Welcome message</Label>
              <Textarea rows={3} value={form.welcomeMessage} onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })} />
            </div>
            <div className="flex items-center justify-between p-3 rounded-md border border-border">
              <div>
                <div className="font-medium text-sm">Bot enabled</div>
                <div className="text-xs text-muted-foreground">When off, the bot stops auto-replying for every customer.</div>
              </div>
              <Switch checked={form.botEnabled} onCheckedChange={(v) => setForm({ ...form, botEnabled: v })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>WhatsApp routing</CardTitle>
            <CardDescription>Bot display number, vendor admin number, and Meta IDs used to route inbound messages.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2 md:grid-cols-2 md:gap-4">
              <div className="grid gap-2">
                <Label>Bot display number</Label>
                <Input value={form.botNumber} onChange={(e) => setForm({ ...form, botNumber: e.target.value })} placeholder="+15551234567" />
              </div>
              <div className="grid gap-2">
                <Label>Vendor admin number</Label>
                <Input value={form.adminNumber} onChange={(e) => setForm({ ...form, adminNumber: e.target.value })} placeholder="+15558881111" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Meta phone_number_id</Label>
              <Input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} placeholder="100000000000001" />
              <p className="text-xs text-muted-foreground">Webhooks from Meta are routed to this vendor by phone_number_id.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Switch between Starter and Pro any time.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {(["starter", "pro"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setForm({ ...form, plan: p })}
                className={
                  "text-left p-3 rounded-lg border transition-all " +
                  (form.plan === p ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "border-border hover-elevate")
                }
              >
                <div className="flex items-center gap-2">
                  <PlanBadge plan={p} />
                  <span className="font-semibold capitalize">{p}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {p === "starter" ? "Bot, menu, orders, manual bank-transfer payments." : "Adds analytics, follow-ups, customer memory, promotions."}
                </p>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bank details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label>Bank name</Label>
              <Input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
            </div>
            <div className="grid gap-2 md:grid-cols-2 md:gap-4">
              <div className="grid gap-2">
                <Label>Account number</Label>
                <Input value={form.bankAccountNumber} onChange={(e) => setForm({ ...form, bankAccountNumber: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>Account holder</Label>
                <Input value={form.bankAccountHolder} onChange={(e) => setForm({ ...form, bankAccountHolder: e.target.value })} />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={updateVendor.isPending}>{updateVendor.isPending ? "Saving..." : "Save changes"}</Button>
        </div>
      </form>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>Deleting a vendor removes everything tied to it.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteVendor.isPending}>
            <Trash2 className="w-4 h-4 mr-2" /> Delete vendor
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

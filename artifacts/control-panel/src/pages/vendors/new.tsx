import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateVendor,
  getListVendorsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft } from "lucide-react";
import { Link } from "wouter";

export default function NewVendor() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const createVendor = useCreateVendor();

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
  });

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const created = await createVendor.mutateAsync({
        data: {
          name: form.name,
          phoneNumber: form.phoneNumber,
          plan: form.plan,
          currency: form.currency,
          ...(form.botNumber ? { botNumber: form.botNumber } : {}),
          ...(form.adminNumber ? { adminNumber: form.adminNumber } : {}),
          ...(form.phoneNumberId ? { phoneNumberId: form.phoneNumberId } : {}),
          ...(form.bankName ? { bankName: form.bankName } : {}),
          ...(form.bankAccountNumber ? { bankAccountNumber: form.bankAccountNumber } : {}),
          ...(form.bankAccountHolder ? { bankAccountHolder: form.bankAccountHolder } : {}),
          ...(form.welcomeMessage ? { welcomeMessage: form.welcomeMessage } : {}),
        },
      });
      qc.invalidateQueries({ queryKey: getListVendorsQueryKey() });
      toast({ title: "Vendor created", description: `${created.name} is live.` });
      navigate(`/vendors/${created.id}`);
    } catch (err) {
      toast({
        title: "Couldn't create vendor",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <Link href="/vendors" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ChevronLeft className="w-4 h-4" /> Back to vendors
      </Link>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">New vendor</h1>
        <p className="text-muted-foreground mt-1">Spin up a fresh business on the platform.</p>
      </div>

      <form onSubmit={submit}>
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>How customers will see this vendor in chat.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Business name</Label>
              <Input id="name" required value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Sunrise Pizza" />
            </div>
            <div className="grid gap-2 md:grid-cols-2 md:gap-4">
              <div className="grid gap-2">
                <Label htmlFor="phone">WhatsApp business number</Label>
                <Input id="phone" required value={form.phoneNumber} onChange={(e) => update("phoneNumber", e.target.value)} placeholder="+15551234567" />
                <p className="text-xs text-muted-foreground">The number customers see in chat.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="currency">Currency</Label>
                <Input id="currency" value={form.currency} onChange={(e) => update("currency", e.target.value.toUpperCase())} placeholder="USD" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Plan</Label>
              <RadioGroup value={form.plan} onValueChange={(v) => update("plan", v as "starter" | "pro")} className="grid grid-cols-2 gap-3">
                <PlanCard value="starter" current={form.plan} title="Starter" desc="Bot, menu, orders, manual bank-transfer payments." />
                <PlanCard value="pro" current={form.plan} title="Pro" desc="Adds analytics, follow-ups, customer memory, promotions." />
              </RadioGroup>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="welcome">Welcome message</Label>
              <Textarea id="welcome" rows={3} value={form.welcomeMessage} onChange={(e) => update("welcomeMessage", e.target.value)} placeholder="Welcome to Sunrise Pizza! Reply MENU to start." />
            </div>
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>WhatsApp routing</CardTitle>
            <CardDescription>Optional Meta WhatsApp Cloud API details. Leave blank to use the simulator only.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2 md:grid-cols-2 md:gap-4">
              <div className="grid gap-2">
                <Label htmlFor="botNumber">Bot display number</Label>
                <Input id="botNumber" value={form.botNumber} onChange={(e) => update("botNumber", e.target.value)} placeholder="+15551234567" />
                <p className="text-xs text-muted-foreground">Same as the business number unless you display a different one.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adminNumber">Vendor admin number</Label>
                <Input id="adminNumber" value={form.adminNumber} onChange={(e) => update("adminNumber", e.target.value)} placeholder="+15558881111" />
                <p className="text-xs text-muted-foreground">Vendor's personal WhatsApp. Receives order alerts and runs admin commands.</p>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="phoneNumberId">Meta phone_number_id</Label>
              <Input id="phoneNumberId" value={form.phoneNumberId} onChange={(e) => update("phoneNumberId", e.target.value)} placeholder="100000000000001" />
              <p className="text-xs text-muted-foreground">From Meta WhatsApp Manager. Used to route inbound webhooks to this vendor.</p>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Payments</CardTitle>
            <CardDescription>Bank details shown to customers when they confirm an order.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bankName">Bank name</Label>
              <Input id="bankName" value={form.bankName} onChange={(e) => update("bankName", e.target.value)} />
            </div>
            <div className="grid gap-2 md:grid-cols-2 md:gap-4">
              <div className="grid gap-2">
                <Label htmlFor="bankAcct">Account number</Label>
                <Input id="bankAcct" value={form.bankAccountNumber} onChange={(e) => update("bankAccountNumber", e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bankHolder">Account holder</Label>
                <Input id="bankHolder" value={form.bankAccountHolder} onChange={(e) => update("bankAccountHolder", e.target.value)} />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2 mt-6">
          <Button type="button" variant="ghost" onClick={() => navigate("/vendors")}>Cancel</Button>
          <Button type="submit" disabled={createVendor.isPending}>
            {createVendor.isPending ? "Creating..." : "Create vendor"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function PlanCard({ value, current, title, desc }: { value: string; current: string; title: string; desc: string }) {
  const selected = value === current;
  return (
    <Label
      htmlFor={`plan-${value}`}
      className={
        "flex flex-col gap-1 rounded-lg border p-3 cursor-pointer transition-all " +
        (selected ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "border-border hover-elevate")
      }
    >
      <div className="flex items-center gap-2">
        <RadioGroupItem id={`plan-${value}`} value={value} />
        <span className="font-semibold">{title}</span>
      </div>
      <p className="text-xs text-muted-foreground pl-6">{desc}</p>
    </Label>
  );
}

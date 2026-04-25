import { useState } from "react";
import {
  useGetVendor,
  useListVendorPromotions,
  useCreateVendorPromotion,
  useUpdateVendorPromotion,
  useDeleteVendorPromotion,
  getListVendorPromotionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tag, Sparkles, Trash2 } from "lucide-react";
import { Link } from "wouter";
import { format } from "date-fns";

export default function VendorPromotions({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const { data: vendor } = useGetVendor(vendorId, { query: { enabled: !!vendorId } });
  const { data: promos, isLoading } = useListVendorPromotions(vendorId, {
    query: { enabled: !!vendorId },
  });
  const create = useCreateVendorPromotion();
  const update = useUpdateVendorPromotion();
  const remove = useDeleteVendorPromotion();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const isPro = vendor?.plan === "pro";

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListVendorPromotionsQueryKey(vendorId) });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await create.mutateAsync({
      vendorId,
      data: { title: title.trim(), description: description.trim() || undefined, active: true },
    });
    setTitle("");
    setDescription("");
    invalidate();
  };

  const toggle = async (id: string, active: boolean) => {
    await update.mutateAsync({ vendorId, promotionId: id, data: { active } });
    invalidate();
  };

  const del = async (id: string) => {
    await remove.mutateAsync({ vendorId, promotionId: id });
    invalidate();
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Promotions</h1>
        <p className="text-muted-foreground mt-1">
          Active promotions are shown to customers when they ask for the menu.
        </p>
      </div>

      {!isPro && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50">
          <CardContent className="py-4 flex items-center gap-3 flex-wrap">
            <div className="h-10 w-10 rounded-full bg-amber-200 dark:bg-amber-900 flex items-center justify-center text-amber-700 dark:text-amber-300">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <h3 className="font-semibold text-sm">Promotions are a Pro feature</h3>
              <p className="text-xs text-muted-foreground">
                Upgrade {vendor?.name} to Pro to start running promotions.
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
          <CardTitle>Add a promotion</CardTitle>
          <CardDescription>Title and an optional one-line description.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              placeholder="e.g. Tuesday 2-for-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!isPro}
            />
            <Textarea
              placeholder="Buy any large pizza, get a second one free."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              disabled={!isPro}
            />
            <Button type="submit" disabled={!isPro || !title.trim() || create.isPending}>
              {create.isPending ? "Adding..." : "Add promotion"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-16 bg-muted animate-pulse rounded-xl" />)}
        </div>
      ) : !promos || promos.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 flex flex-col items-center text-center gap-3">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <Tag className="w-5 h-5" />
            </div>
            <h3 className="font-semibold">No promotions yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Add one above. You can also manage promotions over WhatsApp with <code>/promo add ...</code>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {promos.map((p) => (
            <Card key={p.id}>
              <CardContent className="py-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{p.title}</div>
                  {p.description && (
                    <p className="text-sm text-muted-foreground mt-1">{p.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Added {format(new Date(p.createdAt), "MMM d, yyyy")}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{p.active ? "Active" : "Off"}</span>
                    <Switch checked={p.active} onCheckedChange={(v) => toggle(p.id, v)} />
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => del(p.id)}
                    aria-label="Delete promotion"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

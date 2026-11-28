import type { APIRoute } from "astro";
import { getDB } from "../../../../../lib/db";

const ALLOWED_STATUS = [
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
] as const;
const ALLOWED_PAYMENT = ["unpaid", "paid", "refunded"] as const;

export const POST: APIRoute = async (ctx) => {
  if (!ctx.locals.admin) {
    return new Response("Unauthorized", { status: 401 });
  }
  // F-14: id 必須 alphanumeric + _ -,避免 path injection / SQL injection 攻擊
  const id = ctx.params.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return new Response("Invalid id", { status: 400 });
  }

  const form = await ctx.request.formData();
  const status = String(form.get("status") ?? "");
  const submittedPay = String(form.get("payment_status") ?? "");
  const trackingNumber = String(form.get("tracking_number") ?? "") || null;
  const notes = String(form.get("notes") ?? "") || null;

  if (!ALLOWED_STATUS.includes(status as never)) {
    return new Response("Invalid status", { status: 400 });
  }

  // Status→payment cascade:admin 沒明確選 payment_status 時,從 status 推預設。
  // admin 明確選的 payment_status 永遠贏過 cascade (per user 確認可手動覆蓋)。
  const PAYMENT_CASCADE = {
    pending: "unpaid",
    confirmed: "paid",
    shipped: "paid",
    delivered: "paid",
    cancelled: "refunded",
  } as const;
  const paymentStatus = ALLOWED_PAYMENT.includes(submittedPay as never)
    ? submittedPay
    : (PAYMENT_CASCADE[status as keyof typeof PAYMENT_CASCADE] ?? "unpaid");

  const db = getDB();
  const order = await db
    .prepare("SELECT status, items FROM orders WHERE id = ?")
    .bind(id)
    .first<{ status: string; items: string }>();
  if (!order) return new Response("Not found", { status: 404 });

  const need = new Map<string, number>();
  try {
    const arr = JSON.parse(order.items) as Array<{
      sku?: string;
      qty?: number;
    }>;
    if (Array.isArray(arr))
      for (const l of arr)
        if (l.sku)
          need.set(l.sku, (need.get(l.sku) ?? 0) + (Number(l.qty) || 0));
  } catch {
    /* items 格式異常:不動庫存 */
  }

  const wasCancelled = order.status === "cancelled";
  const willCancel = status === "cancelled";
  const updateOrder = (guard: string) =>
    db
      .prepare(
        `UPDATE orders SET status = ?, payment_status = ?, tracking_number = ?, notes = ?, updated_at = ? WHERE id = ? ${guard}`,
      )
      .bind(
        status,
        paymentStatus,
        trackingNumber,
        notes,
        Math.floor(Date.now() / 1000),
        id,
      )
      .run();
  const addStock = async (sign: 1 | -1) => {
    for (const [sku, q] of need)
      await db
        .prepare("UPDATE product_variants SET stock = stock + ? WHERE sku = ?")
        .bind(sign * q, sku)
        .run();
  };

  if (!wasCancelled && willCancel) {
    // 非取消 → 取消:只有成功改狀態的那一次才加回庫存(防重複按取消)
    const r = await updateOrder("AND status != 'cancelled'");
    if (r.meta?.changes) await addStock(1);
  } else if (wasCancelled && !willCancel) {
    // 取消 → 其他:重新扣庫存,庫存不足就拒絕
    const done: Array<[string, number]> = [];
    for (const [sku, q] of need) {
      const r = await db
        .prepare(
          "UPDATE product_variants SET stock = stock - ? WHERE sku = ? AND stock >= ?",
        )
        .bind(q, sku, q)
        .run();
      if (!r.meta?.changes) {
        for (const [s2, n2] of done)
          await db
            .prepare(
              "UPDATE product_variants SET stock = stock + ? WHERE sku = ?",
            )
            .bind(n2, s2)
            .run();
        return new Response(`Insufficient stock for ${sku}.`, { status: 400 });
      }
      done.push([sku, q]);
    }
    const r = await updateOrder("AND status = 'cancelled'");
    if (!r.meta?.changes) await addStock(1);
  } else {
    await updateOrder("");
  }

  return ctx.redirect(`/admin/orders/${id}`, 303);
};

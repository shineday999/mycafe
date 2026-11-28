import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { readCart, writeCart, removeFromCart } from "../../../lib/cart";

// 設定購物車內某個 (slug, sku) 的數量（絕對值）。
// qty = 0 視為移除；增加時檢查庫存（超過 → 400）。
export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData();
  const url = new URL(ctx.request.url);
  const g = (k: string) => form.get(k) ?? url.searchParams.get(k);
  const nextRaw = String(g("next") ?? "");
  const safeNext = /^\/(?!\/)[^\s\\]*$/.test(nextRaw) ? nextRaw : "/cart";
  const slug = String(g("slug") ?? "");
  const sku = String(g("sku") ?? "");
  let qty = parseInt(String(g("qty") ?? ""), 10);

  if (!slug) return new Response("Missing slug", { status: 400 });
  if (!Number.isFinite(qty) || qty < 0)
    return new Response("Invalid qty", { status: 400 });

  const items = readCart(ctx.request.headers.get("cookie"));
  const existing = items.find((i) => i.slug === slug && (i.sku ?? "") === sku);
  if (!existing) return ctx.redirect(safeNext, 303);

  let next;
  if (qty === 0) {
    next = removeFromCart(items, slug, sku || undefined);
  } else {
    if (env?.DB && sku) {
      const variant = await env.DB.prepare(
        "SELECT stock FROM product_variants WHERE sku = ?",
      )
        .bind(sku)
        .first<{ stock: number }>();
      if (!variant) return new Response("Invalid sku", { status: 400 });
      qty = Math.max(1, Math.min(qty, variant.stock));
    }
    next = items.map((i) => (i === existing ? { ...i, qty } : i));
  }

  ctx.cookies.set("mycafe_cart", writeCart(next), {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
    httpOnly: true,
  });

  return ctx.redirect(safeNext, 303);
};

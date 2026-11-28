import type { APIRoute } from "astro";
import { getDB, genId } from "../../../lib/db";
import { readCart } from "../../../lib/cart";
import {
  safe,
  sendEmailSafely,
  emailEnvFromContext,
  orderConfirmationEmail,
} from "../../../lib/email";

export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData();
  const name = String(form.get("customer_name") ?? "");
  const email = String(form.get("customer_email") ?? "");
  const phone = String(form.get("customer_phone") ?? "") || null;
  const country = String(form.get("country") ?? "");
  const city = String(form.get("city") ?? "");
  const address = String(form.get("address") ?? "");
  const postal = String(form.get("postal") ?? "");
  const notes = String(form.get("notes") ?? "") || null;

  if (!name || !email || !country || !city || !address) {
    return new Response("Missing required fields", { status: 400 });
  }

  const items = readCart(ctx.request.headers.get("cookie"));
  if (items.length === 0) {
    return new Response("Cart is empty", { status: 400 });
  }

  const db = getDB();
  const orderId = genId("ord");
  const now = Math.floor(Date.now() / 1000);
  const locale = ctx.locals.locale;

  // Wave 28.8: 算 TWD subtotal 從 product_prices + cart qty,
  // 同時將 price snapshot 寫進 items JSON(歷史價格穩定,不隨 product_prices 變動)。
  // 沒 SKU 的 item (legacy) 跳過,subtotal 不算。
  const skuList = items
    .map((i) => i.sku)
    .filter((s): s is string => Boolean(s));
  let priceMap = new Map<string, number>();
  if (skuList.length > 0) {
    const placeholders = skuList.map(() => "?").join(",");
    const priceRows = await db
      .prepare(
        `SELECT pv.sku, pp.amount AS price_cents
         FROM product_variants pv
         JOIN product_prices pp ON pp.variant_id = pv.id
         WHERE pv.sku IN (${placeholders}) AND pp.currency = 'TWD'`,
      )
      .bind(...skuList)
      .all<{ sku: string; price_cents: number }>();
    priceMap = new Map(
      (priceRows.results ?? []).map((r) => [r.sku, r.price_cents]),
    );
  }
  if (skuList.length > 0) {
    const ph = skuList.map(() => "?").join(",");
    const st = await db
      .prepare(`SELECT sku, stock FROM product_variants WHERE sku IN (${ph})`)
      .bind(...skuList)
      .all<{ sku: string; stock: number }>();
    const stockMap = new Map((st.results ?? []).map((r) => [r.sku, r.stock]));
    const totals = new Map<string, number>();
    for (const i of items)
      if (i.sku) totals.set(i.sku, (totals.get(i.sku) ?? 0) + i.qty);
    for (const [sku, q] of totals)
      if (q > (stockMap.get(sku) ?? 0))
        return new Response(`Insufficient stock for ${sku}.`, { status: 400 });
  }
  const enrichedItems = items.map((i) => ({
    ...i,
    priceCents: i.sku ? (priceMap.get(i.sku) ?? null) : null,
  }));
  const subtotalCents = enrichedItems.reduce(
    (sum, i) => sum + (i.priceCents ?? 0) * i.qty,
    0,
  );
  const subtotal = subtotalCents;
  const shippingFee = 0;
  const total = subtotal + shippingFee;

  const shippingAddress = JSON.stringify({ country, city, address, postal });
  const itemsJson = JSON.stringify(enrichedItems);

  await db
    .prepare(
      `INSERT INTO orders (id, customer_email, customer_name, customer_phone, shipping_address, locale, items, subtotal, currency, shipping_fee, total, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      orderId,
      email,
      name,
      phone,
      shippingAddress,
      locale,
      itemsJson,
      subtotal,
      "TWD",
      shippingFee,
      total,
      notes,
      now,
      now,
    )
    .run();

  // 清空 cart cookie
  ctx.cookies.set("mycafe_cart", "", { path: "/", maxAge: 0 });

  // 寄確認信給顧客、通知管理員。兩封一起等,寄信失敗不會讓訂單失敗(訂單已寫入資料庫)
  const itemsSummary = items.map((i) => `${i.slug} × ${i.qty}`).join(", ");
  const template = orderConfirmationEmail(orderId, name, itemsSummary);
  await Promise.all([
    sendEmailSafely(
      emailEnvFromContext(),
      {
        to: email,
        subject: template.subject,
        html: template.html,
        text: template.text,
        replyTo: "weider@0061qwen.cc.cd",
      },
      "order confirmation",
    ),
    sendEmailSafely(
      emailEnvFromContext(),
      {
        to: "weider@0061qwen.cc.cd",
        subject: `[New Order] ${orderId} from ${name}`,
        // 顧客輸入的內容一律先跳脫,避免 HTML 注入到管理員的信件
        html: `<p>${safe(name)} (${safe(email)}) placed a new order.</p><pre>${safe(JSON.stringify(items, null, 2))}</pre><p>Notes: ${safe(notes ?? "(none)")}</p>`,
        replyTo: email,
      },
      "order admin notification",
    ),
  ]);

  return ctx.redirect(`/checkout/success?id=${orderId}`, 303);
};

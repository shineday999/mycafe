import type { APIRoute } from "astro";
import { getDB, genId } from "../../../lib/db";
import { readCart } from "../../../lib/cart";
import { formatPrice } from "../../../lib/format";
import {
  safe,
  sendEmailSafely,
  emailEnvFromContext,
  orderConfirmationEmail,
  type OrderEmailRow,
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
  // 商品名稱 / 圖片(email 用)
  const detailMap = new Map<
    string,
    { name: string | null; slug: string; image?: string | undefined }
  >();
  if (skuList.length > 0) {
    const ph2 = skuList.map(() => "?").join(",");
    const origin = new URL(ctx.request.url).origin;
    const toAbs = (u?: string) =>
      u ? (u.startsWith("/") ? origin + u : u) : undefined;
    const firstImg = (j: unknown) => {
      if (typeof j !== "string" || !j) return undefined;
      try {
        const a = JSON.parse(j) as string[];
        return Array.isArray(a) && a.length > 0 ? a[0] : undefined;
      } catch {
        return undefined;
      }
    };
    const det = await db
      .prepare(
        `SELECT pv.sku, p.slug, pt.name, pv.image_urls AS vimg,
                (SELECT pv2.image_urls FROM product_variants pv2 WHERE pv2.product_id = p.id LIMIT 1) AS pimg
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         LEFT JOIN product_translations pt ON pt.product_id = p.id AND pt.locale = ?
         WHERE pv.sku IN (${ph2})`,
      )
      .bind(locale, ...skuList)
      .all<{
        sku: string;
        slug: string;
        name: string | null;
        vimg: string | null;
        pimg: string | null;
      }>();
    for (const r of det.results ?? []) {
      detailMap.set(r.sku, {
        name: r.name,
        slug: r.slug,
        image: toAbs(firstImg(r.vimg) ?? firstImg(r.pimg)),
      });
    }
  }

  // 扣庫存:只在 stock >= 數量 時才扣(原子更新,避免超賣);任一項失敗就整張退回
  const need = new Map<string, number>();
  for (const i of items)
    if (i.sku) need.set(i.sku, (need.get(i.sku) ?? 0) + i.qty);
  const decremented: Array<[string, number]> = [];
  for (const [sku, q] of need) {
    const r = await db
      .prepare(
        "UPDATE product_variants SET stock = stock - ? WHERE sku = ? AND stock >= ?",
      )
      .bind(q, sku, q)
      .run();
    if (!r.meta?.changes) {
      for (const [s2, n2] of decremented)
        await db
          .prepare(
            "UPDATE product_variants SET stock = stock + ? WHERE sku = ?",
          )
          .bind(n2, s2)
          .run();
      return new Response(`Insufficient stock for ${sku}.`, { status: 400 });
    }
    decremented.push([sku, q]);
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
  const emailRows: OrderEmailRow[] = enrichedItems.map((i) => {
    const d = i.sku ? detailMap.get(i.sku) : undefined;
    const unit = i.priceCents ?? 0;
    return {
      name: d?.name ?? d?.slug ?? i.slug,
      sku: i.sku,
      qty: i.qty,
      unit: formatPrice(unit, "TWD", locale),
      line: formatPrice(unit * i.qty, "TWD", locale),
      image: d?.image,
    };
  });
  const template = orderConfirmationEmail(
    orderId,
    name,
    itemsSummary,
    emailRows,
    formatPrice(total, "TWD", locale),
  );
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
        html: `<p>${safe(name)} (${safe(email)}${phone ? ", " + safe(phone) : ""}) placed a new order.</p><p>${safe(country)} ${safe(city)} ${safe(address)} ${safe(postal)}</p>${template.html}<p>Notes: ${safe(notes ?? "(none)")}</p>`,
        replyTo: email,
      },
      "order admin notification",
    ),
  ]);

  return ctx.redirect(`/checkout/success?id=${orderId}`, 303);
};

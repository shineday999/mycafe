// Email integration — Resend API
// 計畫書 Phase 5+ 改用 Cloudflare Email Service(原本是 Resend,但改用自有網域 0061qwen.cc.cd 的信箱)
// 需要在 CF Dashboard → Email → Sending 驗證 0061qwen.cc.cd 域 + 設 DKIM
// F-05: universal safe() HTML escape for email templates

import { env } from "cloudflare:workers";

interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
}

export interface EmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

const DEFAULT_FROM = "喝三杯咖啡 <weider@0061qwen.cc.cd>";
const DEFAULT_REPLY_TO = "weider@0061qwen.cc.cd";

// F-05: universal HTML escape — 所有 email template 插值都過 safe()
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export function safe(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export type EmailResult = { ok: boolean; id?: string; error?: string };

export async function sendEmail(
  env: EmailEnv,
  params: EmailParams,
): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY not set, skipping send");
    console.log(`[email] To: ${params.to}`);
    console.log(`[email] Subject: ${params.subject}`);
    return { ok: false, error: "no_credentials" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM ?? DEFAULT_FROM,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      text: params.text,
      reply_to: params.replyTo ?? env.EMAIL_REPLY_TO ?? DEFAULT_REPLY_TO,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[email] Resend error ${res.status}: ${body}`);
    return { ok: false, error: `resend_${res.status}` };
  }
  const data = (await res.json()) as { id?: string };
  return data.id ? { ok: true, id: data.id } : { ok: true };
}

/**
 * 寄信並「等到結果」(最多 timeoutMs 毫秒),任何錯誤都只記錄、絕不拋出:
 * 寄信失敗不能讓表單或訂單失敗。
 *
 * 為什麼不用 `void sendEmail(...)` 背景送出:Cloudflare 在回應送出後,
 * 沒有被等待的工作可能被中斷,信就寄不出去,而且完全沒有錯誤訊息。
 */
export async function sendEmailSafely(
  env: EmailEnv,
  params: EmailParams,
  label: string,
  timeoutMs = 8000,
): Promise<EmailResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<EmailResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: "timeout" }),
        timeoutMs,
      );
    });
    const result = await Promise.race([sendEmail(env, params), timeout]);
    if (!result.ok) {
      console.error(`[email] ${label} 寄送失敗: ${result.error}`);
    }
    return result;
  } catch (e) {
    console.error(`[email] ${label} 發生例外`, e);
    return { ok: false, error: "exception" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function emailEnvFromContext(): EmailEnv {
  return env ?? {};
}

export interface OrderEmailRow {
  name: string;
  sku?: string | undefined;
  qty: number;
  unit: string;
  line: string;
  image?: string | undefined;
}

export function orderConfirmationEmail(
  orderId: string,
  customerName: string,
  itemsSummary: string,
  rows: OrderEmailRow[] = [],
  total = "",
): { subject: string; html: string; text: string } {
  const subject = `預訂單確認 #${safe(orderId)}`;
  const rowsHtml = rows
    .map(
      (r) => `
      <tr>
        <td style="padding:12px 12px 12px 0;border-bottom:1px solid #e7dfda;width:84px;vertical-align:top;">
          ${r.image ? `<img src="${safe(r.image)}" width="72" height="72" alt="${safe(r.name)}" style="display:block;width:72px;height:72px;object-fit:cover;border-radius:8px;" />` : ""}
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #e7dfda;vertical-align:top;">
          <div style="font-weight:600;color:#322216;">${safe(r.name)}</div>
          ${r.sku ? `<div style="font-size:12px;color:#8A938A;margin-top:2px;">${safe(r.sku)}</div>` : ""}
          <div style="font-size:13px;color:#5b4e44;margin-top:4px;">${safe(r.unit)} × ${r.qty}</div>
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #e7dfda;text-align:right;vertical-align:top;white-space:nowrap;color:#322216;">${safe(r.line)}</td>
      </tr>`,
    )
    .join("");
  const table = rows.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:16px 0;">${rowsHtml}
        <tr>
          <td colspan="2" style="padding:12px 0;text-align:right;color:#5b4e44;">小計</td>
          <td style="padding:12px 0;text-align:right;font-weight:600;color:#322216;white-space:nowrap;">${safe(total)}</td>
        </tr>
      </table>`
    : `<p>${safe(itemsSummary)}</p>`;
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #322216; font-family: Georgia, serif;">感謝您的預訂</h2>
      <p>${safe(customerName)} 您好,</p>
      <p>我們已收到您的預訂單 <strong>${safe(orderId)}</strong>,內容如下:</p>
      ${table}
      <p>運費將於確認後另行通知。客服將在 1-2 個工作天內與您聯絡,確認運費與付款方式。</p>
      <hr style="border: none; border-top: 1px solid #e7dfda; margin: 24px 0;" />
      <p style="color: #8A938A; font-size: 12px;">
        喝三杯咖啡 · 精品咖啡 · weider@0061qwen.cc.cd
      </p>
    </div>
  `;
  const lines = rows.length
    ? rows.map((r) => `- ${r.name} × ${r.qty}  ${r.line}`).join("\n") +
      `\n小計 ${total}`
    : itemsSummary;
  const text = `感謝您的預訂 #${orderId}。${customerName} 您好,我們已收到您的預訂單:\n${lines}\n客服將在 1-2 個工作天內與您聯絡。`;
  return { subject, html, text };
}

export function contactNotificationEmail(
  name: string,
  email: string,
  message: string,
): { subject: string; html: string; text: string } {
  const subject = `新聯絡表單:${safe(name)}`;
  // F-05: 先 safe() 再 replace \n → <br>,避免 \n 注入 HTML
  const safeMessage = safe(message).replace(/\n/g, "<br>");
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #322216;">新訊息</h2>
      <p><strong>${safe(name)}</strong> (${safe(email)}) 留言:</p>
      <blockquote style="border-left: 3px solid #C9925B; padding-left: 12px; color: #5b4e44;">
        ${safeMessage}
      </blockquote>
      <p style="color: #8A938A; font-size: 12px;">Reply directly to this email to respond.</p>
    </div>
  `;
  const text = `新訊息 from ${name} (${email}): ${message}`;
  return { subject, html, text };
}

export function welcomeNewsletterEmail(
  email: string,
  locale: string,
  siteName: string,
): { subject: string; html: string; text: string } {
  // Wave 30.3: siteName 從 siteSettings 拿(4-tier fallback 在 caller 端算好傳入)
  const safeName = safe(siteName);
  const safeEmail = safe(email);
  const subjects: Record<string, string> = {
    "zh-Hant": `歡迎訂閱 ${safeName}`,
  };
  const bodies: Record<string, { html: string; text: string }> = {
    "zh-Hant": {
      html: `<p>${safeEmail} 您好,</p>
        <p>感謝訂閱 ${safeName}。我們會不定期寄出咖啡知識、新到的咖啡豆與沖煮小筆記。</p>
        <p>若您願意,也可以從 <a href="https://mycafe.de5.net/quiz">口味測驗</a> 開始,讓我們更瞭解您喜歡的風味。</p>
        <p>—— ${safeName}</p>`,
      text: `${email} 您好,感謝訂閱 ${safeName}。我們會不定期寄出咖啡知識、新到的咖啡豆與沖煮小筆記。`,
    },
  };
  const subject = subjects[locale] ?? subjects["zh-Hant"] ?? "";
  const body = bodies[locale] ?? bodies["zh-Hant"] ?? { html: "", text: "" };
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #322216; font-family: Georgia, serif;">${safeName}</h2>
      ${body.html}
      <hr style="border: none; border-top: 1px solid #e7dfda; margin: 24px 0;" />
      <p style="color: #8A938A; font-size: 12px;">
        ${safeName} · 精品咖啡知識與產品 · weider@0061qwen.cc.cd
      </p>
    </div>
  `;
  return { subject, html, text: body.text };
}

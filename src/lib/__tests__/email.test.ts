import { describe, it, expect, vi, afterEach } from "vitest";

// email.ts 會載入只有 Cloudflare 執行環境才有的模組,測試時換成假的
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { sendEmailSafely, safe } from "../email";

const params = { to: "a@b.tw", subject: "s", html: "<p>x</p>" };

afterEach(() => vi.restoreAllMocks());

describe("sendEmailSafely", () => {
  it("沒有金鑰時不拋出,回傳 no_credentials", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendEmailSafely({}, params, "test");
    expect(r).toEqual({ ok: false, error: "no_credentials" });
    expect(err).toHaveBeenCalled(); // 失敗一定會留下錯誤紀錄
  });

  it("寄信 API 失敗時不拋出,並記錄狀態碼", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    const r = await sendEmailSafely({ RESEND_API_KEY: "t" }, params, "test");
    expect(r).toEqual({ ok: false, error: "cf_email_403" });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("cf_email_403"));
  });

  it("網路例外時不拋出", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const r = await sendEmailSafely({ RESEND_API_KEY: "t" }, params, "test");
    expect(r).toEqual({ ok: false, error: "exception" });
  });

  it("逾時會放棄等待,不卡住使用者", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const r = await sendEmailSafely(
      { RESEND_API_KEY: "t" },
      params,
      "test",
      20,
    );
    expect(r).toEqual({ ok: false, error: "timeout" });
  });

  it("成功時回傳 ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: { id: "m1" } }), {
            status: 200,
          }),
      ),
    );
    const r = await sendEmailSafely({ RESEND_API_KEY: "t" }, params, "test");
    expect(r).toEqual({ ok: true, id: "m1" });
  });
});

describe("safe(跳脫)", () => {
  it("跳脫 HTML 特殊字元", () => {
    expect(safe('<img src=x onerror="a()">')).toBe(
      "&lt;img src=x onerror=&quot;a()&quot;&gt;",
    );
  });
});

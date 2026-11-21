import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const encoder = new TextEncoder();
const publishableKeys = Object.values(JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"));

function reply(message: string, status = 200) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function signupBucket(request: Request, key: string) {
  // Cloudflare assigns this header at the project edge. Use a shared bucket if it is unavailable.
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  const privateKey = await crypto.subtle.importKey(
    "raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", privateKey, encoder.encode(`quiz-register:${address}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return reply("仅支持注册请求。", 405);
  const clientKey = request.headers.get("apikey");
  if (!clientKey || !publishableKeys.includes(clientKey)) return reply("无法验证题库客户端。", 401);
  if (Number(request.headers.get("content-length")) > 2048) return reply("请求过长。", 413);

  let input;
  try {
    const body = await request.text();
    if (body.length > 2048) return reply("请求过长。", 413);
    input = JSON.parse(body);
  } catch {
    return reply("注册信息格式有误。", 400);
  }
  const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180 || password.length < 10) {
    return reply("请填写有效邮箱和至少 10 个字符的密码。", 400);
  }
  if (encoder.encode(password).length > 72) return reply("密码太长，请缩短后重试。", 400);

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!key || !url) return reply("注册服务暂不可用。", 503);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: permitted, error: limitError } = await admin.rpc("reserve_quiz_registration", {
    caller_digest: await signupBucket(request, key),
  });
  if (limitError) return reply("注册服务暂不可用。", 503);
  if (!permitted) return reply("注册请求过多，请稍后再试。", 429);

  // This app uses email as a sign-in identifier and does not send confirmation or reset mail.
  const { data: { user }, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { quiz_enrollment: "direct-email-v1" },
  });
  if (error?.code === "weak_password") return reply("请换一个更难猜的密码。", 400);
  if (error?.code === "email_exists" || error?.code === "user_already_exists") {
    return reply("无法用这个邮箱创建账号。如果注册过，请直接登录。", 409);
  }
  if (error || !user) return reply("暂时无法创建账号，请稍后重试。", 503);
  return reply("注册成功。");
});

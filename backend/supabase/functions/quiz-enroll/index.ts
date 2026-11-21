import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(message: string, status = 200) {
  return new Response(JSON.stringify({ message }), {
    status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return reply("仅支持注册请求。", 405);
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
  const code = typeof input?.code === "string" ? input.code.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180 ||
      password.length < 10 || password.length > 72 ||
      !/^[A-Za-z0-9_-]{43}$/.test(code)) {
    return reply("请填写有效邮箱、至少 10 位密码和邀请码。", 400);
  }

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!key || !url) return reply("注册服务暂不可用。", 503);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data: claimed, error: claimError } = await admin.rpc("claim_quiz_invite", { invite_digest: hash });
  if (claimError) return reply("注册服务暂不可用。", 503);
  if (!claimed) return reply("邀请码无效、已使用或已过期。", 403);

  const { data: { user }, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error || !user) return reply("账号未能建立。请检查邮箱是否已经注册，或联系邀请码提供者。", 409);
  const membership = await admin.from("quiz_members").insert({ account_id: user.id });
  if (membership.error) return reply("账号建立后暂无法激活同步，请联系邀请码提供者。", 503);
  return reply("注册成功。");
});

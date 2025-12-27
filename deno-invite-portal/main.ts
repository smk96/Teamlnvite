/// <reference lib="deno.unstable" />

import { Application, Router, Context } from "@oak/oak";
import { join, dirname, fromFileUrl } from "@std/path";
import { DB, Team } from "./lib/db.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));

const app = new Application();
const router = new Router();

// --- API Helpers ---

// Middleware for error handling
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: err instanceof Error ? err.message : "Internal Server Error" };
  }
});

// Middleware for Admin Auth
app.use(async (ctx, next) => {
  if (ctx.request.url.pathname.startsWith("/admin") || ctx.request.url.pathname.startsWith("/api/admin")) {
    const adminPassword = Deno.env.get("ADMIN_PASSWORD");
    if (adminPassword) {
      const unauthorized = () => {
        ctx.response.status = 401;
        ctx.response.headers.set("WWW-Authenticate", 'Basic realm="Admin Area"');
        ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
        ctx.response.body = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>需要认证</title>
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#f7f7f8; color:#202123; }
    .wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; }
    .card { background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:24px; box-shadow:0 6px 18px rgba(0,0,0,0.08); max-width:420px; text-align:center; }
    .title { font-size:18px; margin-bottom:8px; }
    .desc { font-size:13px; color:#6e6e80; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="title">需要管理员认证</div>
      <div class="desc">请输入正确的管理员密码后继续。</div>
    </div>
  </div>
</body>
</html>
        `;
      };

      const authHeader = ctx.request.headers.get("Authorization");
      if (!authHeader) {
        unauthorized();
        return;
      }
      const [type, credentials] = authHeader.split(" ");
      if (type !== "Basic") {
        unauthorized();
        return;
      }
      const decoded = atob(credentials);
      const [user, pass] = decoded.split(":");
      // Username can be anything, check password
      if (pass !== adminPassword) {
        unauthorized();
        return;
      }
    }
  }
  await next();
});

// Middleware for static files
app.use(async (ctx, next) => {
  if (ctx.request.url.pathname.startsWith("/static/")) {
    const root = __dirname;
    try {
      await ctx.send({ root });
      return;
    } catch {
      // Ignore
    }
  }
  await next();
});


// --- Business Logic Services ---

async function fetchTeamMembers(accessToken: string, accountId: string) {
  const url = `https://chatgpt.com/backend-api/accounts/${accountId}/users`;
  const headers = {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9",
    "authorization": `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  try {
    const res = await fetch(url, { headers });
    if (res.status === 401) throw new Error("Token expired");
    if (res.status !== 200) throw new Error(`API Error: ${res.status}`);
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    console.error("Fetch members error:", e);
    throw e;
  }
}

async function inviteToTeam(accessToken: string, accountId: string, email: string) {
  const url = `https://chatgpt.com/backend-api/accounts/${accountId}/invites`;
  const headers = {
    "accept": "*/*",
    "authorization": `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };
  
  const body = {
    email_addresses: [email],
    role: "standard-user",
    resend_emails: false
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (res.status !== 200 && res.status !== 201) {
    const text = await res.text();
    throw new Error(`Invite failed: ${res.status} - ${text}`);
  }
  return await res.json();
}

async function fetchPendingInvites(accessToken: string, accountId: string) {
  const url = `https://chatgpt.com/backend-api/accounts/${accountId}/invites`;
  const headers = {
    "accept": "*/*",
    "authorization": `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  const res = await fetch(url, { headers });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`Fetch invites failed: ${res.status} - ${text}`);
  }
  const data = await res.json();
  return data.items || [];
}

async function revokeInvite(accessToken: string, accountId: string, inviteId: string) {
  const baseUrl = `https://chatgpt.com/backend-api/accounts/${accountId}/invites/${inviteId}`;
  const headers = {
    "accept": "*/*",
    "authorization": `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  const attempts = [
    { url: baseUrl, method: "DELETE" },
    { url: `${baseUrl}/revoke`, method: "POST" },
    { url: `${baseUrl}/cancel`, method: "POST" }
  ];

  let lastStatus = 0;
  let lastText = "";
  for (const attempt of attempts) {
    const res = await fetch(attempt.url, {
      method: attempt.method,
      headers,
      body: attempt.method === "POST" ? "{}" : undefined
    });

    if (res.status === 200 || res.status === 204) {
      return true;
    }

    lastStatus = res.status;
    lastText = await res.text();

    if (res.status !== 405) {
      break;
    }
  }

  throw new Error(`Revoke invite failed: ${lastStatus} - ${lastText}`);
}

async function kickMember(accessToken: string, accountId: string, userId: string) {
  const url = `https://chatgpt.com/backend-api/accounts/${accountId}/users/${userId}`;
  const headers = {
    "accept": "*/*",
    "authorization": `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  const res = await fetch(url, { method: "DELETE", headers });
  if (res.status !== 200 && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Kick failed: ${res.status} - ${text}`);
  }
  return true;
}

async function createCheckoutLink(accessToken: string) {
  const url = "https://chatgpt.com/backend-api/payments/checkout";
  const headers = {
    "accept": "*/*",
    "authorization": `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  const payload = {
    plan_name: "chatgptteamplan",
    team_plan_data: {
      workspace_name: "time machine",
      price_interval: "month",
      seat_quantity: 5
    },
    promo_campaign: {
      promo_campaign_id: "team-1-month-free",
      is_coupon_from_query_param: true
    },
    checkout_ui_mode: "redirect"
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`Checkout failed: ${res.status} - ${text}`);
  }

  return await res.json();
}

// --- Routes ---

// 1. Pages
router.get("/", async (ctx) => {
  const html = await Deno.readTextFile(join(__dirname, "templates", "index.html"));
  ctx.response.body = html;
});

router.get("/admin", async (ctx) => {
  // Simple auth check (TODO: Real auth)
  const html = await Deno.readTextFile(join(__dirname, "templates", "admin.html"));
  ctx.response.body = html;
});

function formatExportDateTime(value: number | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// 2. Admin API - Teams
router.get("/api/admin/teams", async (ctx) => {
  const teams = await DB.listTeams();
  ctx.response.body = { success: true, teams };
});

router.get("/api/admin/teams/export", async (ctx) => {
  const teams = await DB.listTeams();
  const lines: string[] = [];
  lines.push("team备注名字\t有效期时间\tteam成员邮箱");

  for (const team of teams) {
    const createdAt = team.createdAt;
    const expiresAt = createdAt ? createdAt + 30 * 24 * 3600 * 1000 : undefined;
    const rangeText = createdAt && expiresAt
      ? `${formatExportDateTime(createdAt)} - ${formatExportDateTime(expiresAt)}`
      : "";

    let memberEmailsText = "";
    try {
      const members = await fetchTeamMembers(team.accessToken, team.accountId);
      const emails = (members || [])
        .map((m: any) => m?.email || m?.email_address || m?.user?.email || m?.user?.email_address || "")
        .map((e: string) => String(e).trim().toLowerCase())
        .filter(Boolean);
      memberEmailsText = emails.join(",");
    } catch (e) {
      memberEmailsText = `ERROR: ${e instanceof Error ? e.message : "fetch failed"}`;
    }

    lines.push(`${team.name}\t${rangeText}\t${memberEmailsText}`);
  }

  ctx.response.status = 200;
  ctx.response.headers.set("Content-Type", "text/plain; charset=utf-8");
  // Use ASCII filename plus RFC 5987 for UTF-8 to avoid ByteString errors.
  ctx.response.headers.set(
    "Content-Disposition",
    "attachment; filename=\"team-list.txt\"; filename*=UTF-8''team%E5%88%97%E8%A1%A8.txt"
  );
  ctx.response.body = lines.join("\n");
});

router.post("/api/admin/teams", async (ctx) => {
  const body = await ctx.request.body.json();
  const { name, session_data } = body;
  
  try {
    const session = JSON.parse(session_data);
    
    // Validate Session JSON
    // We prioritize checking for an explicit 'accountId' field,
    // because 'user.id' is often 'user-xxx' which is NOT a UUID and fails the API check.
    if (!session.accessToken) {
        ctx.response.status = 400;
        ctx.response.body = { success: false, error: "Invalid Session JSON: Missing accessToken" };
        return;
    }

    const accessToken = session.accessToken;
    // Prefer account.id (original Flask), then accountId, then user.id (may be user-xxx and invalid)
    const accountId = session.account?.id || session.accountId || session.user?.id;
    
    if (!accountId) {
       ctx.response.status = 400;
       ctx.response.body = { success: false, error: "Invalid Session JSON: Missing account.id, accountId or user.id" };
       return;
    }

    await DB.createTeam({
      name,
      accountId,
      accessToken,
      email: session.user?.email // Use optional chaining
    });
    ctx.response.body = { success: true };
  } catch (e) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid session data or team creation failed" };
  }
});

router.put("/api/admin/teams/:id/token", async (ctx) => {
  const id = ctx.params.id;
  const body = await ctx.request.body.json();
  const { session_data } = body;
  try {
    const session = JSON.parse(session_data);
    await DB.updateTeam(id, {
      accessToken: session.accessToken,
      tokenStatus: "active",
      tokenErrorCount: 0
    });
    ctx.response.body = { success: true };
  } catch (e) {
    ctx.response.body = { success: false, error: "Update failed" };
  }
});

router.delete("/api/admin/teams/:id", async (ctx) => {
  await DB.deleteTeam(ctx.params.id);
  ctx.response.body = { success: true };
});

router.get("/api/admin/teams/:id/members", async (ctx) => {
  const team = await DB.getTeam(ctx.params.id);
  if (!team) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Team not found" };
    return;
  }

  try {
    const members = await fetchTeamMembers(team.accessToken, team.accountId);
    const enrichedMembers = await Promise.all(
      (members || []).map(async (member: any) => {
        const rawEmail =
          member?.email ||
          member?.email_address ||
          member?.user?.email ||
          member?.user?.email_address ||
          "";
        const email = String(rawEmail).toLowerCase();
        if (!email) return member;
        const invite = await DB.getLatestInvitationByEmail(team.id, email);
        return {
          ...member,
          joined_at: invite?.createdAt || member?.created_at || null
        };
      })
    );
    ctx.response.body = { success: true, members: enrichedMembers };
  } catch (e) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: e instanceof Error ? e.message : "Failed to fetch members" };
  }
});

router.delete("/api/admin/teams/:id/members/:userId", async (ctx) => {
  const team = await DB.getTeam(ctx.params.id);
  if (!team) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Team not found" };
    return;
  }

  let email = "";
  try {
    if (ctx.request.hasBody) {
      const body = await ctx.request.body.json();
      email = body?.email || "";
    }
  } catch {
    // ignore body parse errors
  }

  try {
    await kickMember(team.accessToken, team.accountId, ctx.params.userId);
    if (email) {
      await DB.deleteInvitationsByEmail(team.id, email);
    }
    ctx.response.body = { success: true };
  } catch (e) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: e instanceof Error ? e.message : "Kick failed" };
  }
});

router.get("/api/admin/teams/:id/pending-invites", async (ctx) => {
  const team = await DB.getTeam(ctx.params.id);
  if (!team) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Team not found" };
    return;
  }

  try {
    const invites = await fetchPendingInvites(team.accessToken, team.accountId);
    ctx.response.body = { success: true, invites };
  } catch (e) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: e instanceof Error ? e.message : "Failed to fetch invites" };
  }
});

router.delete("/api/admin/teams/:id/pending-invites/:inviteId", async (ctx) => {
  const team = await DB.getTeam(ctx.params.id);
  if (!team) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Team not found" };
    return;
  }

  try {
    await revokeInvite(team.accessToken, team.accountId, ctx.params.inviteId);
    ctx.response.body = { success: true };
  } catch (e) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: e instanceof Error ? e.message : "Revoke failed" };
  }
});

async function handleAdminInvites(team: Team, emails: string[]) {
  const cleanEmails = emails.map((e) => String(e || "").trim()).filter(Boolean);
  const results = await Promise.all(
    cleanEmails.map(async (email) => {
      try {
        await inviteToTeam(team.accessToken, team.accountId, email);
        await DB.createInvitation({
          teamId: team.id,
          email,
          keyCode: "ADMIN_DIRECT",
          status: "success",
          isTemp: false,
          isConfirmed: false
        });
        return { email, success: true };
      } catch (e) {
        return { email, success: false, error: e instanceof Error ? e.message : "Invite failed" };
      }
    })
  );

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  if (successCount > 0) {
    await DB.updateTeam(team.id, { lastInviteAt: Date.now() });
  }

  return { results, successCount, failCount };
}

router.post("/api/admin/teams/:id/invite", async (ctx) => {
  const team = await DB.getTeam(ctx.params.id);
  if (!team) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Team not found" };
    return;
  }

  const body = await ctx.request.body.json();
  const email = body?.email;
  if (!email) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Email is required" };
    return;
  }

  try {
    const data = await handleAdminInvites(team, [email]);
    const ok = data.successCount > 0;
    ctx.response.body = { success: ok, ...data };
  } catch (e) {
    console.error("Direct invite error:", e);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: e instanceof Error ? e.message : "Invite failed" };
  }
});

router.post("/api/admin/teams/:id/invites", async (ctx) => {
  const team = await DB.getTeam(ctx.params.id);
  if (!team) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Team not found" };
    return;
  }

  const body = await ctx.request.body.json();
  const emails = Array.isArray(body?.emails) ? body.emails : [];
  if (!emails.length) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Emails are required" };
    return;
  }

  try {
    const data = await handleAdminInvites(team, emails);
    const ok = data.successCount > 0;
    ctx.response.body = { success: ok, ...data };
  } catch (e) {
    console.error("Direct invites error:", e);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: e instanceof Error ? e.message : "Invite failed" };
  }
});

// 3. Admin API - Keys
router.get("/api/admin/keys", async (ctx) => {
  const keys = await DB.listAccessKeys();
  ctx.response.body = { success: true, keys };
});

router.post("/api/admin/keys", async (ctx) => {
  const { count, is_unlimited } = await ctx.request.body.json();
  const createdKeys: any[] = [];

  for (let i = 0; i < (count || 1); i++) {
    // Generate random code
    const code = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    const key = await DB.createAccessKey({
      code,
      isTemp: false,
      isUnlimited: !!is_unlimited
    });
    createdKeys.push({ key_code: key.code, ...key });
  }

  ctx.response.body = { success: true, keys: createdKeys };
});

router.delete("/api/admin/keys/:code", async (ctx) => {
  const code = ctx.params.code;
  await DB.deleteAccessKey(code);
  ctx.response.body = { success: true };
});

router.post("/api/admin/checkout-link", async (ctx) => {
  try {
    const body = await ctx.request.body.json();
    const { session_data } = body;
    let accessToken = "";

    if (session_data) {
       // Use provided session data
       const session = JSON.parse(session_data);
       if (!session.accessToken) {
         ctx.response.status = 400;
         ctx.response.body = { success: false, error: "Invalid Session JSON: Missing accessToken" };
         return;
       }
       accessToken = session.accessToken;
    } else {
       // Fallback to active team in DB (Original behavior, kept for compatibility if needed)
       const teams = await DB.listTeams();
       const activeTeam = teams.find((t) => t.tokenStatus !== "expired");
       if (!activeTeam) {
        ctx.response.status = 400;
        ctx.response.body = { success: false, error: "Missing session_data and no active Team Token found" };
        return;
       }
       accessToken = activeTeam.accessToken;
    }

    const data = await createCheckoutLink(accessToken);
    ctx.response.body = { success: true, url: data.url };
  } catch (e) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: e instanceof Error ? e.message : "Checkout failed" };
  }
});

// 4. Join API
router.post("/api/join", async (ctx) => {
  const { email, key_code } = await ctx.request.body.json();
  
  if (!email || !key_code) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Missing fields" };
    return;
  }

  // 1. Validate Key
  const key = await DB.getAccessKey(key_code);
  if (!key) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid Key" };
    return;
  }

  // 2. Check if key is used (temp or unlimited keys can be reused)
  // Temp keys and special unlimited keys should allow multiple uses until no available team.
  if (!key.isUnlimited && !key.isTemp && key.usageCount > 0) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Key already used" };
    return;
  }

  // 3. Find Available Team (actively refresh member count + token status)
  const teams = await DB.listTeams();
  let selectedTeam: Team | null = null;
  const normalizedEmail = email.toLowerCase();

  for (const team of teams) {
    if (team.tokenStatus === "expired") continue;

    try {
      const members = await fetchTeamMembers(team.accessToken, team.accountId);
      const nonOwnerMembers = Array.isArray(members)
        ? members.filter((m: any) => m?.role !== "account-owner")
        : [];
      const memberCount = nonOwnerMembers.length;
      const refreshed = await DB.updateTeam(team.id, { memberCount, tokenStatus: "active" });

      const memberEmails = nonOwnerMembers
        .map((m: any) => String(m?.email || "").toLowerCase())
        .filter(Boolean);

      if (memberEmails.includes(normalizedEmail)) {
        const tempExpireAt = key.isTemp
          ? Date.now() + (key.tempHours || 24) * 3600000
          : undefined;

        await DB.createInvitation({
          teamId: refreshed.id,
          email,
          keyCode: key_code,
          status: "success",
          isTemp: key.isTemp,
          tempExpireAt,
          isConfirmed: false
        });

        await DB.incrementKeyUsage(key_code);

        ctx.response.body = {
          success: true,
          message: `✅ 您已是 ${refreshed.name} 团队成员！`,
          team_name: refreshed.name,
          email
        };
        return;
      }

      if (memberCount < 4 && !selectedTeam) {
        selectedTeam = refreshed;
      }
    } catch (err) {
      console.error("[Join] token expired or member fetch failed", err);
      await DB.updateTeam(team.id, { tokenStatus: "expired" });
    }
  }

  if (!selectedTeam) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "No available teams at the moment" };
    return;
  }

  // 4. Invite
  try {
    await inviteToTeam(selectedTeam.accessToken, selectedTeam.accountId, email);
    
    // 5. Update DB
    await DB.createInvitation({
      teamId: selectedTeam.id,
      email,
      keyCode: key_code,
      status: "success",
      isTemp: key.isTemp,
      tempExpireAt: key.isTemp ? Date.now() + (key.tempHours || 24) * 3600000 : undefined,
      isConfirmed: false
    });
    
    await DB.incrementKeyUsage(key_code);
    
    // Update team member count (cached)
    await DB.updateTeam(selectedTeam.id, { 
      memberCount: selectedTeam.memberCount + 1,
      lastInviteAt: Date.now()
    });

    ctx.response.body = { success: true, message: "Invitation sent! Check your email." };
  } catch (e) {
    // Handle specific errors (e.g. token expired during invite)
    console.error(e);
    if (e.message.includes("401") || e.message.includes("expired")) {
       await DB.updateTeam(selectedTeam.id, { tokenStatus: "expired" });
    }
    ctx.response.status = 500;
    // Expose the error message to help debug (e.g., 401, 404 from upstream)
    ctx.response.body = { success: false, error: `Invite failed: ${e.message}` };
  }
});

// 5. Auto Kick Config
router.get("/api/admin/auto-kick/config", async (ctx) => {
  const config = await DB.getAutoKickConfig();
  ctx.response.body = { success: true, config: {
    enabled: config.enabled,
    check_interval: config.checkInterval,
    start_hour: config.startHour,
    end_hour: config.endHour
  }};
});

router.post("/api/admin/auto-kick/config", async (ctx) => {
  const body = await ctx.request.body.json();
  await DB.setAutoKickConfig({
    enabled: body.enabled,
    checkInterval: body.check_interval,
    startHour: body.start_hour,
    endHour: body.end_hour
  });
  ctx.response.body = { success: true };
});

// --- Auto Kick Job (Deno Cron) ---

Deno.cron("Auto Kick Service", "*/5 * * * *", async () => {
  // Check config
  const config = await DB.getAutoKickConfig();
  if (!config.enabled) return;
  
  const now = new Date();
  const currentHour = now.getHours(); // Local time depends on server
  // Adjust for timezone if needed, assuming server time for now
  
  if (currentHour < config.startHour || currentHour > config.endHour) return;

  console.log("[AutoKick] Starting check...");
  
  // 1. Check Temp Invites Expiration
  const invites = await DB.listInvitations();
  for (const inv of invites) {
    if (inv.isTemp && !inv.isConfirmed && inv.tempExpireAt && Date.now() > inv.tempExpireAt && inv.status === 'success') {
      // Expired! Kick user.
      console.log(`[AutoKick] Expired invite: ${inv.email}`);
      const team = await DB.getTeam(inv.teamId);
      if (team) {
         try {
           const members = await fetchTeamMembers(team.accessToken, team.accountId);
           const member = members.find((m: any) => m.email === inv.email);
           if (member) {
             // DELETE /users/{id}
             // Implementation omitted for brevity, similar to invite
             // Log kick
           }
         } catch (e) {
           console.error(`[AutoKick] Failed to kick ${inv.email}`, e);
         }
      }
    }
  }

  // 2. Full Sync (Check illegal members)
  // ... (Implementation complexity omitted for this step, needs full logic)
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });

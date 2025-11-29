import { NextResponse } from "next/server";

// CORS — chỉ cho phép gọi từ frontend của m
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

// Ratelimit
const RATE_LIMIT = new Map();
const WINDOW_MS = 10_000; // 10 giây
const MAX_REQUESTS = 3;   // Mỗi IP chỉ được 3 req / 10 giây

// Hàm thêm CORS header
function withCors(res) {
  res.headers.set("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 200 }));
}

export async function POST(req) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("application/json"))
      return withCors(NextResponse.json({ ok: false, error: "Invalid content type" }, { status: 400 }));

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
    const ua = req.headers.get("user-agent") || "unknown";

    // RATE LIMIT
    const now = Date.now();
    const history = RATE_LIMIT.get(ip) || [];
    const recent = history.filter(t => now - t < WINDOW_MS);

    if (recent.length >= MAX_REQUESTS)
      return withCors(NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 }));

    recent.push(now);
    RATE_LIMIT.set(ip, recent);

    // JSON CHECK
    let body;
    try {
      body = await req.json();
    } catch {
      return withCors(NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }));
    }

    const { name, contact, message, turnstileToken } = body || {};

    if (!name || !contact || !message || !turnstileToken)
      return withCors(NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 }));

    // Clean dangerous characters
    function clean(x) {
      return String(x)
        .trim()
        .replace(/<[^>]*>/g, "")
        .slice(0, 500);
    }

    const cleanName = clean(name);
    const cleanContact = clean(contact);
    const cleanMessage = clean(message);

    // VERIFY TURNSTILE
    const tsRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET,
        response: turnstileToken,
        remoteip: ip
      })
    }).then(r => r.json());

    if (!tsRes.success)
      return withCors(NextResponse.json({ ok: false, error: "Bot detected" }, { status: 403 }));

    // SEND DISCORD MESSAGE
    const discordToken = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_CHANNEL_ID;

    if (!discordToken || !channelId) {
      console.error("Missing Discord configs");
      return withCors(NextResponse.json({ ok: false, error: "Server misconfig" }, { status: 500 }));
    }

    const discordRes = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bot ${discordToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content:
            `📩 **New Contact Message**\n\n` +
            `👤 **Name:** ${cleanName}\n` +
            `🔗 **Contact:** ${cleanContact}\n` +
            `💬 **Message:**\n${cleanMessage}\n\n` +
            `🌐 **IP:** ${ip}\n` +
            `🖥️ **UA:** ${ua}`
        }),
      }
    );

    if (!discordRes.ok) {
      console.error(await discordRes.text());
      return withCors(NextResponse.json({ ok: false, error: "Discord error" }, { status: 502 }));
    }

    return withCors(NextResponse.json({ ok: true }));

  } catch (err) {
    console.error(err);
    return withCors(NextResponse.json({ ok: false, error: "Server error" }, { status: 500 }));
  }
}


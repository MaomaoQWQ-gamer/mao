import { NextResponse } from "next/server";
const RATE_LIMIT = new Map();
const WINDOW_MS = 10_000; 
const MAX_REQUESTS = 3;   

export async function POST(req) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json({ ok: false, error: "Invalid content type" }, { status: 400 });
    }
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
    const ua = req.headers.get("user-agent") || "unknown";
    const now = Date.now();
    const history = RATE_LIMIT.get(ip) || [];
    const recent = history.filter((t) => now - t < WINDOW_MS);

    if (recent.length >= MAX_REQUESTS) {
      return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });
    }

    recent.push(now);
    RATE_LIMIT.set(ip, recent);
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    const { message, turnstileToken } = body || {};

    if (!message || typeof message !== "string" || !turnstileToken) {
      return NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 });
    }
    const tsRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET,
          response: turnstileToken,
          remoteip: ip
        }),
      }
    ).then((r) => r.json());

    if (!tsRes.success) {
      return NextResponse.json({ ok: false, error: "Bot detected" }, { status: 403 });
    }
    let cleanMsg = message.trim();
    cleanMsg = cleanMsg.replace(/<[^>]*>/g, "");
    if (cleanMsg.length > 500) {
      cleanMsg = cleanMsg.slice(0, 500) + " ...[truncated]";
    }

    if (cleanMsg.length === 0) {
      return NextResponse.json({ ok: false, error: "Empty message" }, { status: 400 });
    }
    const discordToken = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_CHANNEL_ID;

    if (!discordToken || !channelId) {
      console.error("Missing Discord env");
      return NextResponse.json({ ok: false, error: "Server misconfig" }, { status: 500 });
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
          content: `📩 **New message from contact form**\n\n` +
                   `**Message:** ${cleanMsg}\n` +
                   `**IP:** ${ip}\n` +
                   `**UA:** ${ua}`,
        }),
      }
    );

    if (!discordRes.ok) {
      console.error("Discord error", await discordRes.text());
      return NextResponse.json({ ok: false, error: "Discord error" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });

  } catch (err) {
    console.error("contact route error", err);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
export function GET() {
  return NextResponse.json({ ok: false, error: "Method not allowed" }, { status: 405 });
}

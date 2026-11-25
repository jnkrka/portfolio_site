/**
 * Kapcsolatfelvételi űrlap → Resend
 * Cloudflare Worker (ES module). A Resend API-kulcs CSAK itt, titkos változóként él,
 * soha nem kerül a weboldal kódjába.
 *
 * Beállítandó változók a Worker Settings → Variables and Secrets alatt:
 *   RESEND_API_KEY   (Secret)  – a Resend API-kulcs (Sending access elég)
 *   FROM_EMAIL       (Text)    – pl. "Jankovics Réka <hello@jankovicsreka.hu>"  (Resendben hitelesített domain!)
 *   TO_EMAIL         (Text)    – ide érkeznek az ajánlatkérések, pl. hello@jankovicsart.com
 *   TURNSTILE_SECRET (Secret, opcionális) – Cloudflare Turnstile titkos kulcs a spam ellen
 */

const ALLOWED_ORIGINS = [
  "https://jnkrka.github.io",
  "https://jankovicsreka.hu",
  "https://www.jankovicsreka.hu",
];

const TYPES = ["Arculat / logó", "Csomagolás", "Kiadvány / print", "Egyéb"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply({ ok: false, error: "method" }, 405);
    if (!allowed) return reply({ ok: false, error: "origin" }, 403);

    let d;
    try { d = await request.json(); } catch { return reply({ ok: false, error: "json" }, 400); }

    // Csapda-mező: ember nem tölti ki, a robotok igen → csendben eldobjuk
    if (d.website) return reply({ ok: true });

    const name = String(d.name || "").trim().slice(0, 100);
    const email = String(d.email || "").trim().slice(0, 200);
    const type = TYPES.includes(d.type) ? d.type : "Egyéb";
    const message = String(d.message || "").trim().slice(0, 5000);
    if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply({ ok: false, error: "invalid" }, 422);
    }

    if (env.TURNSTILE_SECRET) {
      const form = new FormData();
      form.append("secret", env.TURNSTILE_SECRET);
      form.append("response", String(d.turnstile || ""));
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) form.append("remoteip", ip);
      const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
        .then(r => r.json()).catch(() => ({ success: false }));
      if (!v.success) return reply({ ok: false, error: "captcha" }, 403);
    }

    const send = payload => fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const esc = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const nl = s => esc(s).replace(/\n/g, "<br>");

    // 1) Értesítés neked – a „Válasz” gomb egyből a küldőnek ír
    const notify = await send({
      from: env.FROM_EMAIL,
      to: [env.TO_EMAIL],
      reply_to: email,
      subject: `Új ajánlatkérés: ${name} (${type})`,
      html: `<p><strong>Név:</strong> ${esc(name)}<br><strong>E-mail:</strong> ${esc(email)}<br><strong>Téma:</strong> ${esc(type)}</p><p><strong>Üzenet:</strong><br>${nl(message)}</p>`,
      text: `Név: ${name}\nE-mail: ${email}\nTéma: ${type}\n\nÜzenet:\n${message}`,
    });
    if (!notify.ok) return reply({ ok: false, error: "send" }, 502);

    // 2) Visszaigazolás a küldőnek – fix szöveg, hogy ne lehessen visszaélni vele
    const first = name.split(/\s+/).pop().slice(0, 40);
    await send({
      from: env.FROM_EMAIL,
      to: [email],
      reply_to: env.TO_EMAIL,
      subject: "Megkaptam az üzeneted – Jankovics Réka",
      html: `<p>Kedves ${esc(first)}!</p><p>Köszönöm, hogy írtál! Megkaptam az ajánlatkérésed, és 48 órán belül válaszolok.</p><p>Üdvözlettel,<br>Jankovics Réka<br>tervezőgrafikus</p>`,
      text: `Kedves ${first}!\n\nKöszönöm, hogy írtál! Megkaptam az ajánlatkérésed, és 48 órán belül válaszolok.\n\nÜdvözlettel,\nJankovics Réka\ntervezőgrafikus`,
    }).catch(() => null);

    return reply({ ok: true });
  },
};

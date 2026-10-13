import { onRequestPost } from "./Site/functions/api/logements.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/logements") {
      if (request.method === "GET") {
        return new Response(JSON.stringify({
          ok: true,
          service: "CampusLogis API",
          route: "/api/logements",
          usage: "Envoyer une requête POST avec un JSON contenant city, par exemple {\"city\":\"Lyon\"}."
        }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
          }
        });
      }

      if (request.method === "POST") {
        return onRequestPost({ request });
      }

      return new Response(JSON.stringify({ error: "Méthode non autorisée." }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", "allow": "GET, POST" }
      });
    }

    return env.ASSETS.fetch(request);
  }
};

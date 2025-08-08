import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { getConnInfo } from "hono/cloudflare-workers";

import type { Solution } from "./cap";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use(secureHeaders());
app.use(cors()); // Adjust CORS settings as needed

app.use("/cap/*", async (c, next) => {
  if (c.env.ENV === "DEVELOPMENT") {
    // In development, skip rate limiting
    return next();
  }
  const info = getConnInfo(c);
  if (!info.remote.address) {
    return c.json(
      {
        success: false,
        error: "Cannot determine client IP address",
      },
      500
    );
  }
  const { success } = await c.env.CAP_RATE_LIMITER.limit({
    key: info.remote.address,
  });
  if (!success) {
    return c.json({ success: false, error: "Rate limit exceeded" }, 429);
  }
  return next();
});

app.post("/cap/challenge", async (c) => {
  try {
    const env = c.env;
    const id = env.CAP.idFromName("cap");
    const cap = env.CAP.get(id);
    const challenge = await cap.createChallenge();
    return c.json(challenge);
  } catch (error) {
    console.error("Error creating challenge:", error);
    return c.json({ success: false, error: "Failed to create challenge" }, 500);
  }
});

app.post("/cap/redeem", async (c) => {
  try {
    const { token, solutions } = (await c.req.json()) as Solution;

    if (!token || !solutions) {
      return c.json(
        { success: false, error: "Missing token or solutions" },
        400
      );
    }

    const env = c.env;
    const id = env.CAP.idFromName("cap");
    const cap = env.CAP.get(id);

    const answer = await cap.redeemChallenge({ token, solutions });

    return c.json(answer);
  } catch (error) {
    console.error("Error redeeming challenge:", error);
    return c.json({ success: false, error: "Failed to redeem challenge" }, 500);
  }
});

export default app;
export { CapDO } from "./cap/DurableObject";

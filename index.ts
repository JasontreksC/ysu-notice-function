import { Hono } from "hono";
import { handleNotice } from "./lib/handlers/notice.js";
import { handleSubscription } from "./lib/handlers/subscription.js";

const app = new Hono();

app.get("/api/notice", (c) => handleNotice(c.req.raw));
app.post("/api/subscription", (c) => handleSubscription(c.req.raw));

export default app;

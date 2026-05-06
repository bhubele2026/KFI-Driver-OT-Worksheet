import { Router } from "express";
import { eq } from "drizzle-orm";
import { LoginBody, RegisterBody } from "@workspace/api-zod";
import { db, schema } from "../lib/db.js";
import { hashPassword, verifyPassword } from "../lib/auth.js";

export const authRouter = Router();

authRouter.post("/auth/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const existing = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.email, email),
  });
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.password);
  const [user] = await db
    .insert(schema.usersTable)
    .values({ email, passwordHash })
    .returning();
  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email, createdAt: user.createdAt });
});

authRouter.post("/auth/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const user = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.email, email),
  });
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email, createdAt: user.createdAt });
});

authRouter.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("kfi.sid");
    res.status(204).end();
  });
});

authRouter.get("/auth/me", async (req, res) => {
  const id = req.session?.userId;
  if (!id) {
    res.json(null);
    return;
  }
  const user = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.id, id),
  });
  if (!user) {
    res.json(null);
    return;
  }
  res.json({ id: user.id, email: user.email, createdAt: user.createdAt });
});

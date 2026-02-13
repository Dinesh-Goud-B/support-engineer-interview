import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../trpc";
import { db } from "@/lib/db";
import { users, sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const authRouter = router({
  signup: publicProcedure
    .input(
      z.object({
        email: z
          .string()
          .trim()
          .email("Invalid Email Format")
          .transform((val) => val.toLowerCase()),
        password: z.string().min(8),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        phoneNumber: z.string().regex(/^\+?\d{10,15}$/),
        dateOfBirth: z.string(),
        ssn: z.string().regex(/^\d{9}$/),
        address: z.string().min(1),
        city: z.string().min(1),
        state: z.string().length(2).toUpperCase(),
        zipCode: z.string().regex(/^\d{5}$/),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.email, input.email))
        .get();

      if (existingUser) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "User already exists",
        });
      }

      const hashedPassword = await bcrypt.hash(input.password, 10);
      const hashedSsn = await bcrypt.hash(input.ssn, 9);

      const user = await db
        .insert(users)
        .values({
          ...input,
          password: hashedPassword,
          ssn: hashedSsn,
        })
        .returning();

      if (!user) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create user",
        });
      }

      const finalUser = user[0];

      const sessionToken = await createActiveSession(finalUser.id);

      // Set cookie
      if ("setHeader" in ctx.res) {
        ctx.res.setHeader(
          "Set-Cookie",
          `session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
        );
      } else {
        (ctx.res as Headers).set(
          "Set-Cookie",
          `session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
        );
      }

      return {
        user: { ...finalUser, password: undefined, ssn: undefined },
        sessionToken,
      };
    }),

  login: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const user = await db
        .select()
        .from(users)
        .where(eq(users.email, input.email))
        .get();

      if (!user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid credentials",
        });
      }

      const validPassword = await bcrypt.compare(input.password, user.password);

      if (!validPassword) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid credentials",
        });
      }

      const sessionToken = await createActiveSession(user.id);

      if ("setHeader" in ctx.res) {
        ctx.res.setHeader(
          "Set-Cookie",
          `session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
        );
      } else {
        (ctx.res as Headers).set(
          "Set-Cookie",
          `session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
        );
      }

      return { user: { ...user, password: undefined }, sessionToken };
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    // ✅ ALWAYS extract token - don't rely on ctx.user
    let token: string | undefined;

    // Method 1: cookies object (App Router)
    if ("cookies" in ctx.req && (ctx.req as any).cookies) {
      token = (ctx.req as any).cookies.session;
    }
    // Method 2: Parse cookie header manually (Pages Router)
    else {
      const cookieHeader =
        ctx.req.headers.get?.("cookie") || (ctx.req.headers as any)["cookie"];
      if (cookieHeader) {
        const sessionCookie = cookieHeader
          .split("; ")
          .find((c: string) => c.startsWith("session="));
        if (sessionCookie) {
          token = sessionCookie.split("=")[1];
        }
      }
    }

    console.log("Logout token found:", token ? "YES" : "NO"); // DEBUG

    // Delete session if token exists
    if (token) {
      try {
        const result = await deleteSessionByToken(token);
        console.log("Session deleted:", result); // DEBUG
      } catch (error) {
        console.error("Delete session error:", error); // DEBUG
      }
    }

    // Clear cookie
    if ("setHeader" in ctx.res) {
      ctx.res.setHeader(
        "Set-Cookie",
        `session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      );
    } else {
      (ctx.res as Headers).set(
        "Set-Cookie",
        `session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      );
    }

    return { success: true, message: "Logged out successfully" };
  }),
});

// ✅ HELPER FUNCTIONS - Sessions table ONLY
async function createActiveSession(userId: number): Promise<string> {
  const sessionToken = generateSecureToken(userId);

   // 1. Delete ALL existing sessions (simple, no transaction needed)
  await db.delete(sessions).where(eq(sessions.userId, userId));
  
  // 2. Insert new session
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24hrs
  await db.insert(sessions).values({
    userId,
    token: sessionToken,
    expiresAt: expiresAt.toISOString(),
  });
  return sessionToken;
}

async function deleteSessionByToken(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

function generateSecureToken(userId: number): string {
  return jwt.sign({ userId: userId }, process.env.JWT_SECRET || "temporary-secret-for-interview", {
        expiresIn: "24h"
      });
}

import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { users } from "./schema.js";

export type User = typeof users.$inferSelect;

export async function findUserByCognitoSub(db: Database, cognitoSub: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.cognitoSub, cognitoSub)).limit(1);
  return user;
}

/**
 * Crea el usuario la primera vez que entra (o lo devuelve si ya existe).
 * Seguro ante peticiones simultáneas gracias a ON CONFLICT.
 */
export async function upsertUser(db: Database, input: { cognitoSub: string; email?: string | null }): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ cognitoSub: input.cognitoSub, email: input.email ?? null })
    .onConflictDoUpdate({
      target: users.cognitoSub,
      set: { email: sql`coalesce(excluded.email, ${users.email})` },
    })
    .returning();
  return user!;
}

import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import type { AccountLink, UserRecord } from "@openrepso/sdk";
import { getServerConfig } from "./config";
import { hashPassword, isPasswordWithinPolicy, verifyPassword } from "./password";
import { SESSION_COOKIE, verifySessionToken } from "./session";
import { createRequestContext } from "./storage";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

// a well-formed scrypt envelope that never authenticates anyone; used to
// equalize the scrypt cost on the "oauth-only account" reject path so an
// attacker cannot learn account type from response time.
const DUMMY_HASH = `scrypt:16384:8:1:${"00".repeat(16)}:${"00".repeat(64)}`;

function deriveAuthSecret(): string {
  const config = getServerConfig();
  return createHmac("sha256", config.masterEncryptionKey).update("authjs-session-secret").digest("hex");
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

function decodeCookieValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

async function getOrCreateUserByProvider(
  provider: string,
  providerAccountId: string,
  email: string,
  name: string | null,
): Promise<UserRecord | null> {
  const context = await createRequestContext();
  try {
    const link = await context.storage.getAccountLink(provider, providerAccountId);
    if (link !== null) {
      const user = await context.storage.getUserById(link.userId);
      // a link can never name a missing user under the schema foreign key,
      // so this is corruption, not a retryable race: deny the sign-in.
      return user;
    }
    let user = await context.storage.getUserByEmail(email);
    if (user === null) {
      const candidate: UserRecord = {
        id: randomUUID(),
        email,
        passwordHash: null,
        name,
        createdAt: new Date().toISOString(),
      };
      try {
        await context.storage.createUser(candidate);
        user = candidate;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "DUPLICATE_EMAIL") return null;
        // a concurrent sign-in created the user between our read and insert:
        // refetch the winner and keep going.
        user = await context.storage.getUserByEmail(email);
        if (user === null) return null;
      }
    }
    const accountLink: AccountLink = {
      id: randomUUID(),
      userId: user.id,
      provider,
      providerAccountId,
      createdAt: new Date().toISOString(),
    };
    try {
      await context.storage.createAccountLink(accountLink);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "DUPLICATE_ACCOUNT") return null;
      // a concurrent sign-in for the same external identity won the insert;
      // the link now exists for this identity, resolve the owning user.
      const existing = await context.storage.getAccountLink(provider, providerAccountId);
      if (existing === null) return null;
      return (await context.storage.getUserById(existing.userId)) ?? null;
    }
    return user;
  } finally {
    await context.close();
  }
}

async function mergeGuestIntoAccount(accountUserId: string): Promise<void> {
  const store = await cookies();
  const guest = verifySessionToken(decodeCookieValue(store.get(SESSION_COOKIE)?.value));
  if (guest === null || guest.userId === accountUserId) return;
  const context = await createRequestContext();
  try {
    await context.storage.mergeOwner(guest.userId, accountUserId);
  } catch (err) {
    // failure degrades to a no-op, never a failed sign-in: the stale guest
    // cookie keeps owning its agents and a later merge can retry.
    console.error(`guest merge failed for ${guest.userId}: ${(err as Error).message}`);
  } finally {
    await context.close();
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: deriveAuthSecret(),
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/agents" },
  providers: [
    ...(() => {
      const config = getServerConfig();
      return config.googleClientId !== null && config.googleClientSecret !== null
        ? [
            Google({
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
            }),
          ]
        : [];
    })(),
    Credentials({
      id: "credentials",
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        try {
          const email = normalizeEmail(credentials?.email);
          const password = typeof credentials?.password === "string" ? credentials.password : "";
          if (email === null || !isPasswordWithinPolicy(password)) return null;
          const context = await createRequestContext();
          try {
            let user = await context.storage.getUserByEmail(email);
            if (user === null) {
              // self-service sign-up on first credentials sign-in: any
              // syntactically valid email can register with a password.
              const candidate: UserRecord = {
                id: randomUUID(),
                email,
                passwordHash: await hashPassword(password),
                name: null,
                createdAt: new Date().toISOString(),
              };
              try {
                await context.storage.createUser(candidate);
                user = candidate;
              } catch (err) {
                const code = (err as { code?: string }).code;
                if (code !== "DUPLICATE_EMAIL") return null;
                user = await context.storage.getUserByEmail(email);
                if (user === null) return null;
              }
            }
            const link = await context.storage.getAccountLink("credentials", user.id);
            if (link === null) {
              try {
                await context.storage.createAccountLink({
                  id: randomUUID(),
                  userId: user.id,
                  provider: "credentials",
                  providerAccountId: user.id,
                  createdAt: new Date().toISOString(),
                });
              } catch (err) {
                const code = (err as { code?: string }).code;
                if (code !== "DUPLICATE_ACCOUNT") return null;
              }
            }
            if (user.passwordHash === null) {
              // no password claim on an oauth-only account, and the dummy
              // scrypt keeps the reject path the same cost as a real check.
              await verifyPassword(password, DUMMY_HASH);
              return null;
            }
            const ok = await verifyPassword(password, user.passwordHash);
            if (!ok) return null;
            return { id: user.id, email: user.email, name: user.name ?? undefined };
          } finally {
            await context.close();
          }
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      if (account !== undefined && account !== null && user !== undefined) {
        let accountUserId: string | null = null;
        if (account.provider === "credentials") {
          accountUserId = typeof user.id === "string" ? user.id : null;
        } else {
          const email = normalizeEmail(user.email);
          if (email === null) return token;
          const resolved = await getOrCreateUserByProvider(
            account.provider,
            account.providerAccountId,
            email,
            user.name ?? null,
          );
          if (resolved === null) return token;
          accountUserId = resolved.id;
        }
        if (accountUserId !== null) {
          token.userId = accountUserId;
          // the merge runs only on the freshly created sign-in session (the
          // account arg is only present then), reading the guest id from
          // this request's own cookie, never from a parameter.
          await mergeGuestIntoAccount(accountUserId);
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = typeof token.userId === "string" ? token.userId : "";
      return session;
    },
  },
});
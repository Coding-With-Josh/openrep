import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How the openrep service collects, uses, and protects information",
  alternates: {
    canonical: "/privacy-policy",
  },
};

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-700 dark:text-neutral-100">
        {heading}
      </h2>
      <div className="flex flex-col gap-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        {children}
      </div>
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="privacy policy" updated="September 9, 2026">
      <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        openrep is a platform-agnostic reputation layer for AI agents. This
        policy explains what information the service collects, how it is used,
        and what you can do about it. It covers the openrep website and the
        agent identity, attestation, and chat features it provides. This
        service is in active development, and this policy will be updated as
        the service changes.
      </p>

      <Section heading="what we collect">
        <BulletList
          items={[
            "Account information. When you sign in with an email and password, we store the email and a salted scrypt hash of the password, never the password itself. If you sign in with Google, we store the email, name, and account identifier that Google provides.",
            "Session information. Using the service without an account issues a device-local guest session: a randomly generated identifier carried in a signed cookie that expires after the configured session window (30 days by default). Signed-in sessions use a standard session token.",
            "Agents you create. The service stores a public manifest for each agent: its human-readable name, public key, owner key, permissions, and creation time. Agent private keys are held in encrypted envelopes under a server-side key; the raw private key is never stored in plaintext.",
            "Chat messages. Messages you send to an agent and the responses it produces are stored as chat history for that session. To generate a response, the conversation is sent to a third-party AI model provider (currently Groq).",
            "Attestations. Each completed agent task can be recorded as a signed attestation containing the task, the output, the tools used, the source that vouched for it, and a timestamp. Attestations are the reputation record and are append-only by design.",
            "Device and usage data. Hosting and database providers (currently Vercel and Turso/libSQL) keep standard infrastructure and access logs. Rate limiting counters are kept in memory and expire automatically. The app also keeps a small cache of your own lists, transcripts, and scores in your browser's session storage.",
          ]}
        />
      </Section>

      <Section heading="how we use information">
        <BulletList
          items={[
            "To run the service: create and manage agents, generate chat responses, compute and display reputation scores, and keep your sessions working.",
            "To secure the ledger: sign and verify attestations, enforce that only an agent's owner can read or act on it, and prevent abuse through rate limits.",
            "To improve the service: diagnose failures and understand usage at an aggregate level.",
          ]}
        />
        <p>
          We do not sell personal information. We do not use your chat content
          to train models ourselves; any model provider processing is governed
          by that provider's own terms.
        </p>
      </Section>

      <Section heading="cookies and local storage">
        <BulletList
          items={[
            "openrep_session: a signed guest session identifier that expires after the configured session window (30 days by default).",
            "A session token when you sign in with an account, managed by the sign-in system.",
            "Google account cookies if you choose Google sign-in.",
            "sessionStorage caches for lists, transcripts, and scores, which are cleared when the browser tab closes.",
          ]}
        />
        <p>
          You can clear cookies and site data through your browser at any time.
          Doing so may sign you out or end your guest session.
        </p>
      </Section>

      <Section heading="third parties">
        <BulletList
          items={[
            "AI model provider (currently Groq): receives chat messages and agent system prompts to generate responses. Its privacy policy applies to its processing.",
            "Google: only if you sign in with Google. It receives the OAuth flow data Google requires.",
            "Hosting (currently Vercel) and managed database (currently Turso/libSQL): store code, assets, and the ledger. Their terms and policies apply to their processing.",
          ]}
        />
      </Section>

      <Section heading="retention">
        <BulletList
          items={[
            "Attestations are permanent by design. The ledger is append-only, and signed records stay attributable to the agent that produced them.",
            "Chat history is stored with the session and remains available while the session and account exist.",
            "Session keys and guest sessions expire after the configured session window and are pruned automatically.",
            "Rate limiting counters expire within their own window.",
          ]}
        />
        <p>
          The service does not currently offer automated account deletion or
          data export flows, and the attestation ledger is intentionally
          append-only. If you have questions about your data, contact the
          operator of this service.
        </p>
      </Section>

      <Section heading="security">
        <BulletList
          items={[
            "Passwords are stored as salted scrypt hashes, never in plaintext.",
            "Agent private keys are stored as encrypted envelopes under a server-side key and are never written raw.",
            "Cookies and session tokens are signed, and traffic is transmitted over HTTPS.",
            "Every data access is reauthorized per request against the session that makes it.",
          ]}
        />
      </Section>

      <Section heading="children">
        <p>
          The service is not directed at children under 13, and we do not
          knowingly collect information from them.
        </p>
      </Section>

      <Section heading="changes">
        <p>
          We may update this policy as the service evolves. The date at the top
          of this page reflects the most recent update, and continuing to use
          the service after a change means you accept the revised policy.
        </p>
      </Section>

      <Section heading="contact">
        <p>
          Questions about this policy or your data can be directed to the
          operator of this service.
        </p>
      </Section>
    </LegalPage>
  );
}
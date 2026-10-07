import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata = {
  title: "Privacy Policy · ClipFlow",
  alternates: { languages: { es: "/privacidad", en: "/en/privacy" } },
};

const mail = <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>;

export default function PrivacyPageEn() {
  return (
    <LegalPage
      doc="privacy"
      lang="en"
      title="Privacy Policy"
      intro={
        <p>
          This policy explains what data ClipFlow ({LEGAL.site}) collects, what it is used for and what rights you have. The data controller
          is {LEGAL.owner}, Costa Rica. Contact: {mail}.
        </p>
      }
      sections={[
        {
          title: "Data we collect",
          body: (
            <ul>
              <li>
                <strong>Account:</strong> your email address and your password (stored encrypted; we never see it).
              </li>
              <li>
                <strong>Your content:</strong> the videos you upload or import with a link, the links you paste, the generated clips,
                transcripts and captions.
              </li>
              <li>
                <strong>Service usage:</strong> which videos you processed, their length, the minutes used and technical logs (for example,
                errors) to keep the service running.
              </li>
              <li>
                <strong>Payments:</strong> handled by Paddle. We never receive or store your card details; we only know your plan and whether
                the payment succeeded.
              </li>
            </ul>
          ),
        },
        {
          title: "How we use it",
          body: (
            <ul>
              <li>To provide the service: store your videos, analyze them and create your clips.</li>
              <li>To manage your account, your plan and your minutes.</li>
              <li>To give you support and notify you of important changes.</li>
              <li>To keep the service secure and prevent abuse.</li>
            </ul>
          ),
        },
        {
          title: "What we don't do",
          body: (
            <ul>
              <li>We do not sell your data or share it with advertisers.</li>
              <li>We do not publish your videos or use them to train artificial intelligence models.</li>
              <li>We do not use advertising or tracking cookies. We only use the cookies needed to keep you signed in.</li>
            </ul>
          ),
        },
        {
          title: "Who we share data with",
          body: (
            <>
              <p>Only with providers we need to run the service, and only what is necessary:</p>
              <ul>
                <li>
                  <strong>Amazon Web Services (AWS):</strong> hosts the app, the database and your files, on servers in the United States.
                </li>
                <li>
                  <strong>OpenAI:</strong> receives the audio of your videos to transcribe it and the transcript text to pick the best moments
                  and suggest titles. Under its business terms,
                  it does not use this data to train its models.
                </li>
                <li>
                  <strong>Paddle:</strong> processes payments as Merchant of Record.
                </li>
                <li>
                  <strong>Network provider for link imports:</strong> when a platform blocks imports from our servers, the video is requested
                  through a network intermediary, which only sees the link.
                </li>
              </ul>
              <p>We may also disclose data when required by law by a competent authority.</p>
            </>
          ),
        },
        {
          title: "How long we keep it",
          body: (
            <ul>
              <li>Your videos, clips and transcripts: until you delete them or delete your account.</li>
              <li>Database backups are deleted automatically after 7 days; technical logs, after 30 days.</li>
              <li>
                Payment and minute records are kept for as long as the law requires, separated from your email once you delete your account.
              </li>
            </ul>
          ),
        },
        {
          title: "Your rights",
          body: (
            <>
              <p>
                Under Costa Rica&apos;s Law on the Protection of Individuals with regard to the Processing of their Personal Data (Law 8968)
                and other applicable laws, you can:
              </p>
              <ul>
                <li>Access your data and request a copy.</li>
                <li>Correct it if it is wrong.</li>
                <li>Delete it: you can delete videos or your whole account from the app, or ask us to.</li>
                <li>Object to a specific use or withdraw your consent.</li>
              </ul>
              <p>Email us at {mail}; we reply within 10 business days.</p>
            </>
          ),
        },
        {
          title: "Security",
          body: (
            <p>
              Your data travels encrypted (HTTPS) and is stored encrypted. Only our system accesses your files, through temporary links that
              expire within minutes.
            </p>
          ),
        },
        {
          title: "Children",
          body: <p>ClipFlow is not intended for people under 18 and we do not knowingly collect data from minors.</p>,
        },
        {
          title: "Changes to this policy",
          body: <p>If we make material changes, we will notify you in the app or by email before they take effect.</p>,
        },
      ]}
    />
  );
}

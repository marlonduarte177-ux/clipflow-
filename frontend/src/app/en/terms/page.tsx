import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata = {
  title: "Terms of Service · ClipFlow",
  alternates: { languages: { es: "/terminos", en: "/en/terms" } },
};

const mail = <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>;

export default function TermsPageEn() {
  return (
    <LegalPage
      doc="terms"
      lang="en"
      title="Terms of Service"
      intro={
        <p>
          These terms govern your use of ClipFlow ({LEGAL.site}), a service provided by {LEGAL.owner}, based in Costa Rica. By creating an
          account or using the service, you agree to these terms. If you do not agree, do not use ClipFlow.
        </p>
      }
      sections={[
        {
          title: "The service",
          body: (
            <p>
              ClipFlow is an AI-powered video editor: it analyzes the videos you upload (or import with a link to a video of yours) and
              creates short vertical clips with captions, ready to post on social media.
            </p>
          ),
        },
        {
          title: "Your account",
          body: (
            <ul>
              <li>You must be at least 18 years old, or the age of majority in your country, to create an account.</li>
              <li>You are responsible for keeping your password secure and for any activity under your account.</li>
              <li>You can delete your account at any time from the Account page; your videos, clips and transcripts are deleted.</li>
            </ul>
          ),
        },
        {
          title: "Your content and copyright",
          body: (
            <>
              <ul>
                <li>
                  You may only use videos that you own or have permission to use. By uploading or importing a video, you confirm that you
                  have those rights.
                </li>
                <li>You keep all rights to your videos and to the clips you create.</li>
                <li>
                  You allow us to store and process your videos only to provide the service (analyze, transcribe and create your clips). We
                  do not publish them or use them for any other purpose.
                </li>
              </ul>
              <p>If you believe someone used your content on ClipFlow without permission, email us at {mail} and we will review it.</p>
            </>
          ),
        },
        {
          title: "Prohibited uses",
          body: (
            <ul>
              <li>Using other people&apos;s content without permission or content that infringes copyright or image rights.</li>
              <li>Illegal content, child sexual abuse material, extreme violence, hate speech or content that harasses others.</li>
              <li>Trying to bypass the service limits, attacking the service, automating it abusively or reselling access.</li>
            </ul>
          ),
        },
        {
          title: "Plans, payments and renewal",
          body: (
            <>
              <ul>
                <li>
                  <strong>Trial:</strong> USD {LEGAL.trial.priceUsd} for {LEGAL.trial.days} days, with {LEGAL.trial.minutes} minutes of
                  video. When it ends, it automatically converts to the Pro plan unless you cancel before.
                </li>
                <li>
                  <strong>Pro:</strong> USD {LEGAL.pro.priceUsd} per month, with {LEGAL.pro.minutes} minutes of video per month. It renews
                  every month until you cancel.
                </li>
                <li>Minutes are deducted based on the length of each processed video and do not roll over to the next month.</li>
                <li>You can cancel at any time and keep access until the end of the period you already paid for.</li>
                <li>Prices may include taxes depending on your country. We will notify you in advance of any price change.</li>
              </ul>
              <p>
                Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders.
                Paddle provides all customer service inquiries and handles returns.
              </p>
            </>
          ),
        },
        {
          title: "Refunds",
          body: (
            <p>
              See our <Link href="/en/refunds">Refund Policy</Link>.
            </p>
          ),
        },
        {
          title: "Usage limits",
          body: (
            <p>
              To keep the service working well for everyone, there are usage limits (for example, videos up to 3 hours long and a daily
              maximum per user). The app tells you when you reach one.
            </p>
          ),
        },
        {
          title: "AI-generated results",
          body: (
            <p>
              Clips, titles, captions and transcripts are generated automatically and may contain mistakes. Review them before posting: you
              decide what you publish and you are responsible for it.
            </p>
          ),
        },
        {
          title: "Availability and changes",
          body: (
            <p>
              We work to keep ClipFlow available at all times, but there may be interruptions. We may improve or change features. If we make
              material changes to these terms, we will notify you in the app or by email before they take effect.
            </p>
          ),
        },
        {
          title: "Account suspension",
          body: (
            <p>
              We may suspend or close accounts that breach these terms, especially for copyright infringement or prohibited uses. If you
              think it was a mistake, email us at {mail}.
            </p>
          ),
        },
        {
          title: "Liability",
          body: (
            <p>
              ClipFlow is provided &quot;as is&quot;. To the extent permitted by law, we are not liable for indirect damages or loss of
              content, and our total liability is limited to the amount you paid in the last 3 months. Keep a copy of your original videos.
            </p>
          ),
        },
        {
          title: "Governing law",
          body: (
            <p>
              These terms are governed by the laws of the Republic of Costa Rica. This does not limit any rights you have under the consumer
              protection laws of your country.
            </p>
          ),
        },
        {
          title: "Contact",
          body: <p>For any questions: {mail}.</p>,
        },
      ]}
    />
  );
}

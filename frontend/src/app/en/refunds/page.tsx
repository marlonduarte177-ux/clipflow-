import { LegalPage } from "@/components/legal-page";
import { LEGAL } from "@/lib/legal";

export const metadata = {
  title: "Refund Policy · ClipFlow",
  alternates: { languages: { es: "/reembolsos", en: "/en/refunds" } },
};

const mail = <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>;
const { days, maxMinutesUsed } = LEGAL.refund;

export default function RefundsPageEn() {
  return (
    <LegalPage
      doc="refunds"
      lang="en"
      title="Refund Policy"
      intro={
        <p>
          We want you to try ClipFlow risk-free. If it is not for you, we will refund you within {days} days of the charge, as long as you
          have not processed more than {maxMinutesUsed} minutes of video since that charge.
        </p>
      }
      sections={[
        {
          title: "When you are eligible for a refund",
          body: (
            <ul>
              <li>You request it within {days} calendar days of the charge (the trial or a monthly payment).</li>
              <li>Since that charge, you have processed at most {maxMinutesUsed} minutes of video.</li>
              <li>We refund 100% of that charge, to the same payment method.</li>
            </ul>
          ),
        },
        {
          title: "When it does not apply",
          body: (
            <ul>
              <li>More than {days} days have passed since the charge.</li>
              <li>You have processed more than {maxMinutesUsed} minutes of video since the charge.</li>
              <li>The account was suspended for breaching the Terms of Service.</li>
            </ul>
          ),
        },
        {
          title: "If the service fails",
          body: (
            <p>
              If a video could not be processed because of an error on our side, the minutes are returned to your account automatically and
              do not count toward this limit. If ClipFlow did not work and you could not use it, email us even after the deadline: we review
              each case.
            </p>
          ),
        },
        {
          title: "How to request it",
          body: (
            <p>
              Email us at {mail} with your account email, or reply to the purchase receipt sent by Paddle. Paddle.com is the Merchant of
              Record for our orders and issues the refund. It usually shows up in your account within 5 to 10 business days, depending on
              your bank.
            </p>
          ),
        },
        {
          title: "Cancelling your subscription",
          body: (
            <p>
              You can cancel at any time so it does not renew. Cancelling does not trigger an automatic refund: you keep access until the end
              of the paid period. If you also meet the conditions above, you can request a refund.
            </p>
          ),
        },
        {
          title: "Consumer rights",
          body: <p>This policy does not limit any rights you have under the consumer protection laws of your country.</p>,
        },
      ]}
    />
  );
}

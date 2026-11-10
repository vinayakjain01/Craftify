import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'

const SUPPORT_EMAIL = 'vinayak@growify.in'

export const metadata = { title: 'Privacy Policy — Craftify' }

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy" updatedAt="November 2026">
      <LegalSection heading="Overview">
        <p>
          Craftify is a Shopify app that turns a store&apos;s product photos into catalog and ad
          creatives — automatically assigning a design template to each product, generating the
          images, and building a product feed for Meta (Facebook/Instagram) Commerce. This policy
          explains what data we collect to do that, who we share it with, and how to get it
          deleted.
        </p>
      </LegalSection>

      <LegalSection heading="Information we collect">
        <p><strong>Account information.</strong> If you sign in with email and password, we store
          that email address. If you sign in with Google, we store the email and name your Google
          account provides. If you install Craftify directly from Shopify without signing in
          first, we create your account automatically using the contact email Shopify gives us for
          your store.</p>
        <p><strong>Store and catalog data.</strong> Craftify requests three read-only Shopify
          access scopes — <code>read_products</code>, <code>read_inventory</code>, and{' '}
          <code>read_locations</code> — and uses them to import your product titles,
          descriptions, prices, variants, images, and stock status, plus your shop&apos;s name,
          domain, and currency. We request nothing beyond this: Craftify has no access to your
          customers, their personal information, your orders, or any payment details, and no
          Shopify scope we hold could grant that access.</p>
        <p><strong>Content you create in Craftify.</strong> The templates you design (including
          any logo or decorative image you upload), the rules you set up to match products to
          templates, and the creative images Craftify generates from your catalog.</p>
      </LegalSection>

      <LegalSection heading="How we use this information">
        <ul style={{ margin: '0 0 0 20px', padding: 0 }}>
          <li>To sync your product catalog and keep it up to date</li>
          <li>To generate creative images from your products using your templates and rules</li>
          <li>To build the Meta Commerce Feed URL that your store&apos;s catalog data is published
            through, if you choose to connect it to Meta</li>
          <li>To authenticate you and keep your account and store connection secure</li>
          <li>To respond to support requests</li>
        </ul>
        <p>We do not sell your data, and we do not use it for advertising or profiling.</p>
      </LegalSection>

      <LegalSection heading="Who we share it with">
        <p>
          We use a small number of service providers to run Craftify. Each only receives the data
          it needs to perform its specific function:
        </p>
        <ul style={{ margin: '0 0 0 20px', padding: 0 }}>
          <li><strong>Supabase</strong> — our database and authentication provider; stores your
            account, store connection, catalog data, templates, rules, and generated creatives.</li>
          <li><strong>Cloudinary</strong> — hosts and serves the images Craftify generates, and any
            logo or design asset you upload to a template.</li>
          <li><strong>An AI background-removal provider</strong> (currently fal.ai, with Clipdrop
            and Remove.bg available as alternatives) — if you use Craftify&apos;s AI Product Mode,
            the specific product photo you&apos;re working with is sent to this provider solely to
            remove its background; it is not used to train any model and is not retained by
            Craftify beyond the result.</li>
          <li><strong>Vercel</strong> and <strong>DigitalOcean</strong> — host the Craftify
            application and run the background jobs that generate your creatives.</li>
        </ul>
        <p>
          We don&apos;t share your data with anyone else, and none of these providers may use it
          for their own purposes.
        </p>
        <p>
          <strong>Meta Commerce Feed.</strong> If you set up the Meta feed integration, Craftify
          publishes a feed URL containing your in-stock catalog data (and the creatives generated
          for it) for Meta to read. This is data you choose to make available to Meta for your own
          advertising — Craftify doesn&apos;t separately send it to Meta on your behalf, and the
          feed only ever reflects your own store&apos;s products.
        </p>
      </LegalSection>

      <LegalSection heading="Cookies">
        <p>
          Craftify uses a small number of strictly functional cookies: to keep you signed in, to
          remember which connected store you&apos;re viewing, and briefly during the Shopify
          connection process itself. We don&apos;t use advertising or analytics cookies, and we
          don&apos;t track you across other sites or apps.
        </p>
      </LegalSection>

      <LegalSection heading="Security">
        <p>
          Data is encrypted in transit (TLS) between your browser, Shopify, and Craftify. Your
          Shopify access token is encrypted at rest in our database. Every merchant&apos;s data is
          isolated at the database level, so one store&apos;s catalog, templates, and creatives are
          never visible to another.
        </p>
      </LegalSection>

      <LegalSection heading="Data retention and deletion">
        <p>
          Uninstalling Craftify from your Shopify admin immediately stops all background
          processing on your store. Shopify then notifies us to permanently erase your store&apos;s
          data — catalog records, templates, rules, and generated creatives — which we do
          automatically within 48 hours of uninstall, with no action required from you.
        </p>
        <p>
          Because Craftify never holds customer-level personal data in the first place (no order
          or customer scopes are ever requested), Shopify&apos;s mandatory customer data-request
          and data-erasure webhooks have nothing of yours to return or redact — there&apos;s simply
          nothing there.
        </p>
        <p>
          To request deletion sooner than the automatic 48-hour window, or to ask any question
          about your data, email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#4B2E83' }}>{SUPPORT_EMAIL}</a>.
        </p>
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>
          You can ask us at any time what data we hold about your store, correct it, or have it
          deleted — email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#4B2E83' }}>{SUPPORT_EMAIL}</a>{' '}
          and we&apos;ll respond within a few business days. Depending on where you&apos;re
          located, you may also have specific rights under laws like the GDPR or CCPA — the same
          contact gets you the same response regardless of where you&apos;re writing from.
        </p>
      </LegalSection>

      <LegalSection heading="International data transfers">
        <p>
          Our service providers host infrastructure in multiple countries. Wherever your data is
          processed, it&apos;s handled under the same protections described in this policy.
        </p>
      </LegalSection>

      <LegalSection heading="Children's privacy">
        <p>
          Craftify is a business tool for Shopify merchants and isn&apos;t directed at children.
          We don&apos;t knowingly collect data from anyone under 16.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to this policy">
        <p>
          If we make a material change to how we handle your data, we&apos;ll update the date at
          the top of this page and, where appropriate, let you know directly.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about this policy: <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#4B2E83' }}>{SUPPORT_EMAIL}</a>.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}

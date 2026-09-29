import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'

// TODO before submitting to the Shopify App Store: replace this placeholder
// with Craftify's real support address — Shopify's review checks that this
// resolves to an inbox someone actually reads.
const SUPPORT_EMAIL = 'support@craftify.app'

export const metadata = { title: 'Privacy Policy — Craftify' }

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy" updatedAt="September 2026">
      <LegalSection heading="What we collect">
        <p>
          When you install Craftify, we access your Shopify store&apos;s product catalog —
          titles, descriptions, prices, variants, images, and inventory status — so we can
          generate catalog creatives and build your Meta product feed. We also store your
          store&apos;s domain and an access token Shopify issues us, which we use to keep your
          catalog in sync.
        </p>
        <p>
          If you sign in with email or Google, we store the email address and, for Google
          sign-in, the name associated with that account.
        </p>
      </LegalSection>

      <LegalSection heading="How we store it">
        <p>
          Store and catalog data is kept in our database (Supabase), access-controlled so one
          merchant&apos;s data is never visible to another. Generated creative images are hosted on
          Cloudinary. Access tokens are encrypted at rest.
        </p>
      </LegalSection>

      <LegalSection heading="What we don't do">
        <p>
          We don&apos;t sell your data. We don&apos;t access your customers&apos; personal information —
          Craftify works with product and catalog data only, not customer records or orders.
        </p>
      </LegalSection>

      <LegalSection heading="Data deletion">
        <p>
          Uninstalling Craftify from your Shopify admin immediately stops all background
          processing on your store. Shopify then notifies us to permanently erase your store&apos;s
          data — catalog records, generated creatives, and templates — which happens
          automatically within 48 hours of uninstall, with no action required from you.
        </p>
        <p>
          To request deletion sooner, or to ask any question about your data, email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#4B2E83' }}>{SUPPORT_EMAIL}</a>.
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

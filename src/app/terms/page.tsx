import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'

// TODO before submitting to the Shopify App Store: replace this placeholder
// with Craftify's real support address.
const SUPPORT_EMAIL = 'support@craftify.app'

export const metadata = { title: 'Terms of Service — Craftify' }

export default function TermsPage() {
  return (
    <LegalPageLayout title="Terms of Service" updatedAt="September 2026">
      <LegalSection heading="Using Craftify">
        <p>
          Craftify generates catalog creative images and a Meta product feed from your
          Shopify store&apos;s product data. By installing the app, you agree to use it only with
          product content you own or are licensed to use — including product photos, brand
          names, and logos supplied to templates.
        </p>
      </LegalSection>

      <LegalSection heading="Your responsibilities">
        <p>
          You&apos;re responsible for the accuracy of the product data Craftify pulls from your
          store and for how generated creatives and feed data are used in your own marketing
          and advertising.
        </p>
      </LegalSection>

      <LegalSection heading="Service availability">
        <p>
          Craftify depends on Shopify&apos;s API and third-party image-processing services. We
          aim for reliable uptime but don&apos;t guarantee uninterrupted service, and we&apos;re not
          liable for losses arising from downtime, delayed generation, or third-party service
          outages outside our control.
        </p>
      </LegalSection>

      <LegalSection heading="Limitation of liability">
        <p>
          Craftify is provided &quot;as is.&quot; To the extent permitted by law, we&apos;re not liable for
          indirect, incidental, or consequential damages arising from use of the app.
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          We may update these terms as the app evolves. Material changes will be reflected
          here with an updated date.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#4B2E83' }}>{SUPPORT_EMAIL}</a>.
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}

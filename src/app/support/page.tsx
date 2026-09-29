import Link from 'next/link'
import { LegalPageLayout, LegalSection } from '@/components/legal/legal-page-layout'

// TODO before submitting to the Shopify App Store: replace this placeholder
// with Craftify's real support address.
const SUPPORT_EMAIL = 'support@craftify.app'

export const metadata = { title: 'Support — Craftify' }

export default function SupportPage() {
  return (
    <LegalPageLayout title="Support" updatedAt="September 2026">
      <LegalSection heading="Get in touch">
        <p>
          For help with Craftify — installation, catalog sync, template setup, or anything
          else — email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#4B2E83', fontWeight: 600 }}>{SUPPORT_EMAIL}</a>.
        </p>
        <p>We aim to respond within 1–2 business days.</p>
      </LegalSection>

      <LegalSection heading="Data deletion requests">
        <p>
          Uninstalling the app from your Shopify admin starts the deletion process
          automatically — see our{' '}
          <Link href="/privacy" style={{ color: '#4B2E83' }}>Privacy Policy</Link> for details.
          To request deletion without uninstalling, or to ask about what data we hold, email
          us at the address above.
        </p>
      </LegalSection>

      <LegalSection heading="Policies">
        <p>
          <Link href="/privacy" style={{ color: '#4B2E83' }}>Privacy Policy</Link>
          {' · '}
          <Link href="/terms" style={{ color: '#4B2E83' }}>Terms of Service</Link>
        </p>
      </LegalSection>
    </LegalPageLayout>
  )
}

import Link from 'next/link'

/**
 * Shared chrome for the three public legal/support pages (/privacy, /terms,
 * /support). These are viewed outside the Shopify admin iframe — by
 * merchants directly, or by a Shopify reviewer — so this deliberately does
 * NOT use the dashboard's sidebar layout (that's behind auth and configured
 * for the embedded context).
 */
export function LegalPageLayout({
  title,
  updatedAt,
  children,
}: {
  title: string
  updatedAt: string
  children: React.ReactNode
}) {
  return (
    <div style={{ fontFamily: 'var(--font-sans-family)', color: '#241A3D', minHeight: '100vh', background: '#FBFAFD' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px 80px' }}>
        <Link href="/" style={{ fontSize: 13, fontWeight: 600, color: '#4B2E83', textDecoration: 'none' }}>
          ← Craftify
        </Link>
        <h1 style={{ fontFamily: 'var(--font-heading-family)', fontSize: 32, fontWeight: 600, color: '#241A3D', margin: '16px 0 4px' }}>
          {title}
        </h1>
        <p style={{ fontSize: 13, color: '#6B6280', margin: '0 0 32px' }}>
          Last updated {updatedAt}
        </p>
        <div style={{ fontSize: 15, lineHeight: 1.7, color: '#3A3050' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontFamily: 'var(--font-heading-family)', fontSize: 19, fontWeight: 600, color: '#241A3D', margin: '0 0 10px' }}>
        {heading}
      </h2>
      {children}
    </section>
  )
}

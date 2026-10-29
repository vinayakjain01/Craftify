import Link from 'next/link'

interface Step {
  key: string
  label: string
  done: boolean
  href: string
  cta: string
}

/**
 * "What do I do next" guide for the main dashboard. Steps are derived from
 * existing row counts (templates/rules/creatives) the page already queries —
 * no new tables, no stored progress. Renders nothing once every step is
 * done, so an established store doesn't carry this forever.
 */
export function OnboardingChecklist({ steps }: { steps: Step[] }) {
  if (steps.every(s => s.done)) return null

  const nextIndex = steps.findIndex(s => !s.done)
  const doneCount = steps.filter(s => s.done).length

  return (
    <div style={{
      background: '#FFFFFF', border: '1px solid #E7E2F0', borderRadius: 14,
      padding: '16px 18px', marginBottom: 18,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#241A3D' }}>Getting started</div>
      <div style={{ fontSize: 12, color: '#6B6280', marginTop: 2, marginBottom: 12 }}>
        {doneCount} of {steps.length} steps complete
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {steps.map((step, i) => {
          const isNext = i === nextIndex
          return (
            <div
              key={step.key}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
                borderTop: i > 0 ? '1px solid #F0EDF7' : 'none',
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: step.done ? '#1E9E7C' : '#EFEAF9',
                color: step.done ? '#fff' : '#4B2E83',
                fontSize: 11, fontWeight: 700,
              }}>
                {step.done ? '✓' : i + 1}
              </span>
              <span style={{
                flex: 1, fontSize: 13,
                fontWeight: isNext ? 600 : 500,
                color: step.done ? '#6B6280' : '#241A3D',
                textDecoration: step.done ? 'line-through' : 'none',
              }}>
                {step.label}
              </span>
              {!step.done && (
                <Link
                  href={step.href}
                  style={{
                    fontSize: 12, fontWeight: 600, textDecoration: 'none',
                    whiteSpace: 'nowrap', borderRadius: 8, padding: '5px 12px',
                    color: isNext ? '#fff' : '#4B2E83',
                    background: isNext ? '#4B2E83' : 'transparent',
                    border: isNext ? 'none' : '1px solid #4B2E83',
                  }}
                >
                  {step.cta}
                </Link>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

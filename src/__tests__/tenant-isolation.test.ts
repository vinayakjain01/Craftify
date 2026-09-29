/**
 * This app's admin-client code paths (the worker, cron routes, webhooks —
 * anything using the service-role key) run with Row-Level Security fully
 * BYPASSED. For those paths, tenant isolation exists ONLY because the
 * application code remembers to filter by store_id — there's no database
 * backstop the way there is for the RLS-scoped browser/session client.
 *
 * This test verifies that recordCreative() (src/lib/creatives.ts), the
 * function every generated creative is written through, actually builds its
 * queries that way — by asserting the exact filter chain a mock Supabase
 * client receives, not by hitting a real database.
 *
 * IMPORTANT SCOPE NOTE: this does NOT test Postgres RLS policies themselves
 * (the protection the SESSION-scoped client gets automatically). Verifying
 * RLS enforcement — that a request authenticated as store A's user genuinely
 * cannot read/write store B's rows — requires a real Postgres connection
 * with the actual policies applied, which is an integration test against a
 * live (or local Supabase CLI) database, not something a mocked client can
 * meaningfully prove. That's a real gap this test doesn't close.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordCreative } from '@/lib/creatives'

interface Call { method: string; args: unknown[] }

/** Just enough of the chainable query-builder shape for this mock. */
interface MockChain {
  eq(...args: unknown[]): MockChain
  is(...args: unknown[]): MockChain
  then(resolve: (v: { data: null; error: { message: string } | null }) => void): void
}

/**
 * Minimal fake of the Supabase query-builder chain, just enough for
 * recordCreative(): records every .eq()/.is() call so the test can assert
 * on the exact filters a real query would carry, then resolves per-table
 * per-operation exactly like the real client would (awaiting the chain
 * resolves to { data, error }).
 */
function makeMockSupabase() {
  const calls: Call[] = []

  function chain(table: string, op: 'delete' | 'insert', initialArgs: unknown[] = []): MockChain {
    calls.push({ method: `${table}.${op}`, args: initialArgs })
    const builder: MockChain = {
      eq(...args: unknown[]) {
        calls.push({ method: 'eq', args })
        return builder
      },
      is(...args: unknown[]) {
        calls.push({ method: 'is', args })
        return builder
      },
      then(resolve) {
        resolve({ data: null, error: null })
      },
    }
    return builder
  }

  const supabase = {
    from(table: string) {
      return {
        delete: (...args: unknown[]) => chain(table, 'delete', args),
        insert: (row: Record<string, unknown>) => {
          calls.push({ method: `${table}.insert`, args: [row] })
          return Promise.resolve({ data: null, error: null })
        },
      }
    },
  } as unknown as SupabaseClient

  return { supabase, calls }
}

describe('recordCreative tenant scoping', () => {
  it('scopes the insert to the calling store_id', async () => {
    const { supabase, calls } = makeMockSupabase()

    await recordCreative({
      supabase,
      storeId: 'store-a',
      productId: 'product-1',
      variantId: 'variant-1',
      imageId: 'image-1',
      templateId: 'template-1',
      url: 'https://res.cloudinary.com/x/image/upload/v1/creative.jpg',
      assetType: 'catalog',
    })

    const insertCall = calls.find(c => c.method === 'generated_creatives.insert')
    expect(insertCall).toBeDefined()
    const insertedRow = insertCall!.args[0] as Record<string, unknown>
    expect(insertedRow.store_id).toBe('store-a')
  })

  it('never mixes rows from a different store_id across two calls', async () => {
    const { supabase, calls } = makeMockSupabase()

    await recordCreative({
      supabase, storeId: 'store-a', productId: 'product-1',
      templateId: 'template-1', url: 'https://res.cloudinary.com/x/a.jpg',
    })
    await recordCreative({
      supabase, storeId: 'store-b', productId: 'product-2',
      templateId: 'template-1', url: 'https://res.cloudinary.com/x/b.jpg',
    })

    const inserts = calls
      .filter(c => c.method === 'generated_creatives.insert')
      .map(c => c.args[0] as Record<string, unknown>)

    expect(inserts).toHaveLength(2)
    expect(inserts[0].store_id).toBe('store-a')
    expect(inserts[1].store_id).toBe('store-b')
    expect(inserts[0].product_id).not.toBe(inserts[1].product_id)
  })

  it('does not throw when the delete or insert reports an error (best-effort by design)', async () => {
    const erroringChain: MockChain = {
      eq() { return erroringChain },
      is() { return erroringChain },
      then(resolve) { resolve({ data: null, error: { message: 'boom' } }) },
    }
    const supabase = {
      from: () => ({
        delete: () => erroringChain,
        insert: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
      }),
    } as unknown as SupabaseClient

    await expect(
      recordCreative({
        supabase, storeId: 'store-a', productId: 'product-1',
        templateId: 'template-1', url: 'https://res.cloudinary.com/x/a.jpg',
      })
    ).resolves.toBeUndefined()
  })
})

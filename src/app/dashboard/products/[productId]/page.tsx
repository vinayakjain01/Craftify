import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft } from 'lucide-react'
import { VariantDetail } from '@/components/products/variant-detail'

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ productId: string }>
}) {
  const [{ productId }, supabase, user] = await Promise.all([
    params,
    createClient(),
    getUser(), // React-cached — no extra Supabase auth round-trip
  ])

  const { data: product } = await supabase
    .from('products')
    .select(`
      id, title, vendor, product_type, tags, status, description,
      stores(id, user_id, shop_name, currency),
      product_variants(
        id, shopify_variant_id, title, sku, barcode, price, compare_at_price,
        inventory_quantity, is_sold_out, option1, option2, option3, position
      ),
      product_images(id, src, cloudinary_url, alt, position, is_primary, variant_ids),
      generated_creatives(id, url, variant_id, image_id, created_at, templates(name))
    `)
    .eq('id', productId)
    .single()

  if (!product || (product as any).stores?.user_id !== user!.id) notFound()

  const variants = [...((product as any).product_variants || [])]
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
  const images = [...((product as any).product_images || [])]
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
  const creatives = (product as any).generated_creatives || []

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/products">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">{product.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{variants.length} variant{variants.length === 1 ? '' : 's'}</span>
            {product.status !== 'active' && (
              <Badge variant="outline" className="py-0 text-xs capitalize">{product.status}</Badge>
            )}
            {product.vendor && <Badge variant="outline" className="py-0 text-xs">{product.vendor}</Badge>}
            {product.product_type && (
              <Badge variant="outline" className="py-0 text-xs">{product.product_type}</Badge>
            )}
          </div>
          {product.tags?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {product.tags.map((tag: string) => (
                <Badge key={tag} variant="secondary" className="py-0 text-xs">{tag}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      <VariantDetail
        productId={product.id}
        storeId={(product as any).stores.id}
        variants={variants}
        images={images}
        creatives={creatives}
        currency={(product as any).stores?.currency || 'USD'}
      />
    </div>
  )
}

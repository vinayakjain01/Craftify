/**
 * GET /api/cron/generate
 *
 * FALLBACK drain for the generation_jobs queue — the primary path is the
 * DigitalOcean worker (src/workers/catalog-worker.ts) consuming BullMQ jobs
 * in real time whenever REDIS_URL is configured (see isRedisEnabled() in
 * src/lib/redis.ts). This route exists to still clear the queue if a job
 * lands in the database without ever reaching BullMQ — the worker being down
 * when it was enqueued, REDIS_URL missing in some environment, etc.
 *
 * vercel.json currently schedules this once daily ("0 0 * * *"), NOT every
 * minute — a prior version of this comment claimed otherwise, which never
 * matched vercel.json and would have made a stray job sit for up to 24h
 * before this fallback picked it up. If tighter fallback coverage is wanted,
 * confirm the Vercel plan actually supports a more frequent cron (per-minute
 * schedules require Vercel Pro or higher — Hobby is capped at once per day)
 * before changing the schedule here.
 *
 * Auth:    CRON_SECRET bearer token (Authorization: Bearer <CRON_SECRET>), set by Vercel Cron
 * Returns: { ticks, claimed, completed, failed, ms }
 *
 * Flow: verify bearer token -> loop processBatch(10, 4) under a 50s budget -> stop early once a batch claims 0 jobs
 */

import { NextRequest, NextResponse } from 'next/server'
import { processBatch } from '@/lib/generation-queue'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  const BUDGET_MS = 50_000 // leave headroom under maxDuration
  let claimed = 0, completed = 0, failed = 0, ticks = 0

  while (Date.now() - started < BUDGET_MS) {
    const res = await processBatch(10, 4)
    claimed += res.claimed
    completed += res.completed
    failed += res.failed
    ticks++
    if (res.claimed === 0) break // queue empty
  }

  return NextResponse.json({ ticks, claimed, completed, failed, ms: Date.now() - started })
}
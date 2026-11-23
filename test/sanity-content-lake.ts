import {Readable} from 'stream'
import {SanityDocument} from '../src/types/sanity'

/**
 * Stand-in for the Sanity Content Lake HTTP API used by @sanity/client 3.4.1.
 *
 * The plugin sends GROQ through client.fetch without a perspective parameter
 * (node_modules/@sanity/client/lib/data/dataMethods.js `_dataRequest` and
 * encodeQueryString.js). apiVersion "1" is before 2025-02-19, so an
 * authenticated query defaults to the raw perspective and returns drafts and
 * published documents together. `published` models a production token that
 * cannot read drafts: the same GROQ is executed, then draft ids are removed.
 *
 * The export stream is the dataset the token can read, as NDJSON. The plugin
 * itself drops draft documents unless overlayDrafts is on.
 */
export type LakeVisibility = 'raw' | 'published'

export const sanityContentLake: {
  documents: SanityDocument[]
  visibility: LakeVisibility
  queries: string[]
} = {
  documents: [],
  visibility: 'raw',
  queries: [],
}

export function visibleDocuments(): SanityDocument[] {
  return sanityContentLake.documents.filter((doc) => {
    if (!doc || !doc._id || !doc._type) {
      return false
    }
    if (doc._id.startsWith('_.')) {
      return false
    }
    if (doc._type.startsWith('system.')) {
      return false
    }
    if (sanityContentLake.visibility === 'published' && doc._id.startsWith('drafts.')) {
      return false
    }
    return true
  })
}

export function executeLakeQuery(query: string, params: {[key: string]: any} = {}): any {
  sanityContentLake.queries.push(query)
  const docs = visibleDocuments()

  if (query.includes('_updatedAt > $timestamp')) {
    return docs.filter((doc) => doc._updatedAt > params.timestamp)
  }

  if (query.includes('._id')) {
    let rows = docs
    if (query.includes('_id > $prevId')) {
      rows = rows.filter((doc) => doc._id > params.prevId)
    }
    rows = [...rows].sort((left, right) => (left._id < right._id ? -1 : left._id > right._id ? 1 : 0))
    const batchSize = typeof params.batchSize === 'number' ? params.batchSize : rows.length
    return rows.slice(0, batchSize).map((doc) => doc._id)
  }

  if (query.includes('_id == $id')) {
    const found = docs.find((doc) => doc._id === params.id) || null
    return query.includes('[0]') ? found : found ? [found] : []
  }

  if (query.includes('_id in $ids')) {
    const ids = new Set<string>(params.ids || [])
    return docs.filter((doc) => ids.has(doc._id))
  }

  throw new Error(`Content lake double has no result for query: ${query}`)
}

export function documentById(id: string): SanityDocument | null {
  return visibleDocuments().find((doc) => doc._id === id) || null
}

export function exportNdjson(): Readable {
  const body = visibleDocuments().map((doc) => JSON.stringify(doc)).join('\n') + '\n'
  return Readable.from([body])
}

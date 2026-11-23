import http from 'http'
import {AddressInfo} from 'net'
import {Readable} from 'stream'
import axios from 'axios'
import sanityClient, {SanityClient} from '@sanity/client'
import {sourceNodes} from '../src/gatsby-node'
import {safeId, unprefixId} from '../src/util/documentIds'

// express is the parser Gatsby 5.8.1 mounts on the refresh route. This package
// does not ship @types/express; the test uses the runtime module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')

const runSourceNodes = sourceNodes as unknown as (
  args: Record<string, unknown>,
  pluginConfig: {projectId: string; dataset: string; overlayDrafts: boolean},
) => Promise<void>

/**
 * Spec for the preview webhook delete path.
 *
 * These tests fail while a non-empty webhook body can delete a Gatsby node that
 * Sanity still has, including when projectId and dataset are left out. They pass
 * once a delete is ignored unless it names this plugin's project and dataset and
 * the published document is actually gone from Sanity. A later incremental
 * sourceNodes run must not be required to resurrect a document that was removed
 * only from the Gatsby cache.
 */

const PROJECT_ID = 'testproj'
const DATASET = 'production'
const DOCUMENT_ID = 'post-1'
const ASSET_ID = `image-${'a'.repeat(32)}-100x100-png`
const UPDATED_AT = '2019-06-01T00:00:00.000Z'
const LAST_BUILD = '2020-01-01T00:00:00.000Z'

type SanityDoc = {
  _id: string
  _rev: string
  _type: string
  _createdAt: string
  _updatedAt: string
  title: string
}

const sanityDocuments = new Map<string, SanityDoc>()

function doc(id: string, type = 'post'): SanityDoc {
  return {
    _id: id,
    _rev: 'rev-1',
    _type: type,
    _createdAt: UPDATED_AT,
    _updatedAt: UPDATED_AT,
    title: id,
  }
}

function publishedDocuments(): SanityDoc[] {
  return Array.from(sanityDocuments.values())
    .filter(
      (document) => !document._id.startsWith('drafts.') && !document._type.startsWith('system.'),
    )
    .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
}

/**
 * Answers the GROQ queries this plugin already sends, plus the document lookups
 * a fix uses to confirm a delete. Unknown queries throw so an empty result cannot
 * be mistaken for "the document is gone".
 */
function answerQuery(query: string, params: Record<string, unknown> = {}): unknown {
  const normalized = query.replace(/\s+/g, ' ').trim()

  if (normalized.includes('_updatedAt > $timestamp')) {
    const timestamp = String(params.timestamp)
    return publishedDocuments().filter((document) => document._updatedAt > timestamp)
  }

  if (normalized.includes('_type match "system.**"') && normalized.endsWith('._id')) {
    const batchSize = Number(params.batchSize ?? 30000)
    const ids = publishedDocuments().map((document) => document._id)
    const prevId = params.prevId
    const filtered = typeof prevId === 'string' ? ids.filter((id) => id > prevId) : ids
    return filtered.slice(0, batchSize)
  }

  const paramMatch = normalized.match(/_id\s*==\s*\$([A-Za-z0-9_]+)/)
  const literalMatch = normalized.match(/_id\s*==\s*["']([^"']+)["']/)
  const id = paramMatch ? params[paramMatch[1]] : literalMatch ? literalMatch[1] : undefined
  if (typeof id === 'string' && /_id\s*==/.test(normalized)) {
    const found = sanityDocuments.get(id)
    if (normalized.startsWith('count(') || normalized.includes('count(')) {
      return found ? 1 : 0
    }
    if (normalized.includes('[0]')) {
      return found ?? null
    }
    return found ? [found] : []
  }

  throw new Error(`Unhandled Sanity query in webhook test double: ${query}`)
}

function answerRequest(options: {url?: string; uri?: string}): unknown {
  const url = options.url || options.uri || ''
  const docMatch = url.match(/\/data\/doc\/([^?]+)/)
  if (docMatch) {
    const ids = decodeURIComponent(docMatch[1]).split(',')
    const documents = ids.map((id) => sanityDocuments.get(id)).filter(Boolean)
    return {documents}
  }
  const queryMatch = url.match(/[?&]query=([^&]+)/)
  if (queryMatch) {
    const query = decodeURIComponent(queryMatch[1])
    return {result: answerQuery(query)}
  }
  throw new Error(`Unhandled Sanity request in webhook test double: ${url}`)
}

function installSanityDoubles(): () => void {
  const probe = sanityClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: '1',
    useCdn: false,
  })
  const proto = Object.getPrototypeOf(probe) as SanityClient
  const fetchSpy = jest
    .spyOn(proto, 'fetch')
    .mockImplementation(((query: string, params?: Record<string, unknown>) =>
      Promise.resolve(answerQuery(query, params))) as SanityClient['fetch'])
  const getDocumentSpy = jest
    .spyOn(proto, 'getDocument')
    .mockImplementation(((id: string) =>
      Promise.resolve(sanityDocuments.get(id))) as SanityClient['getDocument'])
  const getDocumentsSpy = jest
    .spyOn(proto, 'getDocuments')
    .mockImplementation(((ids: string[]) =>
      Promise.resolve(
        ids.map((id) => sanityDocuments.get(id) ?? null),
      )) as SanityClient['getDocuments'])
  const requestSpy = jest
    .spyOn(proto, 'request')
    .mockImplementation(((options: {url?: string; uri?: string}) =>
      Promise.resolve(answerRequest(options))) as SanityClient['request'])
  const axiosSpy = jest
    .spyOn(axios.Axios.prototype, 'request')
    .mockImplementation(async (config) => {
      const url = typeof config === 'string' ? config : config.url || ''
      if (!url.includes('/data/export/')) {
        throw new Error(`Unhandled axios request in webhook test double: ${url}`)
      }
      const body = Array.from(sanityDocuments.values())
        .map((document) => JSON.stringify(document))
        .join('\n')
      return {data: Readable.from([body]), status: 200, headers: {}}
    })

  return () => {
    fetchSpy.mockRestore()
    getDocumentSpy.mockRestore()
    getDocumentsSpy.mockRestore()
    requestSpy.mockRestore()
    axiosSpy.mockRestore()
  }
}

function gatsbyNodeId(documentId: string, createNodeId: (id: string) => string): string {
  return safeId(unprefixId(documentId), createNodeId)
}

type Harness = {
  nodeId: string
  nodes: Map<string, {id: string; _id: string}>
  pluginConfig: {projectId: string; dataset: string; overlayDrafts: boolean}
  args: (webhookBody: Record<string, unknown> | undefined) => any
}

function createHarness(options?: {overlayDrafts?: boolean; documentId?: string}): Harness {
  const documentId = options?.documentId ?? DOCUMENT_ID
  const createNodeId = (id: string) => id
  const nodeId = gatsbyNodeId(documentId, createNodeId)
  const nodes = new Map<string, any>()
  nodes.set(nodeId, {
    id: nodeId,
    _id: unprefixId(documentId),
    internal: {owner: 'gatsby-source-sanity', type: 'SanityPost', contentDigest: 'digest'},
    parent: null,
    children: [],
  })

  let pluginStatus: {lastBuildTime?: string} = {lastBuildTime: LAST_BUILD}
  const reporter = {
    info: jest.fn(),
    warn: jest.fn(),
    panic: jest.fn((message: unknown) => {
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
    }),
    setErrorMap: jest.fn(),
  }
  const actions = {
    createNode: jest.fn((node: {id: string}) => {
      nodes.set(node.id, node)
    }),
    deleteNode: jest.fn((node: {id: string}) => {
      nodes.delete(node.id)
    }),
    touchNode: jest.fn(),
    createParentChildLink: jest.fn(),
    setPluginStatus: jest.fn((status: {lastBuildTime?: string}) => {
      pluginStatus = status
    }),
  }

  return {
    nodeId,
    nodes,
    pluginConfig: {
      projectId: PROJECT_ID,
      dataset: DATASET,
      overlayDrafts: options?.overlayDrafts ?? true,
    },
    args(webhookBody) {
      return {
        webhookBody,
        reporter,
        actions,
        createNodeId,
        createContentDigest: () => 'digest',
        getNode: (id: string) => nodes.get(id),
        getNodesByType: () => Array.from(nodes.values()),
        getNodes: () => Array.from(nodes.values()),
        cache: {},
        emitter: {on: jest.fn(), off: jest.fn()},
        store: {
          getState: () => ({status: {plugins: {'gatsby-source-sanity': pluginStatus}}}),
        },
      }
    },
  }
}

async function postJson(
  app: any,
  path: string,
  body: unknown,
): Promise<{status: number; body: unknown}> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return {status: response.status, body: text ? JSON.parse(text) : null}
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

describe('preview webhook deletes', () => {
  let restore: () => void

  beforeEach(() => {
    sanityDocuments.clear()
    sanityDocuments.set(DOCUMENT_ID, doc(DOCUMENT_ID))
    sanityDocuments.set(ASSET_ID, doc(ASSET_ID, 'sanity.imageAsset'))
    restore = installSanityDoubles()
  })

  afterEach(() => {
    restore()
  })

  async function expectDocumentRemains(
    webhookBody: Record<string, unknown>,
    overlayDrafts = true,
    documentId = DOCUMENT_ID,
  ) {
    const harness = createHarness({overlayDrafts, documentId})
    await runSourceNodes(harness.args(webhookBody), harness.pluginConfig)
    const presentAfterWebhook = harness.nodes.has(harness.nodeId)

    await runSourceNodes(harness.args({}), harness.pluginConfig)
    const presentAfterIncrementalBuild = harness.nodes.has(harness.nodeId)

    expect({presentAfterWebhook, presentAfterIncrementalBuild}).toEqual({
      presentAfterWebhook: true,
      presentAfterIncrementalBuild: true,
    })
  }

  test('a JSON delete body without projectId or dataset does not drop a document Sanity still has', async () => {
    const app = express()
    let parsed: Record<string, unknown> | undefined
    // Same parser Gatsby mounts on POST /__refresh before it copies req.body to webhookBody.
    app.post('/__refresh/gatsby-source-sanity', express.json(), (req: any, res: any) => {
      parsed = req.body
      res.status(200).json({ok: true})
    })

    const response = await postJson(app, '/__refresh/gatsby-source-sanity', {
      operation: 'delete',
      documentId: DOCUMENT_ID,
    })

    expect(response.status).toBe(200)
    expect(parsed).toEqual({operation: 'delete', documentId: DOCUMENT_ID})
    await expectDocumentRemains(parsed as Record<string, unknown>)
  })

  test('a delete body with only projectId does not drop a document Sanity still has', async () => {
    await expectDocumentRemains({
      operation: 'delete',
      documentId: DOCUMENT_ID,
      projectId: PROJECT_ID,
    })
  })

  test('a delete body with only dataset does not drop a document Sanity still has', async () => {
    await expectDocumentRemains({
      operation: 'delete',
      documentId: DOCUMENT_ID,
      dataset: DATASET,
    })
  })

  test('a delete body whose project and dataset match does not drop a document Sanity still has', async () => {
    await expectDocumentRemains({
      operation: 'delete',
      documentId: DOCUMENT_ID,
      projectId: PROJECT_ID,
      dataset: DATASET,
    })
  })

  test('a delete body for another project does not drop the document', async () => {
    await expectDocumentRemains({
      operation: 'delete',
      documentId: DOCUMENT_ID,
      projectId: 'otherproj',
      dataset: 'other',
    })
  })

  test('a delete body for this project and another dataset does not drop the document', async () => {
    await expectDocumentRemains({
      operation: 'delete',
      documentId: DOCUMENT_ID,
      projectId: PROJECT_ID,
      dataset: 'other',
    })
  })

  test('a delete of a draft id does not drop the published document while that document still exists', async () => {
    await expectDocumentRemains(
      {
        operation: 'delete',
        documentId: `drafts.${DOCUMENT_ID}`,
      },
      false,
    )
  })

  test('a delete body naming an image asset does not drop that asset while Sanity still has it', async () => {
    await expectDocumentRemains(
      {
        operation: 'delete',
        documentId: ASSET_ID,
      },
      true,
      ASSET_ID,
    )
  })

  test('a matching delete removes the node once Sanity no longer has the published document', async () => {
    sanityDocuments.delete(DOCUMENT_ID)
    const harness = createHarness()

    await runSourceNodes(
      harness.args({
        operation: 'delete',
        documentId: DOCUMENT_ID,
        projectId: PROJECT_ID,
        dataset: DATASET,
      }),
      harness.pluginConfig,
    )
    expect(harness.nodes.has(harness.nodeId)).toBe(false)

    await runSourceNodes(harness.args({}), harness.pluginConfig)
    expect(harness.nodes.has(harness.nodeId)).toBe(false)
  })

  test('create and update bodies do not delete a document', async () => {
    const harness = createHarness()
    await runSourceNodes(
      harness.args({operation: 'create', documentId: DOCUMENT_ID}),
      harness.pluginConfig,
    )
    await runSourceNodes(
      harness.args({operation: 'update', documentId: DOCUMENT_ID}),
      harness.pluginConfig,
    )
    expect(harness.nodes.has(harness.nodeId)).toBe(true)
  })
})

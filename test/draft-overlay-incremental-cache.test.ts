const fs = require('fs')
const os = require('os')
const path = require('path')

const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatsby-source-sanity-draft-cache-'))
const originalCwd = process.cwd()
process.chdir(cacheRoot)

jest.mock('@sanity/client', () => {
  const lake = require('./sanity-content-lake')
  return function SanityClient(config: {projectId: string; dataset: string; token?: string}) {
    const resolved = {
      projectId: config.projectId,
      dataset: config.dataset,
      token: config.token,
      apiHost: 'https://api.sanity.io',
    }
    return {
      config: () => resolved,
      getUrl: (urlPath: string) =>
        `https://${resolved.projectId}.api.sanity.io/v1${urlPath || `/data/export/${resolved.dataset}`}`,
      fetch: (query: string, params?: {[key: string]: any}) =>
        Promise.resolve(lake.executeLakeQuery(query, params)),
      getDocument: (id: string) => Promise.resolve(lake.documentById(id)),
      getDocuments: (ids: string[]) => Promise.resolve(ids.map((id: string) => lake.documentById(id))),
      request: (options: {url?: string}) => {
        if (!options.url || !options.url.includes('/apis/graphql/')) {
          return Promise.reject(new Error(`Unexpected Sanity request ${options.url}`))
        }
        return Promise.resolve(SCHEMA_SDL)
      },
      listen: () => {
        throw new Error('listen() is outside this production-build reproduction')
      },
    }
  }
})

jest.mock('axios', () => {
  const lake = require('./sanity-content-lake')
  const axios = (options: {url?: string}) => {
    if (!options.url || !options.url.includes('/data/export/')) {
      return Promise.reject(new Error(`Unexpected export URL ${options.url}`))
    }
    return Promise.resolve({data: lake.exportNdjson()})
  }
  return axios
})

const {sanityContentLake} = require('./sanity-content-lake') as typeof import('./sanity-content-lake')
const gatsbyNode = require('../src/gatsby-node')
const {store} = require('gatsby/dist/redux')
const {actions} = require('gatsby/dist/redux/actions')
const {getDataStore} = require('gatsby/dist/datastore')
const {createNodeId} = require('gatsby/dist/utils/create-node-id')
const {createContentDigest} = require('gatsby-core-utils')
const {defaultFieldResolver} = require('gatsby/dist/schema/resolvers')

const SCHEMA_SDL = `
interface Document {
  _id: ID
  _type: String
  _createdAt: String
  _updatedAt: String
}

type Post implements Document {
  _id: ID
  _type: String
  _createdAt: String
  _updatedAt: String
  title: String
  body: String
}

type Article implements Document {
  _id: ID
  _type: String
  _createdAt: String
  _updatedAt: String
  title: String
  body: String
}
`

const PUBLISHED_AT = '2020-01-01T00:00:00.000Z'
const DRAFT_AT = '2020-06-01T00:00:00.000Z'
const PUBLISHED_BODY = 'PUBLISHED_BODY'
const DRAFT_BODY = 'UNPUBLISHED_DRAFT_BODY'
const DRAFT_ONLY_BODY = 'DRAFT_ONLY_BODY'
const STABLE_BODY = 'STABLE_BODY'
const NEWER_DRAFT_BODY = 'NEWER_UNPUBLISHED_DRAFT'
const UPDATED_PUBLISHED_BODY = 'UPDATED_PUBLISHED_BODY'

const PLUGIN = {name: 'gatsby-source-sanity', version: '7.6.3'}

function fixtureDocuments() {
  return [
    {
      _id: 'post-1',
      _type: 'post',
      _rev: 'pub',
      _createdAt: PUBLISHED_AT,
      _updatedAt: PUBLISHED_AT,
      title: 'Published title',
      body: PUBLISHED_BODY,
    },
    {
      _id: 'drafts.post-1',
      _type: 'post',
      _rev: 'draft',
      _createdAt: PUBLISHED_AT,
      _updatedAt: DRAFT_AT,
      title: 'Draft title',
      body: DRAFT_BODY,
    },
    {
      _id: 'drafts.article-1',
      _type: 'article',
      _rev: 'draft-only',
      _createdAt: DRAFT_AT,
      _updatedAt: DRAFT_AT,
      title: 'Secret article',
      body: DRAFT_ONLY_BODY,
    },
    {
      _id: 'stable-post',
      _type: 'post',
      _rev: 'stable',
      _createdAt: PUBLISHED_AT,
      _updatedAt: PUBLISHED_AT,
      title: 'Stable title',
      body: STABLE_BODY,
    },
  ]
}

function reporter() {
  return {
    info: () => undefined,
    warn: () => undefined,
    panic: (error: unknown) => {
      throw new Error(typeof error === 'string' ? error : JSON.stringify(error))
    },
    setErrorMap: () => undefined,
  }
}

function boundActions() {
  const {bindActionCreators} = require('redux')
  const bound = bindActionCreators(actions, store.dispatch)
  const wrapped: {[key: string]: (...args: any[]) => any} = {}
  for (const key of Object.keys(bound)) {
    if (typeof bound[key] !== 'function') {
      continue
    }
    wrapped[key] = (...callArgs: any[]) => {
      if (callArgs.length === 1) {
        return bound[key](callArgs[0], PLUGIN, {})
      }
      if (callArgs.length === 2) {
        return bound[key](callArgs[0], callArgs[1], {})
      }
      return undefined
    }
  }
  return wrapped
}

function sourceArgs(webhookBody?: {[key: string]: unknown}) {
  const dataStore = getDataStore()
  return {
    actions: boundActions(),
    store,
    reporter: reporter(),
    createNodeId: (id: string) => createNodeId(id, PLUGIN.name),
    createContentDigest,
    getNode: (id: string) => dataStore.getNode(id),
    getNodes: () => dataStore.getNodes(),
    getNodesByType: (type: string) => dataStore.getNodesByType(type),
    emitter: {
      on: () => undefined,
    },
    webhookBody: webhookBody || {},
    schema: {},
    cache: {},
    getCache: () => ({}),
    tracing: {startSpan: () => ({})},
    parentSpan: {},
  }
}

function pluginOptions(overlayDrafts: boolean) {
  return {
    projectId: 'testproj',
    dataset: 'testdata',
    token: 'test-token',
    graphqlTag: 'default',
    overlayDrafts,
    watchMode: false,
    plugins: [],
  }
}

function listSanityNodes(): any[] {
  return Array.from(getDataStore().iterateNodes()).filter(
    (node: any) => node && node.internal && node.internal.owner === PLUGIN.name,
  )
}

function pageField(node: any, fieldName: string) {
  return defaultFieldResolver(node, {}, {}, {fieldName})
}

function bodies(nodes: any[]): string[] {
  return nodes.map((node) => pageField(node, 'body'))
}

function expectPublishedPage(nodes: any[], present: string[], absent: string[]) {
  const pageBodies = bodies(nodes)
  const sanityIds = nodes.map((node) => pageField(node, '_id'))
  const missing = present.filter((body) => !pageBodies.includes(body))
  const leaked = absent.filter((body) => pageBodies.includes(body))
  const draftIds = sanityIds.filter((id) => typeof id === 'string' && id.startsWith('drafts.'))
  if (missing.length || leaked.length || draftIds.length) {
    throw new Error(
      `Production page fields were ${JSON.stringify(pageBodies)} with Sanity ids ${JSON.stringify(
        sanityIds,
      )}. Missing ${JSON.stringify(missing)}. Leaked ${JSON.stringify(
        leaked,
      )}. Draft ids still stored: ${JSON.stringify(draftIds)}.`,
    )
  }
}

/**
 * Gatsby 5.8.1 deletes nodes whose root was neither created nor touched in
 * this process. Copied from gatsby/dist/utils/source-nodes.js getStaleNodes
 * and deleteStaleNodes. TOUCH_NODE only records the id; it does not rewrite
 * the node stored in LMDB.
 */
function deleteStaleNodes() {
  const state = store.getState()
  const nodes = listSanityNodes()
  const stale = nodes.filter((node) => {
    let rootNode = node
    let next: any
    let whileCount = 0
    do {
      next = rootNode.parent ? getDataStore().getNode(rootNode.parent) : undefined
      if (next) {
        rootNode = next
      }
    } while (next && ++whileCount < 101)
    return !state.nodesTouched.has(rootNode.id)
  })
  stale.forEach((node) => store.dispatch(actions.deleteNode(node)))
}

async function resetCache() {
  getDataStore()
  store.dispatch({type: 'DELETE_CACHE'})
  store.getState().nodesTouched.clear()
  sanityContentLake.documents = []
  sanityContentLake.queries = []
  sanityContentLake.visibility = 'raw'
  await getDataStore().ready()
}

async function bootstrapSchema() {
  if (typeof gatsbyNode.onPluginInit !== 'function') {
    throw new Error('onPluginInit was not exported; schema type map cannot be built')
  }
  await gatsbyNode.onPluginInit(sourceArgs(), pluginOptions(false))
}

async function source(overlayDrafts: boolean) {
  await gatsbyNode.sourceNodes(sourceArgs(), pluginOptions(overlayDrafts))
  await getDataStore().ready()
}

async function previewThenProduction(options: {
  productionVisibility: 'raw' | 'published'
  beforeProduction?: () => void
}) {
  await resetCache()
  sanityContentLake.documents = fixtureDocuments()
  sanityContentLake.visibility = 'raw'
  await bootstrapSchema()
  await source(true)

  const previewBodies = bodies(listSanityNodes())
  expect(previewBodies).toContain(DRAFT_BODY)
  expect(previewBodies).toContain(DRAFT_ONLY_BODY)
  expect(previewBodies).not.toContain(PUBLISHED_BODY)

  // A later production process starts with an empty touched set. The LMDB
  // node records and the plugin status (lastBuildTime) are the warm cache.
  store.getState().nodesTouched.clear()
  sanityContentLake.visibility = options.productionVisibility
  sanityContentLake.queries = []
  if (options.beforeProduction) {
    options.beforeProduction()
  }
  await source(false)
  deleteStaleNodes()
  await getDataStore().ready()
  return listSanityNodes()
}

beforeAll(() => {
  process.env.GATSBY_TELEMETRY_DISABLED = '1'
})

afterAll(() => {
  const openRoots = (global as any).__GATSBY_OPEN_ROOT_LMDBS
  if (openRoots) {
    for (const root of openRoots.values()) {
      root.close()
    }
    openRoots.clear()
  }
  process.chdir(originalCwd)
})

test('production incremental build sources the published document when a cached node was built from a draft id', async () => {
  const nodes = await previewThenProduction({productionVisibility: 'raw'})
  expectPublishedPage(nodes, [PUBLISHED_BODY, STABLE_BODY], [DRAFT_BODY, DRAFT_ONLY_BODY])
}, 20000)

test('production incremental build sources the published document when the id list contains only the published id', async () => {
  const nodes = await previewThenProduction({productionVisibility: 'published'})
  expectPublishedPage(nodes, [PUBLISHED_BODY, STABLE_BODY], [DRAFT_BODY, DRAFT_ONLY_BODY])
}, 20000)

test('a draft saved after the preview build does not replace the published document on the next production build', async () => {
  const nodes = await previewThenProduction({
    productionVisibility: 'raw',
    beforeProduction: () => {
      const draft = sanityContentLake.documents.find((doc) => doc._id === 'drafts.post-1')
      if (!draft) {
        throw new Error('missing draft')
      }
      draft._updatedAt = '2099-01-01T00:00:00.000Z'
      draft.body = NEWER_DRAFT_BODY
      draft.title = 'Newer draft title'
    },
  })
  expectPublishedPage(
    nodes,
    [PUBLISHED_BODY, STABLE_BODY],
    [DRAFT_BODY, NEWER_DRAFT_BODY, DRAFT_ONLY_BODY],
  )
}, 20000)

test('a published update replaces the cached draft, and a draft-only document is dropped', async () => {
  const nodes = await previewThenProduction({
    productionVisibility: 'raw',
    beforeProduction: () => {
      const published = sanityContentLake.documents.find((doc) => doc._id === 'post-1')
      if (!published) {
        throw new Error('missing published document')
      }
      published._updatedAt = '2099-01-01T00:00:00.000Z'
      published.body = UPDATED_PUBLISHED_BODY
      published.title = 'Updated published title'
    },
  })
  expectPublishedPage(
    nodes,
    [UPDATED_PUBLISHED_BODY, STABLE_BODY],
    [PUBLISHED_BODY, DRAFT_BODY, DRAFT_ONLY_BODY],
  )
}, 20000)

test('an incremental production build keeps an unchanged published node that was never overlaid with a draft', async () => {
  await resetCache()
  sanityContentLake.documents = fixtureDocuments()
  sanityContentLake.visibility = 'raw'
  await bootstrapSchema()
  await source(false)

  store.getState().nodesTouched.clear()
  sanityContentLake.queries = []
  await source(false)
  deleteStaleNodes()
  await getDataStore().ready()

  expectPublishedPage(listSanityNodes(), [PUBLISHED_BODY, STABLE_BODY], [DRAFT_BODY, DRAFT_ONLY_BODY])
}, 20000)

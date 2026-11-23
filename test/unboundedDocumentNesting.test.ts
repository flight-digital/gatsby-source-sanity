/**
 * Nesting cap for Sanity documents.
 *
 * A document is one level deeper for every nested plain object or array on its
 * deepest path, counting the document itself. `{_id, body: {end: true}}` has
 * depth 2. `{_id, body: [{end: true}]}` has depth 3.
 *
 * Import must keep documents at depth 100 and skip deeper ones, including when
 * the over-deep document is already parsed (delta and watch updates). One
 * document must not throw, and must not be turned into a node.
 *
 * resolveReferences must honor maxDepth for plain objects the same way it
 * already does for arrays: a reference at the max depth is resolved, a
 * reference past it is left untouched, and children of objects past the limit
 * are not read.
 *
 * Run: npx jest test/unboundedDocumentNesting.test.ts --runInBand
 */
import http from 'http'
import {SanityDocument} from '../src/types/sanity'
import downloadDocuments from '../src/util/downloadDocuments'
import getSyncWithGatsby from '../src/util/getSyncWithGatsby'
import {getGraphQLResolverMap} from '../src/util/getGraphQLResolverMap'
import {resolveReferences} from '../src/util/resolveReferences'

const MAX_OBJECT_DEPTH = 100
const OVER_DEEP = 8000

const typeMap = {
  scalars: ['String', 'JSON'],
  unions: {},
  objects: {
    SanityPost: {
      name: 'SanityPost',
      kind: 'Object' as const,
      isDocument: true,
      fields: {
        _rawBody: {
          aliasFor: 'body',
          isList: false,
          isReference: false,
          namedType: {kind: 'NamedType', name: {kind: 'Name', value: 'JSON'}},
          type: {kind: 'NamedType', name: {kind: 'Name', value: 'JSON'}},
        },
      },
    },
  },
}

const pluginConfig = {
  plugins: [] as [],
  projectId: 'proj',
  dataset: 'production',
  graphqlTag: 'default',
  overlayDrafts: false,
}

function nestingDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    return 0
  }
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  let maxChild = 0
  for (const child of children) {
    const depth = nestingDepth(child)
    if (depth > maxChild) {
      maxChild = depth
    }
  }
  return 1 + maxChild
}

function baseDocument(id: string): SanityDocument {
  return {
    _id: id,
    _type: 'post',
    _rev: '1',
    _createdAt: '2020-01-01T00:00:00.000Z',
    _updatedAt: '2020-01-01T00:00:00.000Z',
    title: id,
    author: {_ref: 'author-1'},
  }
}

/** `depth` includes the document root. See the file comment for examples. */
function documentAtDepth(id: string, depth: number, mode: 'object' | 'array'): SanityDocument {
  let body: unknown = {end: true}
  for (let i = 0; i < depth - 2; i++) {
    body = mode === 'array' ? [body] : {child: body}
  }
  return {...baseDocument(id), body}
}

function documentJson(id: string, depth: number, mode: 'object' | 'array'): string {
  let body = '{"end":true}'
  for (let i = 0; i < depth - 2; i++) {
    body = mode === 'array' ? `[${body}]` : `{"child":${body}}`
  }
  const meta = JSON.stringify(baseDocument(id))
  return `${meta.slice(0, -1)},"body":${body}}`
}

function makeHarness(documents: Map<string, SanityDocument>) {
  const created: Array<{_id: string; author?: {_ref?: string}; internal?: {type?: string}}> = []
  const manifests: string[] = []
  const gatsbyNodes = new Map<string, unknown>()
  const stored = new Map<string, unknown>()
  const actions = {
    createNode(node: {_id: string; id: string}) {
      created.push(node)
      stored.set(node.id, node)
    },
    deleteNode() {
      return undefined
    },
    createParentChildLink() {
      return undefined
    },
    unstable_createNodeManifest({manifestId}: {manifestId: string}) {
      manifests.push(manifestId)
    },
  }
  const processingOptions = {
    typeMap,
    createNodeId: (id: string) => id,
    createNode: actions.createNode,
    createContentDigest: (value: string) => value,
    createParentChildLink: actions.createParentChildLink,
    overlayDrafts: false,
    client: {
      config() {
        return {projectId: 'proj', dataset: 'production', apiHost: 'https://api.sanity.io'}
      },
    },
  }
  const sync = getSyncWithGatsby({
    documents,
    gatsbyNodes: gatsbyNodes as any,
    typeMap: typeMap as any,
    processingOptions: processingOptions as any,
    args: {
      reporter: {warn() {}, info() {}, panic() {}, error() {}},
      actions,
      getNode: (id: string) => stored.get(id),
    } as any,
  })
  return {sync, created, gatsbyNodes, manifests}
}

function assertOnlyImported(
  created: Array<{_id: string; author?: {_ref?: string}; internal?: {type?: string}}>,
  gatsbyNodes: Map<string, unknown>,
  manifests: string[],
  kept: Array<{id: string; depth: number}>,
  skipped: string[],
) {
  expect(created.map((node) => node._id).sort()).toEqual(kept.map((item) => item.id).sort())
  for (const item of kept) {
    expect(gatsbyNodes.has(item.id)).toBe(true)
    const node = created.find((createdNode) => createdNode._id === item.id)
    expect(node?.internal?.type).toBe('SanityPost')
    expect(node?.author?._ref).toBe('-author-1')
    expect(nestingDepth(node)).toBe(item.depth)
  }
  for (const id of skipped) {
    expect(gatsbyNodes.has(id)).toBe(false)
    expect(created.some((node) => node._id === id)).toBe(false)
    expect(manifests.some((manifestId) => manifestId.startsWith(`${id}-`))).toBe(false)
  }
}

async function serveNdjson(body: string): Promise<{url: string; close: () => Promise<void>}> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/x-ndjson')
    res.end(body)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind a port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/data/export/production`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function referenceContext() {
  const nearNode = {
    _id: 'near-id',
    id: '-near-id',
    title: 'Near',
    parent: 'someParent',
    internal: {owner: 'owner', type: 'SanityPost', contentDigest: 'digest'},
    children: [],
  }
  return {
    createNodeId: (id: string) => id,
    getNode: (id: string) => {
      if (id === '-near-id') {
        return nearNode
      }
      throw new Error(`unexpected getNode ${id}`)
    },
  }
}

function nestedRawValue(chainLength: number) {
  const visits = {n: 0}
  let buried: unknown = {end: true}
  for (let i = 1; i < chainLength; i++) {
    buried = {child: buried}
  }
  const trap: {child?: unknown} = {}
  Object.defineProperty(trap, 'child', {
    enumerable: true,
    configurable: true,
    get() {
      visits.n += 1
      return buried
    },
  })
  const input = {
    near: {wrap: {_ref: 'near-id'}},
    list: [{nested: [{_ref: 'should-stay'}]}],
    a: {b: {c: trap}},
  }
  return {input, visits, trap}
}

function assertReferencesStayBounded(result: any, visits: {n: number}, trap: {child?: unknown}) {
  expect(result.near.wrap).toMatchObject({_id: 'near-id', title: 'Near'})
  expect(result.list).toEqual([{nested: [{_ref: 'should-stay'}]}])
  expect(visits.n).toBe(0)
  expect(result.a.b.c).toBe(trap)
}

function resolveRawBody(value: unknown) {
  const resolvers = getGraphQLResolverMap(
    typeMap as any,
    pluginConfig as any,
    referenceContext() as any,
  )
  const resolve = resolvers.SanityPost._rawBody.resolve
  return resolve({_rawDataBody: value}, {resolveReferences: {maxDepth: 2}}, {} as any, {} as any)
}

describe('document nesting cap', () => {
  test('depth counter matches the documented examples', () => {
    expect(nestingDepth(documentAtDepth('d2', 2, 'object'))).toBe(2)
    expect(nestingDepth(documentAtDepth('d3', 3, 'object'))).toBe(3)
    expect(nestingDepth(documentAtDepth('d3a', 3, 'array'))).toBe(3)
    expect(nestingDepth(documentAtDepth('obj100', MAX_OBJECT_DEPTH, 'object'))).toBe(
      MAX_OBJECT_DEPTH,
    )
    expect(nestingDepth(documentAtDepth('obj101', MAX_OBJECT_DEPTH + 1, 'object'))).toBe(
      MAX_OBJECT_DEPTH + 1,
    )
    expect(nestingDepth(JSON.parse(documentJson('obj100', MAX_OBJECT_DEPTH, 'object')))).toBe(
      MAX_OBJECT_DEPTH,
    )
    expect(JSON.parse(documentJson('arr101', MAX_OBJECT_DEPTH + 1, 'array'))).toEqual(
      documentAtDepth('arr101', MAX_OBJECT_DEPTH + 1, 'array'),
    )
  })

  test('a document at the cap is imported with its references rewritten', () => {
    const documents = new Map<string, SanityDocument>()
    const {sync, created, gatsbyNodes} = makeHarness(documents)
    for (const doc of [
      documentAtDepth('ok', 2, 'object'),
      documentAtDepth('obj100', MAX_OBJECT_DEPTH, 'object'),
      documentAtDepth('arr100', MAX_OBJECT_DEPTH, 'array'),
    ]) {
      sync(doc._id, doc)
    }
    assertOnlyImported(
      created,
      gatsbyNodes,
      [],
      [
        {id: 'ok', depth: 2},
        {id: 'obj100', depth: MAX_OBJECT_DEPTH},
        {id: 'arr100', depth: MAX_OBJECT_DEPTH},
      ],
      [],
    )
  })

  test('an export stream skips documents nested deeper than the cap and still imports the rest', async () => {
    const specs: Array<[string, number, 'object' | 'array']> = [
      ['ok', 2, 'object'],
      ['obj100', MAX_OBJECT_DEPTH, 'object'],
      ['arr100', MAX_OBJECT_DEPTH, 'array'],
      ['obj101', MAX_OBJECT_DEPTH + 1, 'object'],
      ['arr101', MAX_OBJECT_DEPTH + 1, 'array'],
      ['obj8000', OVER_DEEP, 'object'],
      ['arr8000', OVER_DEEP, 'array'],
    ]
    const body = specs.map(([id, depth, mode]) => documentJson(id, depth, mode)).join('\n') + '\n'
    const server = await serveNdjson(body)
    try {
      const documents = await downloadDocuments(server.url)
      // Documents at the cap are part of the dataset. Deeper documents may be
      // dropped while parsing or kept and skipped while creating nodes.
      for (const id of ['ok', 'obj100', 'arr100']) {
        expect(documents.has(id)).toBe(true)
        expect(nestingDepth(documents.get(id))).toBe(id === 'ok' ? 2 : MAX_OBJECT_DEPTH)
      }
      const {sync, created, gatsbyNodes, manifests} = makeHarness(documents)
      let thrown: unknown
      try {
        for (const id of documents.keys()) {
          sync(id)
        }
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeUndefined()
      assertOnlyImported(
        created,
        gatsbyNodes,
        manifests,
        [
          {id: 'ok', depth: 2},
          {id: 'obj100', depth: MAX_OBJECT_DEPTH},
          {id: 'arr100', depth: MAX_OBJECT_DEPTH},
        ],
        ['obj101', 'arr101', 'obj8000', 'arr8000'],
      )
    } finally {
      await server.close()
    }
  })

  test('a delta or watch update with an over-deep document does not fail later syncs', () => {
    const documents = new Map<string, SanityDocument>()
    const {sync, created, gatsbyNodes, manifests} = makeHarness(documents)
    const updates = [
      documentAtDepth('obj8000', OVER_DEEP, 'object'),
      documentAtDepth('arr8000', OVER_DEEP, 'array'),
      documentAtDepth('obj101', MAX_OBJECT_DEPTH + 1, 'object'),
      documentAtDepth('arr101', MAX_OBJECT_DEPTH + 1, 'array'),
      documentAtDepth('ok', 2, 'object'),
      documentAtDepth('obj100', MAX_OBJECT_DEPTH, 'object'),
    ]
    let thrown: unknown
    try {
      for (const doc of updates) {
        sync(doc._id, doc)
      }
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeUndefined()
    assertOnlyImported(
      created,
      gatsbyNodes,
      manifests,
      [
        {id: 'ok', depth: 2},
        {id: 'obj100', depth: MAX_OBJECT_DEPTH},
      ],
      ['obj101', 'arr101', 'obj8000', 'arr8000'],
    )
  })

  test('resolveReferences does not read plain objects past maxDepth', () => {
    const {input, visits, trap} = nestedRawValue(30)
    const result = resolveReferences(input, referenceContext(), {maxDepth: 2, overlayDrafts: false})
    assertReferencesStayBounded(result, visits, trap)
  })

  test('resolveReferences does not overflow on a deeply nested plain object', () => {
    const {input, visits, trap} = nestedRawValue(OVER_DEEP)
    const result = resolveReferences(input, referenceContext(), {maxDepth: 2, overlayDrafts: false})
    assertReferencesStayBounded(result, visits, trap)
  })

  test('raw GraphQL resolvers do not read plain objects past maxDepth', () => {
    const {input, visits, trap} = nestedRawValue(30)
    const result = resolveRawBody(input)
    assertReferencesStayBounded(result, visits, trap)
  })

  test('raw GraphQL resolvers do not overflow on a deeply nested plain object', () => {
    const {input, visits, trap} = nestedRawValue(OVER_DEEP)
    const result = resolveRawBody(input)
    assertReferencesStayBounded(result, visits, trap)
  })
})
